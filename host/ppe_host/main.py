"""main.py (P24-1): start-up steps 1 to 5 of design 14.5 and the start-up failure policy (a to d). P24-2 added steps 6 and 7 (begin_session); step 8 (threads, P24-3c-1), step 9 (open state, P24-3c-2), step 10 (Uvicorn and the 1 Hz driver, serve.py, P24-3c-3).
Exit codes: 0 = clean exit or another host already runs (the supervisor does not respawn), 1 = unexpected crash, 2 = configuration or database failure, or Uvicorn cannot bind its port (counts toward the crash-loop guard).
Run: python -m ppe_host.main [--mode LIVE|SIMULATOR|REPLAY] [--home PPE_HOME] [--scenario quiet|co_ramp|man_down|link_loss|rehearsal] [--seed N] [--session N] [--speed 1|4|16]
S7-3 (ADR 0059): --mode REPLAY needs --session N (a session of db_path) and takes --speed 1, 4 or 16 (default 1); both are refused with any other mode (exit 2). The session is replayed from db_path, read-only, into a new REPLAY session of test_db_path.
S7-1 (ADR 0057): --scenario and --seed are accepted only with --mode SIMULATOR (exit 2 otherwise); SIMULATOR without them runs the rehearsal scenario with seed 1. LIVE and REPLAY never start a simulator.
A rehearsal needs an operator in the TEST database: python -m ppe_host.cli create-operator --name NAME --db data/ppe_test.db (operators are per database)."""
import argparse, asyncio, contextlib, json, logging, os, shutil, signal, stat, sys, threading, time, uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from .clock import RealClock
from .settings import SettingsError, constants_hash, load_settings, settings_hash
from .io.backup import backup_before_migration, verify_backup
from .io.db_writer import DatabaseTooNewError, applied_versions, connect_db, init_event_seq, run_migrations
from .cli import MIGRATIONS_DIR, seed_roster
from .io.audio_watchdog import WinsoundBackend
from .io.os_watchdog import consume_marker
from .services import abi_check, replay as rpl, sessions as ses
from .runtime import Runtime
from .services.simulator import DEFAULT_SCENARIO, DEFAULT_SEED, SCENARIOS
from .serve import ServeError, run_server

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
    recovery: object = None          # None, or {'quarantined', 'backup'} when quick_check failed; begin_session writes INTEGRITY_FAIL (and in LIVE DB_RESTORED)
    session_id: int = None           # set by begin_session (steps 6 and 7)
    resumed: bool = False
    recovering: bool = False         # True from step 7 until RECOVERING_EXIT (P25)
    host_boot_id: str = None
    host_gap_reason: str = None      # 'db_restored' in LIVE after a restore: the host_gap banner (P24-3 shows it)
    def close(self):
        try: self.conn.close()
        finally: self.lock.release()

def startup(home=None, mode='LIVE', now_ms=lambda: int(time.time() * 1000), proc_start=process_start, pid=None, migrations_dir=MIGRATIONS_DIR):
    """Steps 1 to 5. Raises StartupExit(code, message); on any failure after step 2 the lockfile is released first."""
    if mode not in MODES: raise StartupExit(EXIT_CONFIG, 'unknown mode %s' % mode)
    try:                                                                                              # step 1
        s = load_settings(home); s.cmac_key()                                                         # (d) the host never runs without the CMAC key
    except SettingsError as e: raise StartupExit(EXIT_CONFIG, 'configuration error: %s' % e) from None
    try: bad = abi_check.mismatches()                                                                 # step 1 (P24-5d, ADR 0049): the frame layout the host parses with is the one in shared/abi.json
    except abi_check.AbiError as e: raise StartupExit(EXIT_CONFIG, 'ABI check failed: %s' % e) from None
    if bad: raise StartupExit(EXIT_CONFIG, 'ABI mismatch: host/ppe_host/abi.py differs from shared/abi.json in %s; run python tools/gen_abi.py or use the files of one build' % ', '.join(bad))
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

