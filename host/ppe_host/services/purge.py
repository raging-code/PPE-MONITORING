"""services/purge.py (P26-2, ADR 0039): purge-session of design 2.8 and 2.11, the one deletion path of Tier 1 (RA 10173). Offline only; ppe_host.cli purge-session is the command.
What a purge is:
  - The rows of ONE closed session are deleted from the live database in one transaction with foreign_keys=ON and PRAGMA secure_delete=ON, in strict foreign-key order:
    ml_outputs (Tier 2, skipped when the table does not exist), alerts, episodes, frames, audit_events, system_events, base_health, advisory_summaries, checkpoints, then the sessions row.
    The audit row (session_id NULL, event_seq 0, action SESSION_PURGED, reason = the purged session id) is in the same transaction: the data and the record of its deletion go together or not at all.
    After the commit: wal_checkpoint(TRUNCATE), VACUUM and wal_checkpoint(TRUNCATE) again, so deleted pages do not stay in the file or in the -wal file.
  - The same deletion is run on every backup copy that holds the session (the local backup_dir and each --usb-dir; the read-only attribute is lifted for the change and put back) and exports/session_<id>_*.csv is deleted.
  - Refusals, all before anything is deleted: the host lockfile is live, a session is monitoring (an open session with monitoring_active), or the session is still open: exit code 1, no audit row.
    An alert opened in the session with cleared_ts NULL, or an episode of the session that is not RESOLVED, or a foreign-key violation (a row of a later session that points at this one): exit code 2 with an audit row
    (action SESSION_PURGED, reason 'refused <id>: ...'; audit_actions has no separate refusal action and is frozen). A foreign-key violation rolls the transaction back, nothing is deleted.
  - A session that is no longer in the live database is still swept from the copies and exports (a purge that stopped half way can be run again); an id found nowhere exits with 1.
Not here: the choice of the second-drive location for End shift copies (P26-3)."""
import os, sqlite3, stat, time
from pathlib import Path
from ..io.db_writer import connect_db

CHILD_TABLES = ('ml_outputs', 'alerts', 'episodes', 'frames', 'audit_events', 'system_events', 'base_health', 'advisory_summaries', 'checkpoints')
READ_ONLY = stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH
WRITABLE = stat.S_IWRITE | stat.S_IREAD

class Refused(Exception):
    """A purge that is not allowed. code 1: nothing recorded; code 2: an audit row is written (audit=True)."""
    def __init__(self, code, message, audit=False): super().__init__(message); self.code = code; self.message = message; self.audit = audit

def _tables(conn): return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}

def session_row(conn, sid): return conn.execute('SELECT session_id, ended_ts, monitoring_active FROM sessions WHERE session_id = ?', (sid,)).fetchone()

def check_purgeable(conn, sid):
    """Raises Refused. The session must exist, be closed, and own no open alert and no unresolved episode; and no session may be monitoring."""
    row = session_row(conn, sid)
    if row is None: raise Refused(1, 'session %d is not in the database' % sid)
    if conn.execute('SELECT 1 FROM sessions WHERE ended_ts IS NULL AND monitoring_active = 1').fetchone(): raise Refused(1, 'a session is monitoring: purge only when no shift is running')
    if row[1] is None: raise Refused(1, 'session %d is still open: end the shift first' % sid)
    a = conn.execute('SELECT COUNT(*) FROM alerts WHERE session_id = ? AND cleared_ts IS NULL', (sid,)).fetchone()[0]
    e = conn.execute("SELECT COUNT(*) FROM episodes WHERE session_id = ? AND state != 'RESOLVED'", (sid,)).fetchone()[0]
    if a or e: raise Refused(2, 'session %d still has %d open alert(s) and %d unresolved episode(s): clear and Resolve them first' % (sid, a, e), audit=True)

def delete_session(conn, sid, audit_ts=None):
    """The deletion in one transaction (the caller has checked). Returns {table: rows deleted}. audit_ts not None: the SESSION_PURGED row is written in the same transaction. A foreign-key violation rolls everything back and raises Refused(2)."""
    conn.execute('PRAGMA secure_delete=ON'); have = _tables(conn); counts = {}
    conn.execute('BEGIN IMMEDIATE')
    try:
        for t in CHILD_TABLES:
            if t in have: counts[t] = conn.execute('DELETE FROM %s WHERE session_id = ?' % t, (sid,)).rowcount
        counts['sessions'] = conn.execute('DELETE FROM sessions WHERE session_id = ?', (sid,)).rowcount
        if audit_ts is not None: conn.execute("INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, reason) VALUES (NULL, 0, ?, NULL, 'SESSION_PURGED', ?)", (audit_ts, str(sid)))
        bad = conn.execute('PRAGMA foreign_key_check').fetchall()
        if bad: raise sqlite3.IntegrityError('foreign_key_check reports %d row(s)' % len(bad))
        conn.execute('COMMIT')
    except sqlite3.IntegrityError as e:
        conn.execute('ROLLBACK'); raise Refused(2, 'rolled back, nothing deleted: %s (a row of another session may point at session %d)' % (e, sid), audit=True) from None
    except BaseException: conn.execute('ROLLBACK'); raise
    return counts

