"""services/sessions.py (P25-3, ADR 0037): close_session(kind), the one place that builds the rows that close a sessions row (design 2.3, 2.11, Rev 3.17, 3.27, 3.38, 3.40).
Every closure is one atomic BEGIN IMMEDIATE transaction, in this order: (a) the END_SHIFT audit row (ENDED), or the CLEAN_SHUTDOWN or SESSION_ABANDONED system row, in the OLD session;
(b) ended_ts and end_kind of the old session in one UPDATE (the sessions CHECK wants both or neither), before any new row, because idx_sessions_one_open allows one session with ended_ts NULL;
(c) for ENDED only, the new session (monitoring_active carried; mode, host_build and both hashes copied, because End shift does not change them); (d) commit.
Alerts and episodes are never touched: they keep their ids and stay open across the change (2.11).
close_stmts() only builds the statements. Three callers run them:
  ABANDONED  main.begin_session, on its own connection inside the start-up transaction (run_stmts), before the writer exists;
  ENDED      Ingest.close_session through HostPort.end_session, as one atomic Unit of the DBWriter (an atomic unit is rolled back whole on a deterministic failure and never committed row by row);
  CLEAN_SHUTDOWN  Ingest.close_session from Runtime.stop(clean=True), drained with the writer."""
import json
from ..io.db_writer import Stmt
from ..io.ingest import AUDIT_SQL, SYS_SQL

KINDS = ('ENDED', 'CLEAN_SHUTDOWN', 'ABANDONED')
SYS_KIND = {'CLEAN_SHUTDOWN': 'CLEAN_SHUTDOWN', 'ABANDONED': 'SESSION_ABANDONED'}
CLOSE_SQL = 'UPDATE sessions SET ended_ts = ?, end_kind = ? WHERE session_id = ? AND ended_ts IS NULL'
OPEN_NEXT_SQL = ('INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash, monitoring_active) '
                 'SELECT ?, ?, mode, host_build, constants_hash, settings_hash, monitoring_active FROM sessions WHERE session_id = ?')

def close_stmts(kind, sid, ts, event_seq, operator_id=None, detail=None, new_sid=None):
    """The statements of close_session(kind) for the open session sid, in the order of the design. event_seq belongs to the first row (the audit or the system row).
    ENDED needs operator_id (the audit row has an operator) and new_sid (the id of the session it opens); detail is the audit reason (ENDED) or the system row detail."""
    if kind not in KINDS: raise ValueError('unknown close kind %r' % (kind,))
    if kind == 'ENDED':
        if operator_id is None or new_sid is None: raise ValueError('ENDED needs operator_id and new_sid')
        first = Stmt(AUDIT_SQL, (sid, event_seq, ts, operator_id, 'END_SHIFT', None, None, detail))
    else: first = Stmt(SYS_SQL, (sid, event_seq, ts, SYS_KIND[kind], detail))
    out = [first, Stmt(CLOSE_SQL, (ts, kind, sid))]
    if kind == 'ENDED': out.append(Stmt(OPEN_NEXT_SQL, (new_sid, ts, sid)))
    return out

def run_stmts(conn, stmts):
    """Run close_stmts on a connection that is already inside the caller's transaction (start-up)."""
    for s in stmts: conn.execute(s.sql, s.params)

def next_session_id(q):
    """The id the next session gets. q(sql, args=()) returns rows. Only close_session opens a session while the host runs, and HostPort serialises it."""
    return q('SELECT COALESCE(MAX(session_id), 0) + 1 FROM sessions')[0][0]

def end_shift_detail(q, latched=()):
    """The reason of the END_SHIFT row: what End shift carries into the next session (design D8: 'logs END_SHIFT with the open list').
    Open alerts [node_id, type], open episodes [episode_id, node_id, state] (every session) and the nodes whose jacket latch is still set."""
    alerts = [[r[0], r[1]] for r in q('SELECT node_id, type FROM alerts WHERE cleared_ts IS NULL ORDER BY alert_id')]
    episodes = [[r[0], r[1], r[2]] for r in q("SELECT episode_id, node_id, state FROM episodes WHERE state IN ('OPEN', 'ACKNOWLEDGED') ORDER BY episode_id")]
    return json.dumps({'open_alerts': alerts, 'open_episodes': episodes, 'latched_nodes': sorted(latched)}, separators=(',', ':'))