def host_build():
    try:
        from importlib.metadata import version
        return 'ppe-host ' + version('ppe-host')
    except Exception: return 'ppe-host 0.0.0+dev'

def _sys(conn, st, sid, ts, kind, detail=None):
    conn.execute('INSERT INTO system_events(session_id, event_seq, ts, kind, detail) VALUES (?, ?, ?, ?, ?)', (sid, st.event_seq, ts, kind, detail)); st.event_seq += 1

def last_row_ts(conn, sid):
    """The newest stored timestamp of the session over frames, alerts, audit_events and system_events (its start if it has no row)."""
    qs = ('SELECT COALESCE(MAX(rx_ts), 0) FROM frames WHERE session_id = ?', 'SELECT MAX(COALESCE(MAX(raised_ts), 0), COALESCE(MAX(cleared_ts), 0)) FROM alerts WHERE session_id = ?',
          'SELECT COALESCE(MAX(ts), 0) FROM audit_events WHERE session_id = ?', 'SELECT COALESCE(MAX(ts), 0) FROM system_events WHERE session_id = ?', 'SELECT started_ts FROM sessions WHERE session_id = ?')
    return max(conn.execute(q, (sid,)).fetchone()[0] for q in qs)

def begin_session(st, clock=None):
    """Steps 6 and 7 in one transaction. Resume the open session only if its mode and both hashes match and its last row is younger than session_resume_max_min;
    otherwise close it ABANDONED (SESSION_ABANDONED with detail mode_changed, config_hash_changed or stale_30min, in that order of precedence) and open a new one.
    Then log HOST_START (host_boot_id, mono_base_ms), RECOVERING_ENTER, then (P24b) LIVENESS_RESTART when the previous process left a crash marker (TICK_STALL too when the 1 Hz tick was among
    the stale parts) and, after a quick_check failure, INTEGRITY_FAIL and in LIVE the DB_RESTORED audit row (session_id NULL).
    Alerts and episodes are never touched (2.11). The close itself is services/sessions.close_session (P25-3), the one place that orders its rows; the rebase of old monotonic stamps is services/recovery.py (P25-1)."""
    clock = clock or RealClock(); now = clock.wall_ms(); conn = st.conn; ch, sh = constants_hash(), settings_hash(st.settings); limit = st.settings['session_resume_max_min'] * 60_000
    conn.execute('BEGIN IMMEDIATE')
    try:
        row = conn.execute('SELECT session_id, mode, constants_hash, settings_hash FROM sessions WHERE ended_ts IS NULL').fetchone(); sid, changed = None, False
        if row:
            why = 'mode_changed' if row[1] != st.mode else 'new_replay' if st.mode == 'REPLAY' else 'config_hash_changed' if (row[2], row[3]) != (ch, sh) else 'stale_30min' if now - last_row_ts(conn, row[0]) >= limit else None
            if why is None: sid, st.resumed = row[0], True
            else:
                ses.run_stmts(conn, ses.close_stmts('ABANDONED', row[0], now, st.event_seq, detail=why)); st.event_seq += 1; changed = why == 'config_hash_changed'      # P25-3: the same rows in the same order as before, from the one close_session
        if sid is None:
            sid = conn.execute('INSERT INTO sessions(started_ts, mode, host_build, constants_hash, settings_hash) VALUES (?, ?, ?, ?, ?)', (now, st.mode, host_build(), ch, sh)).lastrowid
        st.host_boot_id = uuid.uuid4().hex
        _sys(conn, st, sid, now, 'HOST_START', json.dumps({'host_boot_id': st.host_boot_id, 'mono_base_ms': clock.mono_ms(), 'wall_base_ms': now, 'mode': st.mode}))
        _sys(conn, st, sid, now, 'RECOVERING_ENTER')
        marker = consume_marker(st.settings.path('log_dir'))
        if marker is not None:
            _sys(conn, st, sid, now, 'LIVENESS_RESTART', json.dumps(marker))
            if marker.get('kind') == 'stall' and 'tick' in (marker.get('stale') or {}):
                _sys(conn, st, sid, now, 'TICK_STALL', json.dumps({'age_ms': marker['stale']['tick']}))
        if st.recovery:
            _sys(conn, st, sid, now, 'INTEGRITY_FAIL', 'quarantined %s; backup used: %s' % (st.recovery['quarantined'], st.recovery['backup'] or 'none (fresh database)'))
            if st.mode == 'LIVE':
                conn.execute('INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, reason) VALUES (NULL, ?, ?, NULL, ?, ?)', (st.event_seq, now, 'DB_RESTORED', st.recovery['backup'] or 'fresh database')); st.event_seq += 1
                st.host_gap_reason = 'db_restored'
        if changed: _sys(conn, st, sid, now, 'CONFIG_CHANGED', 'constants_hash or settings_hash changed; the previous session was closed')
        conn.execute('COMMIT')
    except BaseException: conn.execute('ROLLBACK'); raise
    st.session_id, st.recovering = sid, True
    return st

