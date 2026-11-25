"""P19-1: REST shell (design 3.8): error envelope, bearer dependency, POST /api/login, GET /api/events. The host is a fake Port; the database is a real migrated file."""
import json, pathlib, threading
import pytest
from fastapi.testclient import TestClient
from ppe_host.api import api_rest as R, models as M
from ppe_host.io.db_writer import connect_db, run_migrations
MIG = pathlib.Path(__file__).resolve().parents[1] / 'migrations'
GOOD = {'Authorization': 'Bearer good-token'}
class FakePort:
    def __init__(self): self.audits, self.auth_threads = [], []
    def authenticate(self, token):
        self.auth_threads.append(threading.get_ident()); return R.Operator(1, 'Ana') if token == 'good-token' else None
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append((action, operator_id))
    def session_id(self): return 4
@pytest.fixture
def rig(tmp_path):
    db = tmp_path / 't.db'; c = connect_db(db); run_migrations(c, str(MIG), 1000)
    c.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash) VALUES (1, 1, 'LIVE', 'b', 'c', 's')")
    c.executemany('INSERT INTO roster(node_id, alias) VALUES (?, ?)', [(1, 'FF-01'), (2, 'FF-02')])
    port = FakePort(); return TestClient(R.create_app(port, db), raise_server_exceptions=False), port, c
def alert(c, seq, cleared_seq=None, typ='co_threshold', node=1):
    c.execute('INSERT INTO alerts(event_seq, cleared_event_seq, session_id, node_id, type, level, raised_ts, cleared_ts) VALUES (?, ?, 1, ?, ?, \'WARNING\', ?, ?)', (seq, cleared_seq, node, typ, seq * 10, cleared_seq and cleared_seq * 10))
def get(client, qs='', headers=GOOD): return client.get('/api/events' + qs, headers=headers)
def envelope(r):
    b = r.json(); M.ErrorEnvelope(**b); assert set(b) == {'error_code', 'detail', 'retry_after_s'}; return b

def test_login_ok_returns_operator_and_session_and_logs_login_ok(rig):
    client, port, _ = rig; r = client.post('/api/login', json={'token': 'good-token'})
    assert r.status_code == 200 and r.json() == {'operator_id': 1, 'display_name': 'Ana', 'session_id': 4} and port.audits == [('LOGIN_OK', 1)]
def test_login_with_a_wrong_token_is_401_and_logs_login_rejected(rig):
    client, port, _ = rig; r = client.post('/api/login', json={'token': 'nope'})
    assert r.status_code == 401 and envelope(r) == {'error_code': 'UNAUTHENTICATED', 'detail': 'invalid token', 'retry_after_s': None} and port.audits == [('LOGIN_REJECTED', None)]
@pytest.mark.parametrize('body', [{}, {'token': ''}, {'token': 'good-token', 'extra': 1}, {'tok': 'SECRET123'}, {'token': 5}])
def test_login_body_that_fails_the_schema_is_422_and_never_echoes_the_value(rig, body):
    client, port, _ = rig; r = client.post('/api/login', json=body)
    assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and 'SECRET123' not in r.text and port.audits == []
def test_events_needs_a_bearer_token_from_an_active_operator(rig):
    client, _, _ = rig
    for h in ({}, {'Authorization': 'Bearer wrong'}, {'Authorization': 'Basic good-token'}, {'Authorization': 'Bearer '}):
        r = get(client, headers=h); assert r.status_code == 401 and envelope(r)['error_code'] == 'UNAUTHENTICATED' and envelope(r)['retry_after_s'] is None
def test_events_of_an_empty_database(rig):
    client, _, _ = rig; assert get(client).json() == {'events': [], 'last_seq': 0} and get(client, '?after_seq=7').json() == {'events': [], 'last_seq': 7}
def test_events_carry_only_the_eight_columns_in_event_seq_order_and_never_a_frame_row(rig):
    client, port, c = rig
    for i in range(1, 4): c.execute("INSERT INTO frames(event_seq, session_id, node_id, rx_ts, rx_mono, verify, base_verify, seq_class, raw_hex, backend_ms) VALUES (?, 1, 1, 1, 1, 'OK', 'OK', 'fresh', 'ff', 0.1)", (100 + i,))
    alert(c, 5); alert(c, 2, 9, 'link_lost')
    c.execute("INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, node_id) VALUES (1, 4, 40, NULL, 'LOGIN_REJECTED', NULL)")
    c.execute("INSERT INTO system_events(session_id, event_seq, ts, kind, detail) VALUES (1, 7, 70, 'HOST_START', 'x')")
    r = get(client); b = r.json(); n = len(port.audits)
    assert [(e['event_seq'], e['record_type'], e['code']) for e in b['events']] == [(2, 'alert_raised', 'link_lost'), (4, 'audit', 'LOGIN_REJECTED'), (5, 'alert_raised', 'co_threshold'), (7, 'system', 'HOST_START'), (9, 'alert_cleared', 'link_lost')]
    assert b['last_seq'] == 9 and all(set(e) == set(M.EventRow.model_fields) for e in b['events']) and 'raw_hex' not in r.text and 'record_type' in r.text and port.audits == []
