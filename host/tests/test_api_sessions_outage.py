"""P19c-1: GET /api/sessions and POST /api/dashboard-outage (design 3.8). The host is a fake Port, the database is a real migrated file.
Route level only: the liveness-stamp check of the design needs the running host (P24); here the query runs off the event loop and stays under 500 ms on a large frames table."""
import pathlib, threading, time
import pytest
from fastapi.testclient import TestClient
from ppe_host.api import api_rest as R, models as M
from ppe_host.io.db_writer import connect_db, run_migrations
MIG = pathlib.Path(__file__).resolve().parents[1] / 'migrations'
GOOD = {'Authorization': 'Bearer good-token'}
NOW = 10_090_000          # ms; the open session started at 10_000_000
class FakePort:
    def __init__(self): self.audits, self.calls = [], []
    def authenticate(self, token): return R.Operator(1, 'Ana') if token == 'good-token' else None
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append((action, operator_id, node_id, episode_id, reason))
    def session_id(self): return 2
    def login_failed(self): return None
    def login_ok(self): pass
@pytest.fixture
def rig(tmp_path, monkeypatch):
    monkeypatch.setattr(R, '_now_ms', lambda: NOW)
    db = tmp_path / 't.db'; c = connect_db(db); run_migrations(c, str(MIG), 1000)
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (1, 'Ana', 'h', 0, 0)")
    c.executemany('INSERT INTO roster(node_id, alias) VALUES (?, ?)', [(1, 'FF-01'), (2, 'FF-02'), (3, 'FF-03')])
    c.execute("INSERT INTO sessions(session_id, started_ts, ended_ts, mode, host_build, constants_hash, settings_hash, session_label, end_kind) VALUES (1, 1000000, 4600000, 'LIVE', 'b', 'c', 's', 'night', 'ENDED')")
    c.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash) VALUES (2, 10000000, 'LIVE', 'b', 'c', 's')")
    port = FakePort(); return TestClient(R.create_app(port, db), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port, c
def alert(c, sid, seq, node, typ, level):
    c.execute('INSERT INTO alerts(event_seq, session_id, node_id, type, level, raised_ts, cleared_ts) VALUES (?, ?, ?, ?, ?, ?, ?)', (seq, sid, node, typ, level, seq, seq))
def episode(c, sid, node, kind, state):
    extra = ", resolved_ts, resolve_reason, resolved_by) VALUES (?, ?, ?, 1, ?, 9, 'rescued', 1)" if state == 'RESOLVED' else ') VALUES (?, ?, ?, 1, ?)'
    c.execute('INSERT INTO episodes(session_id, node_id, kind, opened_ts, state' + extra, (sid, node, kind, state))
def envelope(r):
    b = r.json(); M.ErrorEnvelope(**b); assert set(b) == {'error_code', 'detail', 'retry_after_s'}; return b
def get(client, qs='', headers=GOOD): return client.get('/api/sessions' + qs, headers=headers)
def outage(client, started, ended, dur, headers=GOOD): return client.post('/api/dashboard-outage', json={'started_ts': started, 'ended_ts': ended, 'duration_s': dur}, headers=headers)

def test_both_routes_are_registered_beside_the_earlier_ones():
    paths = {(m, r.path) for r in R.router.routes for m in r.methods}
    assert {('GET', '/api/sessions'), ('POST', '/api/dashboard-outage')} <= paths
def test_both_routes_need_a_token_and_reach_nothing_without_one(rig):
    client, port, _ = rig
    for h in ({}, {'Authorization': 'Bearer wrong'}):
        r = get(client, headers=h); assert r.status_code == 401 and envelope(r)['error_code'] == 'UNAUTHENTICATED'
        r = outage(client, 1, 1, 0, headers=h); assert r.status_code == 401 and envelope(r)['error_code'] == 'UNAUTHENTICATED'
    assert {a[0] for a in port.audits} == {'LOGIN_REJECTED'}

def test_sessions_rows_are_newest_first_with_the_ten_fields(rig):
    client, port, c = rig; r = get(client); b = r.json()
    assert r.status_code == 200 and [x['session_id'] for x in b] == [2, 1] and all(set(x) == set(M.SessionListRow.model_fields) and len(x) == 10 for x in b)
    assert b[1] == {'session_id': 1, 'started_ts': 1000000, 'ended_ts': 4600000, 'duration_s': 3600.0, 'mode': 'LIVE', 'session_label': 'night', 'end_kind': 'ENDED',
                    'alert_count': 0, 'unresolved_episodes': 0, 'highest_level_by_node': {}}
    assert b[0]['ended_ts'] is None and b[0]['end_kind'] is None and b[0]['session_label'] is None and b[0]['duration_s'] == 90.0     # an open session runs to now
def test_sessions_alert_count_unresolved_episodes_and_highest_level_by_node(rig):
    client, port, c = rig
    for seq, node, typ, lv in [(1, 1, 'co_threshold', 'WARNING'), (2, 1, 'man_down', 'DANGER'), (3, 2, 'heat', 'WARNING'), (4, 3, 'wrist_open', 'NONE'), (5, None, 'suspect_frame', 'NONE')]: alert(c, 1, seq, node, typ, lv)
    alert(c, 2, 1, 1, 'battery_low', 'WARNING')
    episode(c, 1, 1, 'MAN_DOWN', 'RESOLVED'); episode(c, 1, 2, 'MAYDAY', 'OPEN'); episode(c, 1, 3, 'MAN_DOWN', 'ACKNOWLEDGED')
    one, two = sorted(get(client).json(), key=lambda x: x['session_id'])
    assert one['alert_count'] == 5 and one['unresolved_episodes'] == 2 and one['highest_level_by_node'] == {'1': 'DANGER', '2': 'WARNING'}      # NONE-only node 3 and the node-less notice are left out
    assert two['alert_count'] == 1 and two['unresolved_episodes'] == 0 and two['highest_level_by_node'] == {'1': 'WARNING'}
def test_sessions_limit_default_and_range(rig):
    client, port, c = rig
    assert [x['session_id'] for x in get(client, '?limit=1').json()] == [2] and len(get(client).json()) == 2
    for qs in ('?limit=0', '?limit=501', '?limit=x'): r = get(client, qs); assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR'
def test_sessions_of_an_empty_database_is_an_empty_list(rig):
    client, port, c = rig; c.execute('DELETE FROM sessions'); assert get(client).json() == []
def test_sessions_read_writes_no_audit_row_and_runs_off_the_event_loop(rig, monkeypatch):
    client, port, c = rig; seen = {}; real = R.query_sessions
    def spy(*a): seen['t'] = threading.get_ident(); return real(*a)
    monkeypatch.setattr(R, 'query_sessions', spy); main = threading.get_ident()
    assert get(client).status_code == 200 and seen['t'] != main and port.audits == []
def test_sessions_query_never_touches_the_frames_table_and_is_fast_on_a_large_database(rig):
    client, port, c = rig
    plan = ' | '.join(r[3] for r in c.execute('EXPLAIN QUERY PLAN ' + R.SESSIONS_SQL, (50,)).fetchall()) + ' | ' + ' | '.join(r[3] for r in c.execute('EXPLAIN QUERY PLAN ' + R.HIGHEST_SQL % '?,?', (1, 2)).fetchall())
    assert 'frames' not in plan.lower(), plan
    c.execute('BEGIN'); c.executemany("INSERT INTO frames(event_seq, session_id, node_id, rx_ts, rx_mono, verify, base_verify, seq_class, raw_hex, backend_ms) VALUES (?, 1, 1, ?, ?, 'OK', 'OK', 'fresh', '00', 0)", [(i, i, i) for i in range(1, 30001)]); c.execute('COMMIT')
    t = time.monotonic(); r = get(client); assert r.status_code == 200 and time.monotonic() - t < 0.5      # route level; the liveness stamp itself is P24

def test_outage_is_logged_with_one_audit_row(rig):
    client, port, c = rig; r = outage(client, NOW - 30_000, NOW - 10_000, 20.0)
    assert r.status_code == 200 and r.json() == {'logged': True} and port.audits == [('DASHBOARD_OUTAGE', 1, None, None, 'started_ts %d ended_ts %d duration_s 20' % (NOW - 30_000, NOW - 10_000))]
@pytest.mark.parametrize('started,ended,dur', [
    (NOW - 1000, NOW - 2000, 1.0),            # ended before started
    (NOW - 5000, NOW + 1, 5.0),               # ended in the future
    (NOW + 1, NOW + 1, 0.0),                  # both in the future
    (NOW - 20_000, NOW - 10_000, 11.001),     # duration 1.001 s too long
    (NOW - 20_000, NOW - 10_000, 8.999),      # duration 1.001 s too short
    (0, 86_401_000, 86_401.0),                # consistent but over 86400 s
    (NOW - 20_000, NOW - 10_000, 86_401.0)])  # over 86400 s and inconsistent
def test_outage_rules_give_422_validation_error_and_no_audit_row(rig, started, ended, dur):
    client, port, c = rig; r = outage(client, started, ended, dur)
    assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and port.audits == []
@pytest.mark.parametrize('started,ended,dur', [
    (NOW - 20_000, NOW - 10_000, 11.0),       # exactly 1 s long
    (NOW - 20_000, NOW - 10_000, 9.0),        # exactly 1 s short
    (NOW - 5000, NOW, 5.0),                   # ended exactly now
    (NOW, NOW, 0.0),                          # zero length
    (NOW - 86_400_000, NOW, 86_400.0),        # exactly 86400 s
    (NOW - 100, NOW - 100, 0.4)])             # tiny duration within the 1 s tolerance
def test_outage_boundaries_are_accepted(rig, started, ended, dur):
    client, port, c = rig; assert outage(client, started, ended, dur).status_code == 200 and [a[0] for a in port.audits] == ['DASHBOARD_OUTAGE']
@pytest.mark.parametrize('body', [{}, {'started_ts': 1, 'ended_ts': 2}, {'started_ts': 'a', 'ended_ts': 2, 'duration_s': 1}, {'started_ts': 1, 'ended_ts': 2, 'duration_s': 'x'}, {'started_ts': 1, 'ended_ts': 2, 'duration_s': 0.001, 'extra': 1}])
def test_outage_body_that_fails_the_schema_is_422_and_logs_nothing(rig, body):
    client, port, c = rig; r = client.post('/api/dashboard-outage', json=body, headers=GOOD)
    assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and port.audits == []
def test_outage_with_a_nan_duration_is_422(rig):
    client, port, c = rig; r = client.post('/api/dashboard-outage', content=b'{"started_ts": 1, "ended_ts": 1, "duration_s": NaN}', headers={**GOOD, 'Content-Type': 'application/json'})
    assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and port.audits == []
