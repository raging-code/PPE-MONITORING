"""main.py (P24-1): start-up steps 1 to 5 of design 14.5 and the start-up failure policy (a to d). Steps 6 onward (session, threads, Uvicorn, 1 Hz tick) are P24-2 and later.
Exit codes: 0 = clean exit or another host already runs (the supervisor does not respawn), 1 = unexpected crash, 2 = configuration or database failure (counts toward the crash-loop guard).
Run: python -m ppe_host.main [--mode LIVE|SIMULATOR|REPLAY] [--home PPE_HOME]"""
import argparse, json, logging, os, shutil, stat, sys, time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from .settings import SettingsError, load_settings
from .io.backup import backup_before_migration, verify_backup
from .io.db_writer import DatabaseTooNewError, applied_versions, connect_db, init_event_seq, run_migrations
from .cli import MIGRATIONS_DIR, seed_roster

LOG = logging.getLogger('ppe_host')
EXIT_OK, EXIT_CRASH, EXIT_CONFIG = 0, 1, 2
MODES = ('LIVE', 'SIMULATOR', 'REPLAY')
LOCK_NAME = 'ppe_host.lock'                      # in PPE_HOME; one file for all three modes (Rev 3.41)

class StartupExit(Exception):
    def __init__(self, code, message): super().__init__(message); self.code = code; self.message = message

def process_start(pid):
    """An opaque start-time token of the process with this PID, or None when no such process is running. Windows: GetProcessTimes; elsewhere: /proc (development and CI)."""
    if sys.platform == 'win32':
        import ctypes; from ctypes import wintypes
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.OpenProcess.restype = wintypes.HANDLE; k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.CloseHandle.argtypes = [wintypes.HANDLE]; k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        h = k.OpenProcess(0x1000, False, pid)    # PROCESS_QUERY_LIMITED_INFORMATION
        if not h: return None
        try:
            code = wintypes.DWORD()
            if not k.GetExitCodeProcess(h, ctypes.byref(code)) or code.value != 259: return None      # 259 = STILL_ACTIVE
            t = [wintypes.FILETIME() for _ in range(4)]
            if not k.GetProcessTimes(h, *[ctypes.byref(x) for x in t]): return None
            return (t[0].dwHighDateTime << 32) | t[0].dwLowDateTime
        finally: k.CloseHandle(h)
    try: return int(Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()[19])
    except (OSError, IndexError, ValueError): return None

class Lockfile:
    """The PID lockfile (14.5 policy a): holds the PID and the process start time. Stale when that PID is not running or its start time differs (PID reuse)."""
    def __init__(self, path, pid): self.path = Path(path); self.pid = pid
    @staticmethod
    def read(path):
        try: d = json.loads(Path(path).read_text('utf8')); return (int(d['pid']), d['start'])
        except (OSError, ValueError, KeyError, TypeError): return None
    @classmethod
    def holder_alive(cls, path, proc_start=process_start):
        h = cls.read(path); cur = proc_start(h[0]) if h else None
        return h is not None and cur is not None and cur == h[1]
    @classmethod
    def acquire(cls, path, pid=None, proc_start=process_start):
        path = Path(path); pid = pid or os.getpid(); body = json.dumps({'pid': pid, 'start': proc_start(pid)})
        for _ in range(2):
            try: fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if cls.holder_alive(path, proc_start): raise StartupExit(EXIT_OK, 'another host is running (PID %d): exiting with code 0' % cls.read(path)[0]) from None
                LOG.warning('stale lockfile %s (holder %s): replacing it', path, cls.read(path))
                try: path.unlink()
                except FileNotFoundError: pass
                continue
            with os.fdopen(fd, 'w') as f: f.write(body)
            return cls(path, pid)
        raise StartupExit(EXIT_OK, 'lockfile taken by another host start: exiting with code 0')
    def release(self):
        h = self.read(self.path)
        if h and h[0] == self.pid:
            try: self.path.unlink()
            except FileNotFoundError: pass

def utc_stamp(now_ms): return datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).strftime('%Y%m%dT%H%M%SZ')
def sidecars(db): return [Path(str(db) + s) for s in ('', '-wal', '-shm')]

def quick_check(db):
    """(ok, detail) of PRAGMA quick_check (step 3). A missing file is fine: it is created. A file that is not a database fails."""
    import sqlite3
    if not Path(db).exists(): return True, 'no file'
    try:
        c = sqlite3.connect(str(db))
        try: res = [r[0] for r in c.execute('PRAGMA quick_check')]
        finally: c.close()
    except sqlite3.Error as e: return False, '%s: %s' % (type(e).__name__, e)
    return res == ['ok'], '; '.join(res[:3])

def quarantine(db, now_ms):
    """Rename the database and its -wal and -shm to <name>.corrupt-<UTC ts> (policy b); it is never resumed. Returns the new name of the main file."""
    tag = '.corrupt-' + utc_stamp(now_ms); moved = None
    for p in sidecars(db):
        if p.exists():
            dest = p.with_name(p.name.replace(db.name, db.name + tag, 1)); os.replace(p, dest); moved = moved or dest
    return moved

