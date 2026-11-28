"""S7-5a (ADR 0061): the Pause control of a REPLAY host, on the host side. POST /api/replay/pause, HostPort.replay_set_paused, the replay block of the snapshot and the system message,
the guard of ReplayThread.resume, migration 0004 (REPLAY_PAUSE and REPLAY_RESUME), and a real REPLAY host paused and resumed through the real route. Requirements: REQ-API-002, REQ-API-005, REQ-API-007."""
import asyncio, shutil, threading
from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient
from ppe_host import serve as S
from ppe_host.api import api_rest as AR, models as M, security as sec
from ppe_host.clock import FakeClock, ScaledClock
from ppe_host.io.db_writer import applied_versions, connect_db, run_migrations
from ppe_host.services import replay as RP
from test_host_port import port as host_port, settle
from test_migration_0003 import MIG, operator, rejects
from test_replay import T0, make_source, replay_runtime, wait_for, wait_polls, rows
from test_startup import home
from test_wire import got
from test_wire_2b1 import wired

URL, GOOD = 'http://127.0.0.1:8420', {'Authorization': 'Bearer good'}

# ---- the route, with a fake port ----
class FakePort:
    def __init__(self): self.audits, self.calls, self.paused, self.finished, self.replaying, self.recovering = [], [], False, False, True, None
    def authenticate(self, t): return AR.Operator(1, 'Ana') if t == 'good' else None
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append((action, operator_id))
    def session_id(self): return 1
    def login_failed(self): return None
    def login_ok(self): pass
    def recovering_retry_s(self): return self.recovering
    def replay_set_paused(self, paused):
        self.calls.append(paused)
        if not self.replaying: raise AR.ApiError(409, 'STATE_CONFLICT', 'this host is not replaying a session')
        if self.finished: raise AR.ApiError(409, 'STATE_CONFLICT', 'the replay has finished')
        changed = self.paused != paused; self.paused = paused; return AR.ReplayState(paused, False, changed)
@pytest.fixture
def api(): p = FakePort(); return TestClient(AR.create_app(p, 'x.db'), base_url=URL, raise_server_exceptions=False), p
def post(c, body, headers=GOOD): return c.post('/api/replay/pause', json=body, headers=headers)

def test_pause_then_resume_answers_the_state_and_writes_one_audit_row_each(api):
    c, p = api
    r = post(c, {'paused': True}); assert (r.status_code, r.json()) == (200, {'paused': True, 'finished': False}) and p.audits == [('REPLAY_PAUSE', 1)]
    r = post(c, {'paused': False}); assert (r.status_code, r.json()) == (200, {'paused': False, 'finished': False}) and p.audits == [('REPLAY_PAUSE', 1), ('REPLAY_RESUME', 1)]

def test_asking_for_the_state_it_already_has_changes_nothing_and_writes_no_row(api):
    c, p = api
    assert post(c, {'paused': False}).json()['paused'] is False and p.audits == []           # not paused, resume asked: no row
    post(c, {'paused': True}); post(c, {'paused': True}); post(c, {'paused': True})            # a double click and a retry
    assert p.audits == [('REPLAY_PAUSE', 1)] and p.calls == [False, True, True, True]

def test_a_recovering_host_answers_409_recovering_with_the_retry_delay_and_is_not_touched(api):
    c, p = api; p.recovering = 3.0; r = post(c, {'paused': True})
    assert (r.status_code, r.json()['error_code'], r.json()['retry_after_s']) == (409, 'RECOVERING', 3.0) and p.calls == [] and p.audits == []

def test_a_host_that_is_not_replaying_and_a_finished_replay_answer_409_state_conflict_without_a_row(api):
    c, p = api; p.replaying = False; r = post(c, {'paused': True})
    assert (r.status_code, r.json()['error_code'], r.json()['retry_after_s']) == (409, 'STATE_CONFLICT', None)
    p.replaying, p.finished = True, True; r = post(c, {'paused': False}); assert (r.status_code, r.json()['error_code']) == (409, 'STATE_CONFLICT') and p.audits == []

def test_no_token_a_wrong_token_and_a_foreign_origin_never_reach_the_port(api):
    c, p = api
    assert post(c, {'paused': True}, {}).status_code == 401 and post(c, {'paused': True}, {'Authorization': 'Bearer nope'}).status_code == 401
    assert post(c, {'paused': True}, {**GOOD, 'Origin': 'http://evil.example'}).status_code == 403 and p.calls == [] and not [a for a in p.audits if a[0].startswith('REPLAY')]      # the rejections themselves are audited (LOGIN_REJECTED, ORIGIN_REJECTED)