def check_replay(st, session_id):
    """S7-3 (ADR 0059): before any session row is written. The session must be in db_path and hold frames, and the test database must have no open alert or unresolved episode from an earlier test session. Returns the SourceInfo."""
    try: info = rpl.open_source(st.settings.path('db_path'), session_id)
    except rpl.ReplayError as e: raise StartupExit(EXIT_CONFIG, 'REPLAY: %s' % e)
    alerts, episodes = rpl.stale_test_items(st.conn)
    if alerts or episodes: raise StartupExit(EXIT_CONFIG, 'REPLAY: %s has %d open alert(s) and %d unresolved episode(s) from an earlier test session; resolve them or delete the file, then start again' % (st.db_path, alerts, episodes))
    return info

def watchdog_exit(code): os._exit(code)                      # the OSWatchdogThread's exit (tests replace it with a recorder, tests/conftest.py)
def make_audio_backend(): return WinsoundBackend()          # tests replace this with a silent fake (tests/conftest.py)

@contextlib.contextmanager
def stop_signals():
    """S7-4 (ADR 0060): yields the list of stop signals received while the server runs; the process is not killed or interrupted by them.
    Uvicorn stops on SIGINT and SIGTERM (SIGBREAK on Windows), and when it has stopped it puts the old handlers back and sends the same signal again, to get "the expected behaviour".
    With Python's default handler that is a KeyboardInterrupt (exit -2) and with the system default for SIGTERM it ends the process at once (exit -15): in both main() never reached rt.stop(clean=True), so no CLEAN_SHUTDOWN row and the session stayed open.
    Our handler only records the signal, so the second delivery is harmless. Handlers are set only in the main thread and are put back on exit."""
    got, old = [], {}
    if threading.current_thread() is threading.main_thread():
        for name in ('SIGINT', 'SIGTERM', 'SIGBREAK'):
            sig = getattr(signal, name, None)
            if sig is None: continue
            try: old[sig] = signal.signal(sig, lambda s, f: got.append(s))
            except (ValueError, OSError): pass
    try: yield got
    finally:
        for sig, h in old.items():
            try: signal.signal(sig, h)
            except (ValueError, OSError, TypeError): pass

