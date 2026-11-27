"""P25-3 (ADR 0037): close_session(kind) in services/sessions.py, the atomic unit of the DBWriter, Ingest.close_session, HostPort.end_session with its backup, and the CLEAN_SHUTDOWN close of Runtime.stop(clean=True).
Real database, writer and FakeClock. Design 2.3 (unified close_session), 2.11 (open alerts and episodes are not touched), 3.8 (POST /api/session/end), 8 (End shift test, End shift conflict test, session transition test)."""
import json, sqlite3
import pytest
from ppe_host import main as M
from ppe_host.api import security as sec
from ppe_host.clock import FakeClock
from ppe_host.host_port import HostPort
from ppe_host.io import backup as bk
from ppe_host.io.ingest import load_open_state
from ppe_host.runtime import Runtime
from ppe_host.services import sessions as ses
from fakeport import FakePort
from test_effect_rows import by_type, op, wait
from test_gv_bytes import pack
from test_ingest import rig, rows, send
from test_session_start import MIN, start, sysrows
from test_startup import NOW, home, run

class Cfg(dict):
    """The part of Settings that HostPort uses: item access and path()."""
    def __init__(self, d, root): super().__init__(d); self.root = root
    def path(self, key): return self.root / self[key]

def eport(tmp_path):
    c, w, clock, ing = rig(tmp_path); op(c, 1)
    cfg = Cfg({'recovering_target_s': 3, 'login_backoff_cap_s': 5, 'backup_dir': 'backups/'}, tmp_path)
    p = HostPort(ing, tmp_path / 't.db', cfg, sec.Authenticator(tmp_path / 't.db', '00' * 32, 5), recovering=False)
    return c, w, clock, ing, p
def backups(tmp_path): return sorted((tmp_path / 'backups').glob('end-shift-*.db')) if (tmp_path / 'backups').exists() else []
def err(call):
    with pytest.raises(Exception) as ex: call()
    return ex.value.status, ex.value.env.error_code

# ---- the rows and their order ----
def test_close_stmts_follow_the_design_order_for_each_kind():
    e = ses.close_stmts('ENDED', 1, 50, 9, operator_id=2, detail='d', new_sid=3)
    assert 'audit_events' in e[0].sql and e[0].params[:5] == (1, 9, 50, 2, 'END_SHIFT') and e[1].sql.startswith('UPDATE sessions SET ended_ts') and e[1].params == (50, 'ENDED', 1)
    assert e[2].sql.startswith('INSERT INTO sessions') and e[2].params == (3, 50, 1) and len(e) == 3                  # the audit row, then the close, then the new session
    for kind, row in (('CLEAN_SHUTDOWN', 'CLEAN_SHUTDOWN'), ('ABANDONED', 'SESSION_ABANDONED')):
        s = ses.close_stmts(kind, 1, 50, 9, detail='why')
        assert len(s) == 2 and 'system_events' in s[0].sql and s[0].params == (1, 9, 50, row, 'why') and s[1].params == (50, kind, 1)   # the system row, then the close, no new session
    for bad in (lambda: ses.close_stmts('NOPE', 1, 1, 1), lambda: ses.close_stmts('ENDED', 1, 1, 1, operator_id=1), lambda: ses.close_stmts('ENDED', 1, 1, 1, new_sid=2)):
        with pytest.raises(ValueError): bad()

def test_the_abandoned_close_at_start_up_still_writes_its_row_before_the_close_and_takes_one_event_seq(tmp_path):
    h = home(tmp_path); a = start(h); old = a.session_id; a.close(); b = start(h, dt=30 * MIN); r = sysrows(b, old)
    assert [(x[1], x[2]) for x in r][-1] == ('SESSION_ABANDONED', 'stale_30min') and r[-1][0] == r[-2][0] + 1
    assert b.conn.execute('SELECT end_kind FROM sessions WHERE session_id = ?', (old,)).fetchone()[0] == 'ABANDONED'; b.close()

# ---- the atomic unit ----
def test_an_atomic_unit_that_fails_is_rolled_back_whole_not_committed_row_by_row_and_the_queue_moves_on(tmp_path):
    c, w, clock, ing = rig(tmp_path); op(c, 1)
    c.execute("CREATE TRIGGER t_no_new BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'no new session'); END")
    u = ing.close_session('ENDED', 1, 'x', 2); assert w.wait(u, 2000) and u.failed and u.rejected == 1
    assert rows(c, 'SELECT session_id, ended_ts, end_kind FROM sessions') == [{'session_id': 1, 'ended_ts': None, 'end_kind': None}] and rows(c, "SELECT * FROM audit_events WHERE action = 'END_SHIFT'") == []
    assert w.counters['write_rejected'] == 1 and w.logging_fault
    ing.undo_end(1, 2); assert ing.session_id == 1
    r = send(ing, clock, pack(seq=1)); wait(w, r.unit); assert len(rows(c)) == 1; w.stop()      # a later unit commits normally