@pytest.mark.parametrize('body', [{}, {'paused': 'maybe'}, {'paused': None}, {'paused': True, 'speed': 4}, [True]])
def test_a_body_without_a_boolean_paused_is_422_and_changes_nothing(api, body):
    c, p = api; r = post(c, body); assert (r.status_code, r.json()['error_code']) == (422, 'VALIDATION_ERROR') and p.calls == []

def test_get_on_the_route_is_not_served(api):
    c, p = api; assert c.get('/api/replay/pause', headers=GOOD).status_code in (404, 405)

# ---- HostPort.replay_set_paused ----
class FakeReplay:
    def __init__(self): self.paused, self.finished, self.log = False, threading.Event(), []
    def pause(self): self.paused = True; self.log.append('pause')
    def resume(self): self.paused = False; self.log.append('resume')

def test_a_host_that_is_not_replaying_refuses_with_state_conflict(tmp_path):
    c, w, clock, ing, p = host_port(tmp_path)
    with pytest.raises(AR.ApiError) as e: p.replay_set_paused(True)
    assert (e.value.status, e.value.env.error_code) == (409, 'STATE_CONFLICT'); w.stop()

def test_pause_and_resume_go_to_the_replay_once_each_and_tell_the_wire_only_on_a_change(tmp_path):
    c, w, clock, ing, p = host_port(tmp_path); p.replay = FakeReplay(); told = []; p.wire = SimpleNamespace(on_replay_changed=lambda: told.append(1))
    assert p.replay_set_paused(True) == AR.ReplayState(True, False, True) and told == [1]
    assert p.replay_set_paused(True) == AR.ReplayState(True, False, False) and told == [1] and p.replay.log == ['pause']
    assert p.replay_set_paused(False) == AR.ReplayState(False, False, True) and told == [1, 1] and p.replay.log == ['pause', 'resume']
    assert p.replay_set_paused(False).changed is False and p.replay.log == ['pause', 'resume']; w.stop()

def test_a_finished_replay_is_not_touched_either_way(tmp_path):
    c, w, clock, ing, p = host_port(tmp_path); p.replay = FakeReplay(); p.replay.finished.set()
    for want in (True, False):
        with pytest.raises(AR.ApiError) as e: p.replay_set_paused(want)
        assert e.value.env.error_code == 'STATE_CONFLICT'
    assert p.replay.log == []; w.stop()

def test_the_two_new_audit_actions_are_accepted_by_the_writer_in_order(tmp_path):
    c, w, clock, ing, p = host_port(tmp_path); p.audit('REPLAY_PAUSE', operator_id=1); p.audit('REPLAY_RESUME', operator_id=1); settle(w, ing)
    a = c.execute("SELECT action, operator_id FROM audit_events WHERE action LIKE 'REPLAY_%' ORDER BY event_seq").fetchall()
    assert [tuple(x) for x in a] == [('REPLAY_PAUSE', 1), ('REPLAY_RESUME', 1)] and w.counters['write_rejected'] == 0; w.stop()

# ---- the wire: snapshot and system message ----
def sys_msgs(h): return got(h, 'system')

def test_a_host_that_is_not_replaying_sends_replay_null_in_the_snapshot_and_the_system_message(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); assert wire.snapshot()['replay'] is None
    b = wire._sys_body(); assert b['replay'] is None; assert M.parse_server(dict(b, v=1, type='system', srv_seq=0, srv_ts=1)).replay is None; w.stop()      # attach() makes the first state no news: no message yet

def test_a_replaying_host_puts_speed_paused_and_finished_in_the_snapshot(tmp_path):
    state = dict(speed=4, paused=False, finished=False); c, w, clock, ing, p, h, wire = wired(tmp_path, replay=lambda: dict(state))
    assert wire.snapshot()['replay'] == dict(speed=4, paused=False, finished=False)
    state.update(paused=True); assert wire.snapshot()['replay'] == dict(speed=4, paused=True, finished=False); w.stop()

def test_a_pause_or_resume_is_one_system_message_at_once_and_a_repeat_is_none(tmp_path):
    state = dict(speed=16, paused=False, finished=False); c, w, clock, ing, p, h, wire = wired(tmp_path, replay=lambda: dict(state)); wire.tick(); n = len(sys_msgs(h))
    state['paused'] = True; wire.on_replay_changed(); m = sys_msgs(h); assert len(m) == n + 1 and m[-1]['replay'] == dict(speed=16, paused=True, finished=False)
    wire.on_replay_changed(); wire.tick(); assert len(sys_msgs(h)) == n + 1                      # nothing changed since
    state['paused'] = False; wire.on_replay_changed(); m = sys_msgs(h); assert len(m) == n + 2 and m[-1]['replay']['paused'] is False; w.stop()