def restore_file(backup, db):
    """Put a copy of a backup file in place of db (any -wal and -shm of db removed first). The copy is writable; the backup stays read-only."""
    for p in sidecars(db): p.unlink(missing_ok=True)
    shutil.copyfile(backup, db); os.chmod(db, stat.S_IREAD | stat.S_IWRITE)

def restore_newest(backup_dir, db):
    """The newest backup (by file time) that passes backup-verify is restored into db. Returns its path, or None if none passes."""
    files = sorted((p for p in Path(backup_dir).glob('*.db') if p.is_file()), key=lambda p: (p.stat().st_mtime, p.name), reverse=True)
    for p in files:
        if verify_backup(p)[0]: restore_file(p, db); return p
        LOG.warning('backup %s does not pass backup-verify: skipped', p.name)
    return None

@dataclass
class Startup:
    settings: object
    mode: str
    db_path: Path
    lock: Lockfile
    conn: object
    event_seq: int
    applied: list
    recovery: object = None          # None, or {'quarantined', 'backup'} when quick_check failed: P24-2 writes INTEGRITY_FAIL (and in LIVE DB_RESTORED, host_gap db_restored)
    def close(self):
        try: self.conn.close()
        finally: self.lock.release()

def startup(home=None, mode='LIVE', now_ms=lambda: int(time.time() * 1000), proc_start=process_start, pid=None, migrations_dir=MIGRATIONS_DIR):
    """Steps 1 to 5. Raises StartupExit(code, message); on any failure after step 2 the lockfile is released first."""
    if mode not in MODES: raise StartupExit(EXIT_CONFIG, 'unknown mode %s' % mode)
    try:                                                                                              # step 1
        s = load_settings(home); s.cmac_key()                                                         # (d) the host never runs without the CMAC key
    except SettingsError as e: raise StartupExit(EXIT_CONFIG, 'configuration error: %s' % e) from None
    lock = Lockfile.acquire(s.home / LOCK_NAME, pid, proc_start)                                      # step 2
    try:
        db = s.path('db_path' if mode == 'LIVE' else 'test_db_path'); db.parent.mkdir(parents=True, exist_ok=True); backup_dir = s.path('backup_dir'); recovery = None
        saved = {q: q.read_bytes() for q in sidecars(db)[1:] if q.exists()}                           # sqlite may delete an unusable -wal or -shm while checking; keep them for the quarantine
        ok, detail = quick_check(db)                                                                  # step 3
        if not ok:
            for q, data in saved.items():
                if not q.exists(): q.write_bytes(data)
            moved = quarantine(db, now_ms()); used = restore_newest(backup_dir, db) if mode == 'LIVE' else None
            recovery = {'quarantined': moved.name, 'backup': used.name if used else None}; LOG.error('quick_check failed (%s): %s quarantined, backup used: %s', detail, moved.name, recovery['backup'])
        conn = connect_db(db)
        try:
            fresh = not applied_versions(conn); made = []                                             # step 4
            try: applied = run_migrations(conn, str(migrations_dir), now_ms(), lambda: made.append(backup_before_migration(db, backup_dir, now_ms())))
            except DatabaseTooNewError as e: raise StartupExit(EXIT_CONFIG, str(e)) from None
            except Exception as e:                                                                    # (c) restore the pre-migration backup, exit 2
                conn.close(); conn = None
                if made: restore_file(made[0], db)
                raise StartupExit(EXIT_CONFIG, 'migration failed (%s: %s)%s' % (type(e).__name__, e, '; pre-migration backup restored' if made else '')) from None
            if fresh: seed_roster(conn)                                                               # a new file gets the roster, as SIMULATOR and REPLAY must (Rev 3.40)
            try:
                from .api import security as sec
                sec.load_or_create_salt(s.home, conn.execute('SELECT COUNT(*) FROM operators').fetchone()[0] > 0)   # (d) a missing salt while operators exist
            except SettingsError as e: raise StartupExit(EXIT_CONFIG, 'configuration error: %s' % e) from None
            return Startup(s, mode, db, lock, conn, init_event_seq(conn), applied, recovery)          # step 5
        except BaseException:
            if conn is not None: conn.close()
            raise
    except BaseException: lock.release(); raise

def main(argv=None):
    p = argparse.ArgumentParser(prog='ppe_host.main'); p.add_argument('--mode', choices=MODES, default='LIVE'); p.add_argument('--home')
    a = p.parse_args(argv); logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    try: st = startup(a.home, a.mode)
    except StartupExit as e: print(e.message, file=sys.stdout if e.code == EXIT_OK else sys.stderr); return e.code
    except Exception: LOG.exception('start-up crashed'); return EXIT_CRASH
    print('start-up steps 1 to 5 done: %s, database %s, event_seq starts at %d' % (st.mode, st.db_path, st.event_seq))
    st.close(); return EXIT_OK              # P24-2 continues here with step 6

if __name__ == '__main__': sys.exit(main())