def test_after_seq_and_limit_page_the_log(rig):
    client, _, c = rig
    for s in (1, 2, 3, 4): alert(c, s, typ=('heat', 'battery_low', 'sensor_fault', 'checkin')[s - 1])
    assert [e['event_seq'] for e in get(client, '?limit=2').json()['events']] == [1, 2] and get(client, '?limit=2').json()['last_seq'] == 2
    assert [e['event_seq'] for e in get(client, '?after_seq=2&limit=2').json()['events']] == [3, 4] and get(client, '?after_seq=4').json()['events'] == []
def test_a_page_never_splits_rows_that_share_one_event_seq(rig):
    client, _, c = rig; alert(c, 3, 10, 'heat'); alert(c, 4, 10, 'battery_low')            # one resolve clears two alerts under event_seq 10
    b = get(client, '?limit=3').json(); assert [e['event_seq'] for e in b['events']] == [3, 4, 10, 10] and b['last_seq'] == 10      # may hold more rows than limit
    b = get(client, '?limit=2').json(); assert [e['event_seq'] for e in b['events']] == [3, 4] and b['last_seq'] == 4
    b = get(client, '?after_seq=4&limit=1').json(); assert [e['event_seq'] for e in b['events']] == [10, 10] and b['last_seq'] == 10
@pytest.mark.parametrize('qs', ['?after_seq=-1', '?limit=0', '?limit=1001', '?after_seq=abc', '?limit=2.5'])
def test_events_query_outside_its_range_is_422(rig, qs):
    client, _, _ = rig; r = get(client, qs); assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR'
def test_events_limit_edges_are_accepted(rig):
    client, _, _ = rig; assert get(client, '?limit=1').status_code == 200 and get(client, '?limit=1000').status_code == 200
def test_events_query_plan_never_touches_the_frames_table(rig):
    _, _, c = rig
    for sql in (R.EVENTS_SQL, R.SAME_SEQ_SQL):
        plan = ' | '.join(r[3] for r in c.execute('EXPLAIN QUERY PLAN ' + sql, (0, 5) if 'LIMIT' in sql else (0,)).fetchall()); assert 'frames' not in plan.lower(), plan
def test_events_read_runs_off_the_event_loop(rig, monkeypatch):
    client, port, _ = rig; seen = []; real = R.query_events
    monkeypatch.setattr(R, 'query_events', lambda *a: (seen.append(threading.get_ident()), real(*a))[1])
    assert get(client).status_code == 200 and seen and port.auth_threads and seen[0] != port.auth_threads[-1]      # authenticate() runs on the loop, the query in a worker thread
def test_unknown_path_wrong_method_and_a_crash_all_use_the_envelope(rig, monkeypatch):
    client, _, _ = rig
    r = client.get('/api/nothing', headers=GOOD); assert r.status_code == 404 and envelope(r)['error_code'] == 'NOT_FOUND'
    r = client.post('/api/events', headers=GOOD); assert r.status_code == 405 and envelope(r)['error_code'] == 'BAD_REQUEST'
    def boom(*a): raise RuntimeError('secret detail')
    monkeypatch.setattr(R, 'query_events', boom); r = get(client)
    assert r.status_code == 500 and envelope(r) == {'error_code': 'INTERNAL_ERROR', 'detail': 'internal error', 'retry_after_s': None} and 'secret' not in r.text
def test_docs_and_openapi_are_not_served_and_the_envelope_refuses_a_bad_code():
    c = TestClient(R.create_app(FakePort(), 'x.db'), raise_server_exceptions=False)
    assert c.get('/docs').status_code == 404 and c.get('/openapi.json').status_code == 404 and c.get('/redoc').status_code == 404
    for args in ((400, 'BAD_CODE', 'd'), (404, 'NOT_FOUND', 'd', 3.0)):      # a code outside the 3.8 list, and retry_after_s on a code that may not carry it
        with pytest.raises(ValueError): R.ApiError(*args)
    assert R.ApiError(409, 'RECOVERING', 'd', 3.0).env.retry_after_s == 3.0