def test_the_end_of_the_data_reaches_the_dashboard_with_the_next_tick(tmp_path):
    state = dict(speed=1, paused=False, finished=False); c, w, clock, ing, p, h, wire = wired(tmp_path, replay=lambda: dict(state)); wire.tick(); n = len(sys_msgs(h))
    state.update(paused=True, finished=True); wire.tick(); m = sys_msgs(h); assert len(m) == n + 1 and m[-1]['replay'] == dict(speed=1, paused=True, finished=True); w.stop()

def test_the_replay_block_is_checked_by_the_models_and_refuses_a_bad_speed():
    assert M.ReplayInfo(speed=16, paused=False, finished=True).speed == 16
    for bad in (dict(speed=0, paused=False, finished=False), dict(speed=1, paused='x', finished=False), dict(speed=1, paused=False)):
        with pytest.raises(Exception): M.ReplayInfo(**bad)

# ---- ReplayThread.resume ----
def idle_thread(tmp_path):
    h = home(tmp_path); db = make_source(h, 'quiet', 5); return RP.ReplayThread(ScaledClock(FakeClock(T0, 0), 4), lambda k, p: None, db, 1)

def test_resume_does_nothing_on_a_replay_that_has_finished(tmp_path):
    th = idle_thread(tmp_path); th.finished.set(); th.clock.pause(); th.resume(); assert th.paused

def test_a_resume_that_races_with_the_end_of_the_data_is_undone(tmp_path):
    th = idle_thread(tmp_path); real = th.clock.resume
    def racing(): real(); th.finished.set()                                                      # the thread finishes just after the clock restarted
    th.clock.resume = racing; th.clock.pause(); th.resume(); assert th.finished.is_set() and th.paused

def test_resume_on_a_running_replay_restarts_the_clock(tmp_path):
    th = idle_thread(tmp_path); th.pause(); assert th.paused; th.resume(); assert not th.paused

# ---- migration 0004 ----
def test_0004_adds_exactly_the_two_audit_actions_and_changes_no_table(tmp_path):
    old = tmp_path / 'm3'; old.mkdir()
    for n in ('0001', '0002', '0003'): shutil.copy(MIG / (n + '.sql'), old / (n + '.sql'))
    a = connect_db(tmp_path / 'a.db'); run_migrations(a, str(old), 1)
    up = tmp_path / 'm4'; up.mkdir()                                                             # S7-7a added 0005: this test looks at 0004 alone
    for n in ('0001', '0002', '0003', '0004'): shutil.copy(MIG / (n + '.sql'), up / (n + '.sql'))
    b = connect_db(tmp_path / 'b.db'); run_migrations(b, str(up), 1)
    sql = lambda c: sorted(r[0] or '' for r in c.execute('SELECT sql FROM sqlite_master'))
    assert sql(a) == sql(b) and applied_versions(b) == [1, 2, 3, 4] and b.execute('SELECT description FROM schema_version WHERE version = 4').fetchone()[0].startswith('Migration 0004')
    new = {r[0] for r in b.execute('SELECT action FROM audit_actions')} - {r[0] for r in a.execute('SELECT action FROM audit_actions')}
    assert new == {'REPLAY_PAUSE', 'REPLAY_RESUME'} and b.execute('SELECT COUNT(*) FROM audit_actions').fetchone()[0] == 23 and run_migrations(b, str(up), 9) == []

def test_a_version_3_database_is_upgraded_keeps_its_rows_and_then_accepts_the_new_actions(tmp_path):
    old = tmp_path / 'm3'; old.mkdir()
    for n in ('0001', '0002', '0003'): shutil.copy(MIG / (n + '.sql'), old / (n + '.sql'))
    c = connect_db(tmp_path / 'old.db'); assert run_migrations(c, str(old), 1) == [1, 2, 3]; operator(c)
    ins = lambda act, ts: c.execute('INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action) VALUES (NULL, 0, ?, 1, ?)', (ts, act))
    ins('PIN_SET', 5); rejects(lambda: ins('REPLAY_PAUSE', 6))                                    # not an action yet
    assert run_migrations(c, str(MIG), 2) == [4, 5] and applied_versions(c) == [1, 2, 3, 4, 5]
    ins('REPLAY_PAUSE', 7); ins('REPLAY_RESUME', 8)
    assert [r[0] for r in c.execute('SELECT action FROM audit_events ORDER BY ts')] == ['PIN_SET', 'REPLAY_PAUSE', 'REPLAY_RESUME'] and c.execute('SELECT display_name FROM operators').fetchone()[0] == 'Ana'

