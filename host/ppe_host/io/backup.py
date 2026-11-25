"""io/backup.py (P11-2): online backup and backup verification (design 2.5, 2.6). P26 adds scheduling, the second drive and purge.
The backup uses the sqlite3 backup API (250 pages per step), never a file copy, because the WAL is active. The result is one self-contained file
(journal_mode DELETE, so it opens read-only anywhere) and is made read-only (2.6)."""
import os, sqlite3, stat
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
