"""S7-7a (ADR 0064): the speed control of a REPLAY host, on the host side. ScaledClock.set_speed (a re-base, no jump), ReplayThread.set_speed, HostPort.replay_set_speed,
POST /api/replay/speed, the replay block of the system message, migration 0005 (REPLAY_SPEED), and a real REPLAY host whose speed is changed through the real route while it runs and while it is paused.
Requirements: REQ-API-002, REQ-API-005, REQ-API-007."""
import asyncio, shutil
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
from test_replay import replay_runtime, wait_for, wait_polls, rows
from test_replay_pause import FakePort as PausePort, FakeReplay as PauseReplay, Rec, URL, GOOD, idle_thread
from test_wire import got
from test_wire_2b1 import wired

# ---- ScaledClock.set_speed ----
def test_a_new_speed_counts_from_now_and_time_does_not_jump():
    b = FakeClock(5000, 700); c = ScaledClock(b, 1); b.advance(1000); assert (c.wall_ms(), c.mono_ms()) == (6000, 1700)
    c.set_speed(16); assert (c.wall_ms(), c.mono_ms(), c.speed) == (6000, 1700, 16)           # the same instant: no step
    b.advance(1000); assert (c.wall_ms(), c.mono_ms()) == (6000 + 16000, 1700 + 16000)       # then 16 times as fast
    c.set_speed(4); assert c.mono_ms() == 1700 + 16000; b.advance(1000); assert c.mono_ms() == 1700 + 16000 + 4000

def test_slowing_down_never_runs_backwards_and_every_step_is_in_order():
    b = FakeClock(0, 0); c = ScaledClock(b, 16); seen = []
    for sp in (16, 4, 1, 16, 1):
        c.set_speed(sp); seen.append(c.mono_ms()); b.advance(250); seen.append(c.mono_ms())
    assert seen == sorted(seen) and seen[-1] > 0 and c.wall_ms() - 0 == c.mono_ms()

def test_a_paused_clock_takes_the_new_speed_and_counts_it_from_the_resume():
    b = FakeClock(0, 0); c = ScaledClock(b, 1); b.advance(1000); c.pause(); c.set_speed(16); assert (c.mono_ms(), c.speed, c.paused) == (1000, 16, True)
    b.advance(5000); assert c.mono_ms() == 1000                                                 # still frozen
    c.resume(); assert c.mono_ms() == 1000; b.advance(1000); assert c.mono_ms() == 1000 + 16000

def test_the_same_speed_again_changes_nothing():
    b = FakeClock(0, 0); c = ScaledClock(b, 4); b.advance(1000); c.set_speed(4); c.set_speed(4); assert c.mono_ms() == 4000; b.advance(1000); assert c.mono_ms() == 8000

@pytest.mark.parametrize('bad', [0, -1, True, False, '4', None, float('nan')])
def test_a_bad_speed_is_refused_and_the_clock_is_untouched(bad):
    b = FakeClock(0, 0); c = ScaledClock(b, 4)
    with pytest.raises(ValueError): c.set_speed(bad)
    assert c.speed == 4; b.advance(1000); assert c.mono_ms() == 4000

# ---- ReplayThread.set_speed ----
@pytest.mark.parametrize('sp', RP.SPEEDS)
def test_the_thread_takes_each_of_the_three_speeds(tmp_path, sp):
    th = idle_thread(tmp_path); th.set_speed(sp); assert th.speed == sp and th.clock.speed == sp

@pytest.mark.parametrize('bad', [0, 2, 8, 32, True, '4', None, 4.5])
def test_the_thread_refuses_any_other_speed(tmp_path, bad):
    th = idle_thread(tmp_path)
    with pytest.raises(ValueError): th.set_speed(bad)
    assert th.speed == 4

def test_a_paused_thread_takes_the_speed_and_stays_paused(tmp_path):
    th = idle_thread(tmp_path); th.pause(); th.set_speed(16); assert th.speed == 16 and th.paused