# ---- End shift ----
def test_end_shift_leaves_the_open_alert_and_episode_alone_opens_the_next_session_and_logs_the_open_list(tmp_path):
    c, w, clock, ing, p = eport(tmp_path); p.start_monitoring(1, 'night shift')
    r = send(ing, clock, pack(seq=1, flags=6)); wait(w, r.unit)
    sel = 'SELECT alert_id, episode_id, session_id, node_id, type, raised_ts, cleared_ts FROM alerts WHERE cleared_ts IS NULL ORDER BY alert_id'
    before, ep = rows(c, sel), rows(c, 'SELECT episode_id, session_id, node_id, state FROM episodes ORDER BY episode_id'); assert before and ep and ep[0]['state'] == 'OPEN'
    res = p.end_session(1, 1)
    assert (res.closed_session_id, res.new_session_id, res.backup_ok) == (1, 2, True) and ing.session_id == 2
    s = rows(c, 'SELECT session_id, ended_ts, end_kind, monitoring_active, mode, constants_hash FROM sessions ORDER BY session_id')
    assert (s[0]['end_kind'], s[0]['ended_ts'] is not None, s[1]['end_kind'], s[1]['ended_ts'], s[1]['monitoring_active']) == ('ENDED', True, None, None, 1)   # monitoring_active is carried
    assert (s[1]['mode'], s[1]['constants_hash']) == (s[0]['mode'], s[0]['constants_hash'])
    assert rows(c, sel) == before and rows(c, 'SELECT episode_id, session_id, node_id, state FROM episodes ORDER BY episode_id') == ep      # same ids, same session, no clone, nothing new
    a = rows(c, "SELECT * FROM audit_events WHERE action = 'END_SHIFT'"); assert len(a) == 1 and (a[0]['session_id'], a[0]['operator_id']) == (1, 1)
    d = json.loads(a[0]['reason']); assert d['open_alerts'] == [[1, 'man_down']] and d['open_episodes'] == [[ep[0]['episode_id'], 1, 'OPEN']] and d['latched_nodes'] == [1]
    r2 = send(ing, clock, pack(seq=2, flags=6)); wait(w, r2.unit)
    f = rows(c, 'SELECT session_id, event_seq FROM frames ORDER BY event_seq'); assert [x['session_id'] for x in f] == [1, 2] and f[0]['event_seq'] < a[0]['event_seq'] < f[1]['event_seq']   # event_seq goes on, not reset
    wait(w, ing.write([])); b = rows(c, "SELECT session_id, kind, detail FROM system_events WHERE kind IN ('BACKUP_OK', 'BACKUP_FAIL')")
    assert [(x['session_id'], x['kind']) for x in b] == [(2, 'BACKUP_OK')] and len(backups(tmp_path)) == 1 and bk.verify_backup(backups(tmp_path)[0]) == (True, 'ok') and b[0]['detail'] == backups(tmp_path)[0].name
    w.stop()

def test_end_shift_with_nothing_open_writes_an_empty_list(tmp_path):
    c, w, clock, ing, p = eport(tmp_path); res = p.end_session(1, 1); assert res.new_session_id == 2
    d = json.loads(rows(c, "SELECT reason FROM audit_events WHERE action = 'END_SHIFT'")[0]['reason']); assert d == {'open_alerts': [], 'open_episodes': [], 'latched_nodes': []}
    assert rows(c, 'SELECT monitoring_active FROM sessions WHERE session_id = 2') == [{'monitoring_active': 0}]; w.stop()

def test_a_second_end_shift_with_the_same_session_id_conflicts_and_makes_no_session_and_no_backup(tmp_path):   # End shift conflict test (Rev 3.25)
    c, w, clock, ing, p = eport(tmp_path); assert p.end_session(1, 1).new_session_id == 2
    assert err(lambda: p.end_session(1, 1)) == (409, 'STATE_CONFLICT') and err(lambda: p.end_session(99, 1)) == (409, 'STATE_CONFLICT')
    wait(w, ing.write([])); assert len(rows(c, 'SELECT * FROM sessions')) == 2 and len(backups(tmp_path)) == 1 and len(rows(c, "SELECT * FROM audit_events WHERE action = 'END_SHIFT'")) == 1; w.stop()

def test_end_shift_twice_in_a_row_with_the_new_id_works_and_chains_the_sessions(tmp_path):
    c, w, clock, ing, p = eport(tmp_path); assert p.end_session(1, 1).new_session_id == 2; clock.advance(2000); assert p.end_session(2, 1).new_session_id == 3
    assert [(x['session_id'], x['end_kind']) for x in rows(c, 'SELECT session_id, end_kind FROM sessions ORDER BY session_id')] == [(1, 'ENDED'), (2, 'ENDED'), (3, None)]; w.stop()

