"""io/backup.py (P11-2, P26-3): online backup, backup verification, the copy to a second drive and the full integrity check (design 2.5, 2.6).
The backup uses the sqlite3 backup API (250 pages per step), never a file copy, because the WAL is active. The result is one self-contained file
(journal_mode DELETE, so it opens read-only anywhere) and is made read-only (2.6).
P26-3 (ADR 0040): copy_to_second_drive copies a verified backup file (a plain file copy is safe there: the backup is closed, has no WAL and is read-only) into an existing folder on the second drive,
and integrity_check runs PRAGMA integrity_check on a read-only connection, also on the live database. HostPort.end_session calls both off the event loop, in the worker thread of POST /api/session/end."""
import os, shutil, sqlite3, stat
from datetime import datetime, timezone
from pathlib import Path

PAGES_PER_STEP = 250

def online_backup(src_path, dest_path):
    """Copy the database at src_path into dest_path through the backup API. Written beside the destination first and renamed into place."""
    dest = Path(dest_path); dest.parent.mkdir(parents=True, exist_ok=True); tmp = dest.with_name(dest.name + '.part')
    if tmp.exists(): tmp.unlink()
    src = sqlite3.connect('file:%s?mode=ro' % str(src_path).replace('\\', '/'), uri=True); out = sqlite3.connect(str(tmp))
    try:
        src.backup(out, pages=PAGES_PER_STEP); out.execute('PRAGMA journal_mode=DELETE')
    finally: out.close(); src.close()
    if dest.exists(): os.chmod(dest, stat.S_IWRITE | stat.S_IREAD); dest.unlink()
    os.replace(tmp, dest); os.chmod(dest, stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)       # 0444 (Windows: the read-only attribute)
    return dest

def backup_name(prefix, now_ms): return '%s-%s.db' % (prefix, datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).strftime('%Y%m%dT%H%M%SZ'))

def backup_before_migration(db_path, backup_dir, now_ms):
    """The run_migrations before_apply hook (design 2.3: an online backup before any migration)."""
    return online_backup(db_path, Path(backup_dir) / backup_name('pre-migration', now_ms))

def second_drive_dir(settings):
    """The folder of the second drive (setting second_drive_dir), or None while the setting is empty (no copy is made)."""
    v = settings.get('second_drive_dir')
    return settings.path('second_drive_dir') if isinstance(v, str) and v.strip() else None

def copy_to_second_drive(backup_path, drive_dir, local_dir=None):
    """Copy the backup file into drive_dir under its own name; the copy is read-only and passes verify_backup, or it is removed and an error raised (the local file is never touched).
    drive_dir must already exist: a drive that is not plugged in must fail, not make a folder on the system disk. The same folder as local_dir is refused (that is not a second copy).
    Written as <name>.part first and renamed into place, so an unplugged cable never leaves a half file under the real name. Returns the path of the copy."""
    src, drive = Path(backup_path), Path(drive_dir)
    if not drive.is_dir(): raise OSError('second drive folder not found (drive not connected?): %s' % drive)
    if local_dir is not None and Path(local_dir).is_dir() and os.path.samefile(drive, local_dir): raise OSError('second_drive_dir is the same folder as backup_dir: %s' % drive)
    dest = drive / src.name; tmp = dest.with_name(dest.name + '.part')
    try:
        if tmp.exists(): os.chmod(tmp, stat.S_IWRITE | stat.S_IREAD); tmp.unlink()
        shutil.copyfile(src, tmp)
        if dest.exists(): os.chmod(dest, stat.S_IWRITE | stat.S_IREAD); dest.unlink()
        os.replace(tmp, dest); os.chmod(dest, stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)
    except BaseException:
        if tmp.exists():
            try: os.chmod(tmp, stat.S_IWRITE | stat.S_IREAD); tmp.unlink()
            except OSError: pass
        raise
    good, why = verify_backup(dest)
    if not good:
        os.chmod(dest, stat.S_IWRITE | stat.S_IREAD); dest.unlink(); raise OSError('the copy on the second drive failed verification and was removed: ' + why)
    return dest

def integrity_check(path):
    """(ok, detail): the full PRAGMA integrity_check on a read-only connection (design 2.5, at session end). Works on the live database while the writer is running (WAL readers do not block it).
    detail is 'ok', or the first three problems, or the sqlite error when the file cannot be read at all."""
    try:
        c = sqlite3.connect('file:%s?mode=ro' % str(path).replace('\\', '/'), uri=True, timeout=5)
        try: res = [r[0] for r in c.execute('PRAGMA integrity_check')]
        finally: c.close()
    except sqlite3.Error as e: return False, '%s: %s' % (type(e).__name__, e)
    return (True, 'ok') if res == ['ok'] else (False, '; '.join(res[:3]))

def verify_backup(path):
    """(ok, detail). A good backup opens read-only, passes integrity_check, has PPE's schema_version table and an empty foreign_key_check."""
    if not Path(path).is_file(): return False, 'file not found'
    try:
        c = sqlite3.connect('file:%s?mode=ro' % str(path).replace('\\', '/'), uri=True)
        try:
            res = [r[0] for r in c.execute('PRAGMA integrity_check')]
            if res != ['ok']: return False, 'integrity_check: ' + '; '.join(res[:3])
            if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'").fetchone(): return False, 'not a PPE database (no schema_version)'
            if c.execute('PRAGMA foreign_key_check').fetchall(): return False, 'foreign_key_check reports rows'
            return True, 'ok'
        finally: c.close()
    except sqlite3.Error as e: return False, '%s: %s' % (type(e).__name__, e)