def test_a_finished_replay_keeps_its_speed(tmp_path):
    th = idle_thread(tmp_path); th.finished.set(); th.clock.pause(); th.set_speed(16); assert th.speed == 4 and th.paused

# ---- the route, with a fake port ----
class FakePort(PausePort):
    def __init__(self): super().__init__(); self.speed, self.reasons, self.speed_calls = 1, [], []
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): super().audit(action, operator_id); self.reasons.append((action, reason))
    def replay_set_speed(self, speed):
        self.speed_calls.append(speed)
        if not self.replaying: raise AR.ApiError(409, 'STATE_CONFLICT', 'this host is not replaying a session')
        if self.finished: raise AR.ApiError(409, 'STATE_CONFLICT', 'the replay has finished')
        before = self.speed; self.speed = speed; return AR.ReplaySpeedState(speed, before, self.paused, False, before != speed)
@pytest.fixture
def api(): p = FakePort(); return TestClient(AR.create_app(p, 'x.db'), base_url=URL, raise_server_exceptions=False), p
def post(c, body, headers=GOOD): return c.post('/api/replay/speed', json=body, headers=headers)

def test_a_change_answers_the_state_and_writes_one_audit_row_with_both_speeds(api):
    c, p = api
    r = post(c, {'speed': 4}); assert (r.status_code, r.json()) == (200, {'speed': 4, 'paused': False, 'finished': False}) and p.audits == [('REPLAY_SPEED', 1)] and p.reasons == [('REPLAY_SPEED', '1x to 4x')]
    r = post(c, {'speed': 16}); assert r.json()['speed'] == 16 and p.reasons[-1] == ('REPLAY_SPEED', '4x to 16x') and len(p.audits) == 2

def test_the_speed_it_already_has_changes_nothing_and_writes_no_row(api):
    c, p = api
    assert post(c, {'speed': 1}).json()['speed'] == 1 and p.audits == []                      # the replay runs at 1x: no row
    post(c, {'speed': 4}); post(c, {'speed': 4}); post(c, {'speed': 4})                          # a double click and a retry
    assert p.audits == [('REPLAY_SPEED', 1)] and p.speed_calls == [1, 4, 4, 4]

def test_a_paused_replay_answers_paused_true_with_the_new_speed(api):
    c, p = api; p.paused = True; r = post(c, {'speed': 16}); assert (r.status_code, r.json()) == (200, {'speed': 16, 'paused': True, 'finished': False})

def test_a_recovering_host_answers_409_recovering_with_the_retry_delay_and_is_not_touched(api):
    c, p = api; p.recovering = 3.0; r = post(c, {'speed': 4})
    assert (r.status_code, r.json()['error_code'], r.json()['retry_after_s']) == (409, 'RECOVERING', 3.0) and p.speed_calls == [] and p.audits == []

def test_a_host_that_is_not_replaying_and_a_finished_replay_answer_409_state_conflict_without_a_row(api):
    c, p = api; p.replaying = False; r = post(c, {'speed': 4})
    assert (r.status_code, r.json()['error_code'], r.json()['retry_after_s']) == (409, 'STATE_CONFLICT', None)
    p.replaying, p.finished = True, True; r = post(c, {'speed': 16}); assert (r.status_code, r.json()['error_code']) == (409, 'STATE_CONFLICT') and p.audits == []

def test_no_token_a_wrong_token_and_a_foreign_origin_never_reach_the_port(api):
    c, p = api
    assert post(c, {'speed': 4}, {}).status_code == 401 and post(c, {'speed': 4}, {'Authorization': 'Bearer nope'}).status_code == 401
    assert post(c, {'speed': 4}, {**GOOD, 'Origin': 'http://evil.example'}).status_code == 403 and p.speed_calls == [] and not [a for a in p.audits if a[0] == 'REPLAY_SPEED']