# ---- a real REPLAY host, paused and resumed through the real route ----
class Rec:
    """Wraps the real LoopHub: it records every system message, checks it against the models, and passes everything on."""
    def __init__(self, real): self.real, self.sent = real, []
    def publish_system(self, b): M.parse_server(dict(b, v=1, type='system', srv_seq=0, srv_ts=1)); self.sent.append(b); self.real.publish_system(b)
    def __getattr__(self, name): return getattr(self.real, name)

def test_a_real_replay_host_stops_on_pause_goes_on_after_resume_and_logs_both(tmp_path):
    h, db, st, rt, base = replay_runtime(tmp_path, speed=16, scenario='quiet', seconds=30)
    salt = sec.load_or_create_salt(st.settings.home, True); c = connect_db(st.db_path)
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (1, 'Ana', ?, 1, 1)", (sec.hash_token(salt, 'tok'),)); c.close()
    H = {'Authorization': 'Bearer tok'}
    def pump(n):
        for _ in range(n): base.advance(500); wait_polls(rt.replay)
    rt.start()
    try:
        app, hub = S.build_app(rt, asyncio.new_event_loop()); rec = Rec(rt.wire.hub); rt.wire.hub = rec
        client = TestClient(app, base_url=URL, raise_server_exceptions=False)
        r = client.post('/api/replay/pause', json={'paused': True}, headers=H)                    # the host is still recovering: the replay has not started
        assert (r.status_code, r.json()['error_code']) == (409, 'RECOVERING') and not rt.replay.paused
        rt.release(); rt.port.recovering = False; wait_polls(rt.replay); pump(1); wait_for(lambda: rt.replay.counters['replay_frames'] > 0)      # the first poll after the gate went live is time 0
        r = client.post('/api/replay/pause', json={'paused': True}, headers=H); assert (r.status_code, r.json()) == (200, {'paused': True, 'finished': False}) and rt.replay.paused
        assert rec.sent[-1]['replay'] == dict(speed=16, paused=True, finished=False) and rec.sent[-1]['session_mode'] == 'REPLAY'
        frames, wall = rt.replay.counters['replay_frames'], rt.clock.wall_ms(); pump(6)
        assert rt.replay.counters['replay_frames'] == frames and rt.clock.wall_ms() == wall and not rt.replay.finished.is_set()      # nothing moved while paused
        assert client.post('/api/replay/pause', json={'paused': True}, headers=H).json()['paused'] is True
        r = client.post('/api/replay/pause', json={'paused': False}, headers=H); assert (r.status_code, r.json()) == (200, {'paused': False, 'finished': False}) and not rt.replay.paused
        assert rec.sent[-1]['replay']['paused'] is False
        for _ in range(60):
            if rt.replay.finished.is_set(): break
            pump(1)
        assert rt.replay.finished.is_set() and rt.replay.counters['replay_frames'] > frames
        rt.tick(); assert rec.sent[-1]['replay'] == dict(speed=16, paused=True, finished=True)       # the end of the data, with the next tick
        r = client.post('/api/replay/pause', json={'paused': False}, headers=H); assert (r.status_code, r.json()['error_code']) == (409, 'STATE_CONFLICT') and rt.replay.paused
        sql = "SELECT action, operator_id FROM audit_events WHERE action LIKE 'REPLAY_%' ORDER BY event_seq"
        wait_for(lambda: len(rows(st.db_path, sql)) == 2); assert rows(st.db_path, sql) == [('REPLAY_PAUSE', 1), ('REPLAY_RESUME', 1)]       # one row per change, none for the repeat or the refusals
    finally: rt.stop(); st.close()

def test_a_simulator_host_refuses_the_route_with_state_conflict(tmp_path):
    from test_serve import started
    st, rt = started(tmp_path, 'SIMULATOR'); salt = sec.load_or_create_salt(st.settings.home, True); c = connect_db(st.db_path)
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (1, 'Ana', ?, 1, 1)", (sec.hash_token(salt, 'tok'),)); c.close(); rt.start()
    try:
        app, hub = S.build_app(rt, asyncio.new_event_loop()); rt.port.recovering = False; assert rt.replay is None and rt.replay_info() is None and rt.port.replay is None
        r = TestClient(app, base_url=URL, raise_server_exceptions=False).post('/api/replay/pause', json={'paused': True}, headers={'Authorization': 'Bearer tok'})
        assert (r.status_code, r.json()['error_code']) == (409, 'STATE_CONFLICT')
    finally: rt.stop(); st.close()