def compact(conn):
    """After the commit: nothing of the deleted rows stays in the -wal file or in free pages."""
    conn.execute('PRAGMA wal_checkpoint(TRUNCATE)'); conn.execute('VACUUM'); conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')

def audit_row(db_path, reason, now_ms=None):
    """One offline admin audit row (session_id NULL, event_seq 0, action SESSION_PURGED): a refused purge (exit code 2) or a sweep of copies for a session that is already gone from the live database."""
    conn = connect_db(db_path)
    try: conn.execute("INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, reason) VALUES (NULL, 0, ?, NULL, 'SESSION_PURGED', ?)", (now_ms or int(time.time() * 1000), reason[:300]))
    finally: conn.close()

def write_refusal(db_path, sid, message, now_ms=None): audit_row(db_path, 'refused %d: %s' % (sid, message), now_ms)

def purge_live(db_path, sid, now_ms=None):
    """check_purgeable, delete_session with its audit row, compact. Raises Refused. Returns the counts."""
    conn = connect_db(db_path)
    try:
        check_purgeable(conn, sid); counts = delete_session(conn, sid, now_ms or int(time.time() * 1000)); compact(conn)
    finally: conn.close()
    return counts

def _open_copy(p):
    """A plain connection for a backup copy: foreign keys on, and no journal-mode change (connect_db would switch the copy to WAL, which changes a file that may not even hold the session)."""
    conn = sqlite3.connect(str(p), isolation_level=None); conn.execute('PRAGMA foreign_keys=ON'); conn.execute('PRAGMA busy_timeout=5000'); return conn

def purge_copy(path, sid):
    """One backup copy. Returns ('absent' | 'purged' | 'skipped' | 'failed', detail). A copy without the session, and a file that is not a PPE database, are read only and never written. The read-only attribute is lifted
    for the change and restored. No refusal rules here: a copy is a snapshot (its alerts may have been open when it was made); the live database decided that the session may go."""
    p = Path(path); mode = p.stat().st_mode; conn = None
    try:
        try:
            conn = _open_copy(p); tabs = _tables(conn)
        except sqlite3.DatabaseError: return 'skipped', 'not a database'
        if not {'sessions', 'schema_version'} <= tabs: return 'skipped', 'not a PPE database'
        if session_row(conn, sid) is None: return 'absent', ''
        conn.close(); conn = None
        os.chmod(p, WRITABLE); conn = _open_copy(p)
        try: counts = delete_session(conn, sid); conn.execute('VACUUM')
        except Refused as e: return 'failed', e.message
        return 'purged', '%d row(s)' % sum(counts.values())
    except (OSError, sqlite3.Error) as e: return 'failed', '%s: %s' % (type(e).__name__, e)
    finally:
        if conn is not None: conn.close()
        try: os.chmod(p, mode)
        except OSError: pass

def copies(dirs, live_db):
    """(directory, [*.db files]) for each directory, never the live database, never a .part file. A directory that does not exist gives None for its list."""
    live = Path(live_db).resolve(); out = []
    for d in dirs:
        d = Path(d)
        if not d.is_dir(): out.append((d, None)); continue
        out.append((d, sorted(f for f in d.glob('*.db') if f.is_file() and f.resolve() != live)))
    return out

def sweep_exports(export_dir, sid):
    """Delete exports/session_<id>_*.csv. Returns (deleted names, [whole-database exports that may still hold the session]). A file that cannot be deleted is an OSError."""
    d = Path(export_dir); gone = []
    if d.is_dir():
        for f in sorted(d.glob('session_%d_*.csv' % sid)):
            try: os.chmod(f, WRITABLE)
            except OSError: pass
            f.unlink(); gone.append(f.name)
    return gone, ([f.name for f in sorted(d.glob('export_all_*.csv'))] if d.is_dir() else [])