@pytest.mark.parametrize('body', [{}, {'speed': 2}, {'speed': 0}, {'speed': 32}, {'speed': -4}, {'speed': '4'}, {'speed': 4.0}, {'speed': True}, {'speed': None}, {'speed': 4, 'paused': True}, [4]])
def test_a_body_without_a_speed_of_1_4_or_16_is_422_and_changes_nothing(api, body):
    c, p = api; r = post(c, body); assert (r.status_code, r.json()['error_code']) == (422, 'VALIDATION_ERROR') and p.speed_calls == []

def test_get_on_the_route_is_not_served_and_the_pause_route_still_ignores_a_speed(api):
    c, p = api; assert c.get('/api/replay/speed', headers=GOOD).status_code in (404, 405)
    assert c.post('/api/replay/pause', json={'paused': True, 'speed': 4}, headers=GOOD).status_code == 422          # one control, one route

def test_the_speeds_of_the_model_are_the_speeds_of_the_replay():
    for sp in RP.SPEEDS: assert M.ReplaySpeedReq(speed=sp).speed == sp
    assert set(M.ReplaySpeedReq.model_fields['speed'].annotation.__args__) == set(RP.SPEEDS)

# ---- HostPort.replay_set_speed ----
class FakeReplay(PauseReplay):
    def __init__(self): super().__init__(); self.speed = 1
    def set_speed(self, sp): self.speed = sp; self.log.append(sp)

def test_a_host_that_is_not_replaying_refuses_with_state_conflict(tmp_path):
    c, w, clock, ing, p = host_port(tmp_path)
    with pytest.raises(AR.ApiError) as e: p.replay_set_speed(4)
    assert (e.value.status, e.value.env.error_code) == (409, 'STATE_CONFLICT'); w.stop()

def test_a_speed_goes_to_the_replay_once_and_tells_the_wire_only_on_a_change(tmp_path):
    c, w, clock, ing, p = host_port(tmp_path); p.replay = FakeReplay(); told = []; p.wire = SimpleNamespace(on_replay_changed=lambda: told.append(1))
    assert p.replay_set_speed(4) == AR.ReplaySpeedState(4, 1, False, False, True) and told == [1]
    assert p.replay_set_speed(4) == AR.ReplaySpeedState(4, 4, False, False, False) and told == [1] and p.replay.log == [4]
    assert p.replay_set_speed(16) == AR.ReplaySpeedState(16, 4, False, False, True) and told == [1, 1] and p.replay.log == [4, 16]
    assert p.replay_set_speed(1).previous == 16 and p.replay.log == [4, 16, 1]; w.stop()

def test_a_paused_replay_takes_a_speed_and_is_reported_paused(tmp_path):
    c, w, clock, ing, p = host_port(tmp_path); p.replay = FakeReplay(); p.replay.paused = True
    assert p.replay_set_speed(16) == AR.ReplaySpeedState(16, 1, True, False, True) and p.replay.log == [16]; w.stop()

def test_a_finished_replay_is_not_touched(tmp_path):
    c, w, clock, ing, p = host_port(tmp_path); p.replay = FakeReplay(); p.replay.finished.set()
    for want in (4, 1):
        with pytest.raises(AR.ApiError) as e: p.replay_set_speed(want)
        assert e.value.env.error_code == 'STATE_CONFLICT'
    assert p.replay.log == []; w.stop()

def test_the_new_audit_action_is_accepted_by_the_writer_with_its_reason(tmp_path):
    c, w, clock, ing, p = host_port(tmp_path); p.audit('REPLAY_SPEED', operator_id=1, reason='1x to 4x'); settle(w, ing)
    a = c.execute("SELECT action, operator_id, reason FROM audit_events WHERE action = 'REPLAY_SPEED'").fetchall()
    assert [tuple(x) for x in a] == [('REPLAY_SPEED', 1, '1x to 4x')] and w.counters['write_rejected'] == 0; w.stop()