def main(argv=None, serve=run_server):
    """serve(rt, host, port) is the coroutine function of step 10; tests pass a fake that returns at once."""
    p = argparse.ArgumentParser(prog='ppe_host.main'); p.add_argument('--mode', choices=MODES, default='LIVE'); p.add_argument('--home')
    p.add_argument('--scenario', choices=tuple(SCENARIOS), help='SIMULATOR only (default %s)' % DEFAULT_SCENARIO); p.add_argument('--seed', type=int, help='SIMULATOR only (default %d)' % DEFAULT_SEED)
    p.add_argument('--session', type=int, help='REPLAY only (required): the session_id in db_path to replay'); p.add_argument('--speed', type=int, choices=rpl.SPEEDS, help='REPLAY only (default 1)')
    a = p.parse_args(argv)
    if a.mode != 'SIMULATOR' and (a.scenario is not None or a.seed is not None): print('--scenario and --seed need --mode SIMULATOR', file=sys.stderr); return EXIT_CONFIG
    if a.mode != 'REPLAY' and (a.session is not None or a.speed is not None): print('--session and --speed need --mode REPLAY', file=sys.stderr); return EXIT_CONFIG
    if a.mode == 'REPLAY' and a.session is None: print('--mode REPLAY needs --session N (the session_id in db_path to replay; python -m ppe_host.cli lists them in the dashboard Sessions list)', file=sys.stderr); return EXIT_CONFIG
    sim = (a.scenario or DEFAULT_SCENARIO, DEFAULT_SEED if a.seed is None else a.seed) if a.mode == 'SIMULATOR' else None
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    try:
        st = startup(a.home, a.mode)
        try:
            info = check_replay(st, a.session) if a.mode == 'REPLAY' else None; speed = a.speed or 1
            begin_session(st)
            if info: st.conn.execute('UPDATE sessions SET session_label = ? WHERE session_id = ?', (rpl.label_of(info), st.session_id))
            rt = Runtime(st, audio_backend=make_audio_backend(), watchdog_exit=lambda c: watchdog_exit(c), simulator=sim, drain=st.mode != 'LIVE', replay=(a.session, speed) if info else None).start(); rt.load_open()                                           # steps 6 and 7, step 8 (P24-3c-1), step 9 (P24-3c-2)
        except BaseException: st.close(); raise
    except StartupExit as e: print(e.message, file=sys.stdout if e.code == EXIT_OK else sys.stderr); return e.code
    except Exception: LOG.exception('start-up crashed'); return EXIT_CRASH
    print('start-up steps 1 to 9 done: %s, session %d%s, database %s%s' % (st.mode, st.session_id, ' (resumed)' if st.resumed else '', st.db_path, ', scenario %s seed %d' % sim if sim else '') + (', replaying session %d at %dx (%d frames)' % (a.session, speed, info.frames) if info else ''))
    clean = False                                                                                              # P25-3: only a server that stopped by itself (SIGINT, SIGTERM) is a clean shutdown
    try:
        with stop_signals() as got: asyncio.run(serve(rt, st.settings['bind_host'], st.settings['bind_port']))                          # step 10 (P24-3c-3); steps 11 to 13 run as a task of run_server (Runtime.recover, P25-2)
        clean = True
        if got: LOG.info('stopped by signal %s', ', '.join(signal.Signals(g).name for g in got))
    except KeyboardInterrupt: LOG.info('stopped by Ctrl+C'); clean = True                                                              # S7-4 (ADR 0060): an operator's stop, not a crash (belt and braces; stop_signals normally catches it first)
    except ServeError as e: print('step 10 failed: %s' % e, file=sys.stderr); return EXIT_CONFIG
    except Exception: LOG.exception('step 10 failed'); return EXIT_CRASH
    finally: rt.stop(clean=clean); st.close()
    return EXIT_OK

def finish(code):
    """S7-6 (ADR 0063): the last step of `python -m ppe_host.main`. main() has already stopped everything and written CLEAN_SHUTDOWN, but on Windows the process still ended with exit code
    -1073741510 (0xC000013A, STATUS_CONTROL_C_EXIT, "ended by Ctrl+C") after a single Ctrl+C: Windows treated the console event as unhandled somewhere between the end of main() and the end of the interpreter,
    and a supervisor reads a non-zero code as a crash and restarts the host. So: ignore further Ctrl+C and Ctrl+Break (the work is done), log one line, flush, and leave with os._exit(code) so that the code is the one main() chose.
    os._exit skips the interpreter's own teardown only; the runtime, the writer and the database were closed by main()."""
    for name in ('SIGINT', 'SIGBREAK'):
        sig = getattr(signal, name, None)
        if sig is None: continue
        try: signal.signal(sig, signal.SIG_IGN)
        except (ValueError, OSError): pass
    LOG.info('host stopped, exit code %d', code)
    logging.shutdown()
    for f in (sys.stdout, sys.stderr):
        try: f.flush()
        except (OSError, ValueError): pass
    os._exit(code)

if __name__ == '__main__': finish(main())
