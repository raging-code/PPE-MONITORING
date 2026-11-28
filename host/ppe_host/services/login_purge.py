"""services/login_purge.py (P28-7, ADR 0056): delete old, dead login_sessions rows. Offline only; ppe_host.cli purge-login-sessions is the command.
A login session is DEAD from the first moment it can no longer sign anyone in: its revoked_ts, or its expires_ts, whichever is earlier.
Only a session that has been dead for more than older_than_days is deleted (default 30). A live session (not revoked, not expired) is never deleted, whatever the number of days.
Nothing else points at a login_sessions row (no audit, frame or alert column holds a login_session_id), so no other table changes. The operators table is untouched.
No audit row is written: audit_actions is frozen at 21 rows and has no action for it (ADR 0056); the command prints what it deleted.
Backup copies keep the rows they were made with; the next backup after the purge is without them."""
import sqlite3
from ..io.db_writer import connect_db

DAY_MS = 86_400_000
DEAD_TS = 'MIN(expires_ts, COALESCE(revoked_ts, expires_ts))'

def has_table(conn): return conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'login_sessions'").fetchone() is not None

def cutoff_ms(now_ms, older_than_days): return int(now_ms) - int(older_than_days) * DAY_MS

def count_old(conn, cutoff):
    return conn.execute('SELECT COUNT(*) FROM login_sessions WHERE %s < ?' % DEAD_TS, (cutoff,)).fetchone()[0]

def purge_old(db_path, now_ms, older_than_days, dry_run=False):
    """(deleted_or_would_delete, kept). One transaction. Raises LookupError when the database has no login_sessions table (migration 0003 not applied) and ValueError for a negative number of days."""
    if older_than_days < 0: raise ValueError('older_than_days must be 0 or more')
    cutoff = cutoff_ms(now_ms, older_than_days)
    conn = connect_db(db_path)
    try:
        if not has_table(conn): raise LookupError('the database has no login_sessions table (migration 0003 is not applied yet)')
        conn.execute('BEGIN IMMEDIATE')
        try:
            n = count_old(conn, cutoff)
            if not dry_run and n: conn.execute('DELETE FROM login_sessions WHERE %s < ?' % DEAD_TS, (cutoff,))
            conn.execute('COMMIT')
        except BaseException: conn.execute('ROLLBACK'); raise
        kept = conn.execute('SELECT COUNT(*) FROM login_sessions').fetchone()[0]
        return n, kept
    finally: conn.close()