# ---- the wire ----
def test_a_speed_change_is_one_system_message_at_once_and_a_repeat_is_none(tmp_path):
    state = dict(speed=1, paused=False, finished=False); c, w, clock, ing, p, h, wire = wired(tmp_path, replay=lambda: dict(state)); wire.tick(); n = len(got(h, 'system'))
    state['speed'] = 16; wire.on_replay_changed(); m = got(h, 'system'); assert len(m) == n + 1 and m[-1]['replay'] == dict(speed=16, paused=False, finished=False)
    wire.on_replay_changed(); wire.tick(); assert len(got(h, 'system')) == n + 1
    state.update(speed=4, paused=True); wire.on_replay_changed(); m = got(h, 'system'); assert len(m) == n + 2 and m[-1]['replay'] == dict(speed=4, paused=True, finished=False)
    assert wire.snapshot()['replay'] == dict(speed=4, paused=True, finished=False); w.stop()

# ---- migration 0005 ----
def test_0005_adds_exactly_one_audit_action_and_changes_no_table(tmp_path):
    old = tmp_path / 'm4'; old.mkdir()
    for n in ('0001', '0002', '0003', '0004'): shutil.copy(MIG / (n + '.sql'), old / (n + '.sql'))
    a = connect_db(tmp_path / 'a.db'); run_migrations(a, str(old), 1)
    m5 = tmp_path / 'm5'; m5.mkdir(); [shutil.copy(MIG / (n + '.sql'), m5 / (n + '.sql')) for n in ('0001', '0002', '0003', '0004', '0005')]     # S8-1 added 0006: this test is about 0005 only
    b = connect_db(tmp_path / 'b.db'); run_migrations(b, str(m5), 1)
    sql = lambda c: sorted(r[0] or '' for r in c.execute('SELECT sql FROM sqlite_master'))
    assert sql(a) == sql(b) and applied_versions(b) == [1, 2, 3, 4, 5] and b.execute('SELECT description FROM schema_version WHERE version = 5').fetchone()[0].startswith('Migration 0005')
    new = {r[0] for r in b.execute('SELECT action FROM audit_actions')} - {r[0] for r in a.execute('SELECT action FROM audit_actions')}
    assert new == {'REPLAY_SPEED'} and b.execute('SELECT COUNT(*) FROM audit_actions').fetchone()[0] == 24 and run_migrations(b, str(m5), 9) == []

def test_a_version_4_database_is_upgraded_keeps_its_rows_and_then_accepts_the_new_action(tmp_path):
    old = tmp_path / 'm4'; old.mkdir()
    for n in ('0001', '0002', '0003', '0004'): shutil.copy(MIG / (n + '.sql'), old / (n + '.sql'))
    c = connect_db(tmp_path / 'old.db'); assert run_migrations(c, str(old), 1) == [1, 2, 3, 4]; operator(c)
    ins = lambda act, ts: c.execute('INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action) VALUES (NULL, 0, ?, 1, ?)', (ts, act))
    ins('REPLAY_PAUSE', 5); rejects(lambda: ins('REPLAY_SPEED', 6))                                # not an action yet
    assert run_migrations(c, str(MIG), 2) == [5, 6, 7] and applied_versions(c) == [1, 2, 3, 4, 5, 6, 7]
    ins('REPLAY_SPEED', 7); assert [r[0] for r in c.execute('SELECT action FROM audit_events ORDER BY ts')] == ['REPLAY_PAUSE', 'REPLAY_SPEED'] and c.execute('SELECT display_name FROM operators').fetchone()[0] == 'Ana'