def test_a_rolled_back_end_shift_keeps_the_old_session_open_and_a_retry_works(tmp_path):
    c, w, clock, ing, p = eport(tmp_path); r = send(ing, clock, pack(seq=1, flags=6)); wait(w, r.unit)
    c.execute("CREATE TRIGGER t_no_new BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'no new session'); END")
    assert err(lambda: p.end_session(1, 1)) == (500, 'INTERNAL_ERROR') and ing.session_id == 1 and backups(tmp_path) == []
    assert rows(c, 'SELECT session_id, end_kind FROM sessions') == [{'session_id': 1, 'end_kind': None}] and rows(c, "SELECT * FROM audit_events WHERE action = 'END_SHIFT'") == []
    c.execute('DROP TRIGGER t_no_new'); assert p.end_session(1, 1).new_session_id == 2 and len(by_type(c, 'man_down')) == 1; w.stop()

def test_a_failed_backup_still_closes_the_shift_and_says_so(tmp_path, monkeypatch):
    c, w, clock, ing, p = eport(tmp_path)
    def boom(*a, **k): raise OSError('disk full')
    monkeypatch.setattr(bk, 'online_backup', boom); res = p.end_session(1, 1); wait(w, ing.write([]))
    assert (res.new_session_id, res.backup_ok) == (2, False) and rows(c, 'SELECT end_kind FROM sessions WHERE session_id = 1') == [{'end_kind': 'ENDED'}]
    assert rows(c, "SELECT session_id, kind, detail FROM system_events WHERE kind LIKE 'BACKUP%'") == [{'session_id': 2, 'kind': 'BACKUP_FAIL', 'detail': 'OSError: disk full'}]; w.stop()

def test_recovery_after_end_shift_finds_the_same_open_alert_and_episode_in_any_session(tmp_path):   # recovery across sessions (Rev 3.28)
    c, w, clock, ing, p = eport(tmp_path); r = send(ing, clock, pack(seq=1, flags=6)); wait(w, r.unit); p.end_session(1, 1); wait(w, ing.write([])); w.stop()
    o = load_open_state(sqlite3.connect(tmp_path / 't.db'))
    assert list(o.alerts) == [(1, 'man_down')] and list(o.episodes) == [1] and list(o.skipped) == []

# ---- CLEAN_SHUTDOWN ----
def runtime(tmp_path, dt=0):
    h = home(tmp_path); st = run(h, 'LIVE'); M.begin_session(st, FakeClock(NOW + dt, 5000))
    return h, st, Runtime(st, FakeClock(NOW + dt, 0), open_port=lambda: FakePort([])).start()

def test_a_clean_stop_closes_only_the_session_row_and_the_next_start_opens_a_new_session(tmp_path):
    h, st, rt = runtime(tmp_path); sid = st.session_id; rt.ingest.audit('LOGIN_OK'); rt.stop(clean=True); c = st.conn
    assert c.execute('SELECT end_kind, ended_ts FROM sessions WHERE session_id = ?', (sid,)).fetchone()[1] is not None
    last = c.execute('SELECT kind, event_seq FROM system_events WHERE session_id = ? ORDER BY event_seq DESC', (sid,)).fetchone(); assert last[0] == 'CLEAN_SHUTDOWN'
    assert c.execute('SELECT end_kind FROM sessions WHERE session_id = ?', (sid,)).fetchone()[0] == 'CLEAN_SHUTDOWN' and c.execute('SELECT COUNT(*) FROM sessions WHERE ended_ts IS NULL').fetchone()[0] == 0
    assert c.execute("SELECT COUNT(*) FROM system_events WHERE kind = 'SESSION_ABANDONED'").fetchone()[0] == 0; st.close()
    b = start(h, dt=MIN); assert not b.resumed and b.session_id != sid and b.event_seq > last[1]; b.close()

def test_a_stop_that_is_not_clean_leaves_the_session_open_and_the_next_start_resumes_it(tmp_path):
    h, st, rt = runtime(tmp_path); sid = st.session_id; rt.stop(); c = st.conn
    assert c.execute('SELECT end_kind FROM sessions WHERE session_id = ?', (sid,)).fetchone()[0] is None and c.execute("SELECT COUNT(*) FROM system_events WHERE kind = 'CLEAN_SHUTDOWN'").fetchone()[0] == 0; st.close()
    b = start(h, dt=MIN); assert b.resumed and b.session_id == sid; b.close()

def test_main_closes_the_session_clean_when_the_server_returns_and_leaves_it_open_when_the_server_fails(tmp_path):
    from test_startup import no_serve
    h = home(tmp_path)
    async def bad_serve(rt, host, port): raise M.ServeError('port in use')
    def last():
        c = sqlite3.connect(next(h.rglob('ppe.db'))); r = c.execute('SELECT end_kind FROM sessions ORDER BY session_id DESC LIMIT 1').fetchone()[0]; c.close(); return r
    assert M.main(['--home', str(h)], serve=no_serve) == 0 and last() == 'CLEAN_SHUTDOWN'
    assert M.main(['--home', str(h)], serve=bad_serve) == M.EXIT_CONFIG and last() is None      # a start that failed at step 10 is not a clean shutdown: the session stays open and resumes