# ---- a real REPLAY host: speed changed through the real route, running and paused ----
def test_a_real_replay_host_changes_speed_without_a_jump_also_while_paused_and_logs_each_change(tmp_path):
    h, db, st, rt, base = replay_runtime(tmp_path, speed=1, scenario='quiet', seconds=30)
    salt = sec.load_or_create_salt(st.settings.home, True); c = connect_db(st.db_path)
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (1, 'Ana', ?, 1, 1)", (sec.hash_token(salt, 'tok'),)); c.close()
    H = {'Authorization': 'Bearer tok'}
    def pump(n):
        for _ in range(n): base.advance(500); wait_polls(rt.replay)
    rt.start()
    try:
        app, hub = S.build_app(rt, asyncio.new_event_loop()); rec = Rec(rt.wire.hub); rt.wire.hub = rec
        client = TestClient(app, base_url=URL, raise_server_exceptions=False)
        r = client.post('/api/replay/speed', json={'speed': 4}, headers=H)                         # the host is still recovering: the replay has not started
        assert (r.status_code, r.json()['error_code']) == (409, 'RECOVERING') and rt.replay.speed == 1
        rt.release(); rt.port.recovering = False; wait_polls(rt.replay); pump(2); wait_for(lambda: rt.replay.counters['replay_frames'] > 0)
        assert rt.replay_info() == dict(speed=1, paused=False, finished=False); before = rt.clock.wall_ms()
        r = client.post('/api/replay/speed', json={'speed': 16}, headers=H); assert (r.status_code, r.json()) == (200, {'speed': 16, 'paused': False, 'finished': False})
        assert rt.clock.wall_ms() == before and rt.replay_info()['speed'] == 16                      # no step of the replay clock
        assert rec.sent[-1]['replay'] == dict(speed=16, paused=False, finished=False) and rec.sent[-1]['session_mode'] == 'REPLAY'
        pump(1); assert rt.clock.wall_ms() - before == 8000                                           # 500 ms of real time are now 8 s of source time
        assert client.post('/api/replay/speed', json={'speed': 16}, headers=H).json()['speed'] == 16        # a repeat: no row, no message
        n = len(rec.sent); client.post('/api/replay/speed', json={'speed': 16}, headers=H); assert len(rec.sent) == n
        r = client.post('/api/replay/pause', json={'paused': True}, headers=H); assert r.json()['paused'] is True
        r = client.post('/api/replay/speed', json={'speed': 4}, headers=H); assert (r.status_code, r.json()) == (200, {'speed': 4, 'paused': True, 'finished': False})
        frozen = rt.clock.wall_ms(); pump(4); assert rt.clock.wall_ms() == frozen and rec.sent[-1]['replay'] == dict(speed=4, paused=True, finished=False)       # still frozen
        client.post('/api/replay/pause', json={'paused': False}, headers=H); pump(1); assert rt.clock.wall_ms() - frozen == 2000                          # then 4x
        client.post('/api/replay/speed', json={'speed': 16}, headers=H)
        for _ in range(40):
            if rt.replay.finished.is_set(): break
            pump(1)
        assert rt.replay.finished.is_set(); rt.tick(); assert rec.sent[-1]['replay'] == dict(speed=16, paused=True, finished=True)
        r = client.post('/api/replay/speed', json={'speed': 1}, headers=H); assert (r.status_code, r.json()['error_code']) == (409, 'STATE_CONFLICT') and rt.replay.speed == 16
        sql = "SELECT action, operator_id, reason FROM audit_events WHERE action = 'REPLAY_SPEED' ORDER BY event_seq"
        want = [('REPLAY_SPEED', 1, '1x to 16x'), ('REPLAY_SPEED', 1, '16x to 4x'), ('REPLAY_SPEED', 1, '4x to 16x')]
        wait_for(lambda: len(rows(st.db_path, sql)) == 3); assert rows(st.db_path, sql) == want        # one row per change, none for a repeat or a refusal
    finally: rt.stop(); st.close()

def test_a_simulator_host_refuses_the_route_with_state_conflict(tmp_path):
    from test_serve import started
    st, rt = started(tmp_path, 'SIMULATOR'); salt = sec.load_or_create_salt(st.settings.home, True); c = connect_db(st.db_path)
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (1, 'Ana', ?, 1, 1)", (sec.hash_token(salt, 'tok'),)); c.close(); rt.start()
    try:
        app, hub = S.build_app(rt, asyncio.new_event_loop()); rt.port.recovering = False
        r = TestClient(app, base_url=URL, raise_server_exceptions=False).post('/api/replay/speed', json={'speed': 4}, headers={'Authorization': 'Bearer tok'})
        assert (r.status_code, r.json()['error_code']) == (409, 'STATE_CONFLICT')
    finally: rt.stop(); st.close()
