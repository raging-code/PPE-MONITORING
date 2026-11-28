"""P19c-3: the table-driven status-code test of design 8 (Rev 3.31), generated from the frozen REST endpoint list of docs/design/s03-8.md. The list gives the endpoints,
the status codes each one may answer and the keys of its 200 body; the table below gives one request per code. The test fails when the code has an endpoint the list lacks,
when the list has one the code lacks, when a listed code has no request, or when a 200 body has other keys than the list names. Requirements: REQ-API-002."""
import pathlib, re
import pytest
from fastapi.testclient import TestClient
from ppe_host.api import api_rest as R, models as M
from ppe_host.io.db_writer import connect_db, run_migrations
ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = 5_000_000
PENDING = set()                                        # P26-1 added GET /api/export.csv; a route listed but not yet built goes here
GOOD, EVIL = {'Authorization': 'Bearer good-token'}, 'http://evil.example'
FF_ROW = dict(firefighter_id=1, alias='FFR-01', full_name='Test Person', sex=None, age_years=30, height_cm=175, weight_kg=75.0, resting_hr=60, max_hr=None, smoker=0, years_service=None, consent_ts=1000, consent_form_version='v1', active=1, consent_withdrawn_ts=None, node_id=None)      # S8-2, S8-5
FF_BODY = dict(full_name='Test Person', sex=None, age_years=30, height_cm=175, weight_kg=75.0, resting_hr=60, max_hr=None, smoker=False, years_service=None, consent=True, consent_form_version='v1', consent_witness='Witness', consent_date=None)
CODE_OF = {400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'ORIGIN_REJECTED', 404: 'NOT_FOUND', 409: 'STATE_CONFLICT', 422: 'VALIDATION_ERROR'}

def parse_list():
    """{'POST /api/login': {'codes': [{200}, {401}, {403}], 'keys': {...}}}: the bullets of the frozen list. A group like 401/403 is satisfied by either code."""
    out = {}
    for line in (ROOT / 'docs' / 'design' / 's03-8.md').read_text(encoding='utf8').splitlines():
        m = re.match(r'• (GET|POST) (/api/\S+) ', line)
        if not m: continue
        key, tail = '%s %s' % (m.group(1), m.group(2)), line.split(' -> ', 1)[1] if ' -> ' in line else ''
        groups = [set(map(int, g.split('/'))) for g in re.findall(r'\| (\d{3}(?:/\d{3})*)', tail)] + [{int(c)} for c in re.findall(r'otherwise (\d{3})', line)]
        out[key] = {'codes': groups, 'keys': body_keys(tail[tail.find('200') + 3:]) if tail else set()}
    return out
def body_keys(s):
    """Top-level keys of the first {...} after 200 (a list body '[{...}]' gives the keys of its row)."""
    if '{' not in s: return set()      # a streamed body such as text/csv
    i = s.index('{'); depth, cur, items = 0, '', []
    for ch in s[i:]:
        if ch in '{[': depth += 1; cur += ch if depth > 1 else ''
        elif ch in '}]':
            depth -= 1
            if depth == 0: items.append(cur); break
            cur += ch
        elif ch == ',' and depth == 1: items.append(cur); cur = ''
        else: cur += ch
    return {x.split(':')[0].strip() for x in items if x.strip()}
LIST = parse_list()

class Port:
    def __init__(self):
        self.audits, self.calls, self.recovering, self.sid, self.monitoring = [], [], None, 4, False
        self.alerts, self.eps, self.banners = {7: [False], 8: [True]}, {3: 'OPEN', 4: 'RESOLVED'}, {'host_gap': True, 'logging_fault': False}
    def authenticate(self, t): return R.Operator(1, 'Ana') if t == 'good-token' else None
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append(action)
    def session_id(self): return self.sid
    def login_failed(self): return None
    def login_ok(self): pass
    def logout(self, t): self.calls.append('logout'); return True      # P28-4a
    def recovering_retry_s(self): return self.recovering
    def start_monitoring(self, op, label): ch = not self.monitoring; self.monitoring = True; self.calls.append('start'); return R.SessionRow(self.sid, 1000, 'LIVE'), ch
    def end_session(self, sid, op): self.calls.append('end'); return R.EndResult(sid, sid + 1, True)
    def ack_alert(self, aid, op): return R.AlertAck(aid, 1, 5000, op) if aid in self.alerts else None
    def ack_episode(self, eid, op):
        if eid not in self.eps: return None
        if self.eps[eid] == 'RESOLVED': raise R.ApiError(409, 'STATE_CONFLICT', 'episode is already resolved')
        return R.EpisodeAck(eid, 1, 6000, op)
    def resolve_episode(self, eid, reason, op):
        if eid not in self.eps: return None
        if self.eps[eid] == 'RESOLVED': raise R.ApiError(409, 'STATE_CONFLICT', 'episode is already resolved')
        return R.EpisodeResolve(eid, 1, 7000, reason, op, True)
    def set_scba_correction(self, node, note, op): return R.ScbaRecord(8000, 'Ana') if node in (1, 2, 3) else None
    def replay_set_paused(self, paused):      # S7-5a
        self.calls.append('replay'); return R.ReplayState(paused, False, True)
    def replay_set_speed(self, speed):        # S7-7a
        self.calls.append('speed'); return R.ReplaySpeedState(speed, 1, False, False, True)
    def list_firefighters(self): return [dict(FF_ROW)]      # S8-2
    def add_firefighter(self, p):
        from ppe_host.services import firefighters as F
        F.check_profile(now_ms=NOW, **p); self.calls.append('ff_add'); return 2, 'FFR-02'      # the real checks, so a refused profile is a real 422
    def assign_firefighter(self, node, ff):
        from ppe_host.services import firefighters as F
        if node not in (1, 2, 3): raise F.FirefighterError('node %d is not in the roster' % node, 'missing')
        if ff == 99: raise F.FirefighterError('no firefighter with firefighter_id 99', 'missing')
        if ff == 5: raise F.FirefighterError('FFR-05 is inactive and cannot be assigned', 'conflict')
        self.calls.append('ff_assign'); return ('assigned', 'firefighter_id 1', 'FFR-01') if ff else ('ended', 'ended firefighter_id 1', None)
    def edit_firefighter(self, ff, changes):      # S8-5
        from ppe_host.services import firefighters as F
        if ff == 99: raise F.FirefighterError('no firefighter with firefighter_id 99', 'missing')
        if ff == 5: raise F.FirefighterError('FFR-05 withdrew consent and the profile cannot be edited', 'conflict')
        self.calls.append('ff_edit'); return 'changed', 'firefighter_id %d (FFR-%02d) changed: %s' % (ff, ff, ', '.join(changes)), 'FFR-%02d' % ff, sorted(changes)
    def withdraw_firefighter(self, ff):      # S8-5
        from ppe_host.services import firefighters as F
        if ff == 99: raise F.FirefighterError('no firefighter with firefighter_id 99', 'missing')
        self.calls.append('ff_withdraw'); return 'withdrawn', 'firefighter_id %d (FFR-%02d) consent withdrawn' % (ff, ff), 'FFR-%02d' % ff
    def set_firefighter_active(self, ff, active):      # S8-3a
        from ppe_host.services import firefighters as F
        if ff == 99: raise F.FirefighterError('no firefighter with firefighter_id 99', 'missing')
        self.calls.append('ff_active'); return 'changed', 'firefighter_id %d (FFR-%02d) %s' % (ff, ff, 'active' if active else 'inactive'), 'FFR-%02d' % ff
    def ack_banner(self, kind, op):
        if not self.banners[kind]: raise R.ApiError(409, 'STATE_CONFLICT', 'banner is not active')
        return R.BannerAck(kind, 9000)
@pytest.fixture
def rig(tmp_path, monkeypatch):
    monkeypatch.setattr(R, '_now_ms', lambda: NOW); db = tmp_path / 't.db'; c = connect_db(db); run_migrations(c, str(pathlib.Path(__file__).resolve().parents[1] / 'migrations'), 1000)
    c.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash) VALUES (4, 1000, 'LIVE', 'b', 'c', 's')")
    port = Port(); return TestClient(R.create_app(port, db), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port

# key -> (path, valid json body or None, query); the path holds concrete ids that exist in Port
VALID = {'POST /api/login': ('/api/login', {'token': 'good-token'}, None), 'POST /api/session/start': ('/api/session/start', {}, None),
         'POST /api/session/end': ('/api/session/end', {'confirm_text': 'END', 'session_id': 4}, None), 'POST /api/alerts/{alert_id}/ack': ('/api/alerts/7/ack', {}, None),
         'POST /api/episodes/{episode_id}/ack': ('/api/episodes/3/ack', {}, None), 'POST /api/episodes/{episode_id}/resolve': ('/api/episodes/3/resolve', {'reason': 'rescued'}, None),
         'POST /api/system-banners/{kind}/ack': ('/api/system-banners/host_gap/ack', {}, None), 'POST /api/scba-correction': ('/api/scba-correction', {'node_id': 1}, None),
         'POST /api/dashboard-outage': ('/api/dashboard-outage', {'started_ts': NOW - 30000, 'ended_ts': NOW - 10000, 'duration_s': 20.0}, None),
         'GET /api/sessions': ('/api/sessions', None, None), 'GET /api/events': ('/api/events', None, {'after_seq': 0}), 'GET /api/export.csv': ('/api/export.csv', None, None),
         'GET /api/firefighters/readings.csv': ('/api/firefighters/readings.csv', None, None),      # S8-4a
         'POST /api/logout': ('/api/logout', None, None), 'POST /api/replay/pause': ('/api/replay/pause', {'paused': True}, None),
         'POST /api/replay/speed': ('/api/replay/speed', {'speed': 4}, None),
         'GET /api/firefighters': ('/api/firefighters', None, None), 'POST /api/firefighters': ('/api/firefighters', FF_BODY, None),
         'POST /api/firefighters/assign': ('/api/firefighters/assign', {'node_id': 1, 'firefighter_id': 1}, None),
         'POST /api/firefighters/active': ('/api/firefighters/active', {'firefighter_id': 1, 'active': False}, None),
         'POST /api/firefighters/edit': ('/api/firefighters/edit', {'firefighter_id': 1, 'weight_kg': 80.0}, None),      # S8-5
         'POST /api/firefighters/withdraw': ('/api/firefighters/withdraw', {'firefighter_id': 1}, None)}
# (key, label, path, body, query, status, setup): one request per listed non-200 code beyond the generated 401 and 403 rows
EXTRA = [('POST /api/login', 'wrong token', '/api/login', {'token': 'nope'}, None, 401, None),
         ('POST /api/session/end', 'wrong confirm_text', '/api/session/end', {'confirm_text': 'x', 'session_id': 4}, None, 400, None),
         ('POST /api/session/end', 'stale session_id', '/api/session/end', {'confirm_text': 'END', 'session_id': 3}, None, 409, None),
         ('POST /api/alerts/{alert_id}/ack', 'unknown alert', '/api/alerts/99/ack', {}, None, 404, None),
         ('POST /api/episodes/{episode_id}/ack', 'unknown episode', '/api/episodes/99/ack', {}, None, 404, None),
         ('POST /api/episodes/{episode_id}/ack', 'resolved episode', '/api/episodes/4/ack', {}, None, 409, None),
         ('POST /api/episodes/{episode_id}/resolve', 'reason outside the three', '/api/episodes/3/resolve', {'reason': 'x'}, None, 422, None),
         ('POST /api/episodes/{episode_id}/resolve', 'unknown episode', '/api/episodes/99/resolve', {'reason': 'rescued'}, None, 404, None),
         ('POST /api/episodes/{episode_id}/resolve', 'resolved episode', '/api/episodes/4/resolve', {'reason': 'rescued'}, None, 409, None),
         ('POST /api/system-banners/{kind}/ack', 'banner that cannot be acknowledged', '/api/system-banners/host_power/ack', {}, None, 400, None),
         ('POST /api/system-banners/{kind}/ack', 'unknown kind', '/api/system-banners/nope/ack', {}, None, 404, None),
         ('POST /api/system-banners/{kind}/ack', 'banner not active', '/api/system-banners/logging_fault/ack', {}, None, 409, None),
         ('POST /api/scba-correction', 'node outside the roster', '/api/scba-correction', {'node_id': 9}, None, 404, None),
         ('POST /api/dashboard-outage', 'ended before started', '/api/dashboard-outage', {'started_ts': NOW - 1000, 'ended_ts': NOW - 2000, 'duration_s': 1.0}, None, 422, None),
         ('POST /api/dashboard-outage', 'a future time', '/api/dashboard-outage', {'started_ts': NOW - 1000, 'ended_ts': NOW + 1, 'duration_s': 1.0}, None, 422, None),
         ('POST /api/dashboard-outage', 'duration more than 1 s off', '/api/dashboard-outage', {'started_ts': NOW - 20000, 'ended_ts': NOW - 10000, 'duration_s': 11.5}, None, 422, None),
         ('POST /api/dashboard-outage', 'duration above 86400', '/api/dashboard-outage', {'started_ts': 0, 'ended_ts': 86_401_000, 'duration_s': 86401.0}, None, 422, None),
         ('POST /api/replay/pause', 'body without paused', '/api/replay/pause', {}, None, 422, None),
         ('POST /api/replay/speed', 'speed outside 1, 4 and 16', '/api/replay/speed', {'speed': 2}, None, 422, None),
         ('GET /api/events', 'limit out of range', '/api/events', None, {'limit': 0}, 422, None),
         ('GET /api/sessions', 'limit out of range', '/api/sessions', None, {'limit': 0}, 422, None),
         ('POST /api/firefighters', 'consent not given', '/api/firefighters', {**FF_BODY, 'consent': False}, None, 422, None),
         ('POST /api/firefighters', 'age out of range', '/api/firefighters', {**FF_BODY, 'age_years': 99}, None, 422, None),
         ('POST /api/firefighters', 'host recovering', '/api/firefighters', FF_BODY, None, 409, lambda p: setattr(p, 'recovering', 3.0)),
         ('POST /api/firefighters/assign', 'unknown firefighter', '/api/firefighters/assign', {'node_id': 3, 'firefighter_id': 99}, None, 404, None),
         ('POST /api/firefighters/assign', 'inactive firefighter', '/api/firefighters/assign', {'node_id': 1, 'firefighter_id': 5}, None, 409, None),
         ('POST /api/firefighters/assign', 'node id not a number', '/api/firefighters/assign', {'node_id': 'x', 'firefighter_id': 1}, None, 422, None),
         ('POST /api/firefighters/assign', 'host recovering', '/api/firefighters/assign', {'node_id': 1, 'firefighter_id': 1}, None, 409, lambda p: setattr(p, 'recovering', 3.0)),
         ('POST /api/firefighters/active', 'unknown firefighter', '/api/firefighters/active', {'firefighter_id': 99, 'active': False}, None, 404, None),
         ('POST /api/firefighters/active', 'active is not a boolean', '/api/firefighters/active', {'firefighter_id': 1, 'active': 'maybe'}, None, 422, None),
         ('POST /api/firefighters/active', 'host recovering', '/api/firefighters/active', {'firefighter_id': 1, 'active': False}, None, 409, lambda p: setattr(p, 'recovering', 3.0)),
         ('POST /api/firefighters/edit', 'unknown firefighter', '/api/firefighters/edit', {'firefighter_id': 99, 'weight_kg': 80.0}, None, 404, None),
         ('POST /api/firefighters/edit', 'withdrawn firefighter', '/api/firefighters/edit', {'firefighter_id': 5, 'weight_kg': 80.0}, None, 409, None),
         ('POST /api/firefighters/edit', 'weight is not a number', '/api/firefighters/edit', {'firefighter_id': 1, 'weight_kg': 'heavy'}, None, 422, None),
         ('POST /api/firefighters/edit', 'host recovering', '/api/firefighters/edit', {'firefighter_id': 1, 'weight_kg': 80.0}, None, 409, lambda p: setattr(p, 'recovering', 3.0)),
         ('POST /api/firefighters/withdraw', 'unknown firefighter', '/api/firefighters/withdraw', {'firefighter_id': 99}, None, 404, None),
         ('POST /api/firefighters/withdraw', 'id is not a number', '/api/firefighters/withdraw', {'firefighter_id': 'x'}, None, 422, None),
         ('POST /api/firefighters/withdraw', 'host recovering', '/api/firefighters/withdraw', {'firefighter_id': 1}, None, 409, lambda p: setattr(p, 'recovering', 3.0))]
RECOVERING = ('POST /api/session/end', 'host recovering', '/api/session/end', {'confirm_text': 'END', 'session_id': 4}, None, 409, lambda p: setattr(p, 'recovering', 3.0))
RECOVERING_REPLAY = ('POST /api/replay/pause', 'host recovering', '/api/replay/pause', {'paused': True}, None, 409, lambda p: setattr(p, 'recovering', 3.0))      # S7-5a
RECOVERING_SPEED = ('POST /api/replay/speed', 'host recovering', '/api/replay/speed', {'speed': 4}, None, 409, lambda p: setattr(p, 'recovering', 3.0))      # S7-7a
CASES = [(k, 'valid request', p, b, q, 200, None) for k, (p, b, q) in VALID.items()] + EXTRA + [RECOVERING, RECOVERING_REPLAY, RECOVERING_SPEED] \
      + [(k, '401 no token', p, b, q, 401, None) for k, (p, b, q) in VALID.items() if k != 'POST /api/login'] + [(k, '403 Origin', p, b, q, 403, None) for k, (p, b, q) in VALID.items()]
def send(client, key, path, body, query, status, label):
    headers = {} if label == '401 no token' else ({} if key == 'POST /api/login' else dict(GOOD))
    if label == '403 Origin': headers['Origin'] = EVIL
    return client.request(key.split()[0], path, json=body, params=query, headers=headers)

def test_the_list_parses_to_the_twenty_two_endpoints_with_their_codes_and_keys():      # P28-4a added POST /api/logout, S7-5a POST /api/replay/pause, S7-7a POST /api/replay/speed, S8-2 the three firefighter routes, S8-3a POST /api/firefighters/active, S8-4a GET /api/firefighters/readings.csv, S8-5 POST /api/firefighters/edit and /withdraw
    assert len(LIST) == 22 and LIST['POST /api/firefighters/edit']['keys'] == {'firefighter_id', 'alias', 'result', 'changed'} and LIST['POST /api/firefighters/withdraw']['keys'] == {'firefighter_id', 'alias', 'result'} and LIST['POST /api/firefighters/active']['keys'] == {'firefighter_id', 'alias', 'active', 'result'} and LIST['POST /api/firefighters']['keys'] == {'firefighter_id', 'alias'} and LIST['POST /api/firefighters/assign']['keys'] == {'node_id', 'firefighter_id', 'alias', 'result'} and len(LIST['GET /api/firefighters']['keys']) == 16 and LIST['POST /api/replay/pause']['keys'] == {'paused', 'finished'} and LIST['POST /api/replay/speed']['keys'] == {'speed', 'paused', 'finished'} and LIST['POST /api/logout']['keys'] == {'logged_out'} and all(v['keys'] or k in ('GET /api/export.csv', 'GET /api/firefighters/readings.csv') for k, v in LIST.items()) and LIST['POST /api/login']['keys'] == {'operator_id', 'display_name', 'session_id'}
    assert LIST['GET /api/events']['keys'] == {'events', 'last_seq'} and len(LIST['GET /api/sessions']['keys']) == 10 and {400} in LIST['POST /api/system-banners/{kind}/ack']['codes']
def code_endpoints(app):
    """'METHOD path' of every HTTP route, read from the generated OpenAPI schema (app.openapi() works although /openapi.json is not served), so it does not depend on how FastAPI stores included routers."""
    return {'%s %s' % (m.upper(), path) for path, ops in app.openapi()['paths'].items() for m in ops if m.upper() not in ('HEAD', 'OPTIONS')}
def test_no_endpoint_is_missing_and_none_is_extra(rig):
    client, port = rig; code = code_endpoints(client.app)
    assert code == set(LIST) - PENDING, 'missing %s, extra %s' % (sorted(set(LIST) - PENDING - code), sorted(code - set(LIST)))
    for url in ('/docs', '/redoc', '/openapi.json'): assert client.get(url, headers=GOOD).status_code == 404      # no documentation route is served
def test_the_pending_endpoint_is_still_pending():
    code = {'%s %s' % (m, r.path) for r in R.router.routes for m in r.methods}      # R.router holds plain APIRoute objects
    assert PENDING <= set(LIST) and not (PENDING & code), 'a pending route now exists: add its rows to VALID and empty PENDING'
    assert 'GET /api/export.csv' in code and 'GET /api/firefighters/readings.csv' in code           # P26-1: the last frozen route is built; S8-4a the export of the firefighters' readings
def test_every_listed_code_has_a_request_in_the_table():
    covered = {}
    for key, _, _, _, _, status, _ in CASES: covered.setdefault(key, set()).add(status)
    for key, v in LIST.items():
        if key in PENDING: continue
        assert 200 in covered.get(key, set()), key + ': no valid request'
        for group in v['codes']: assert group & covered[key], '%s: no request for %s' % (key, sorted(group))
    assert set(covered) == set(LIST) - PENDING

@pytest.mark.parametrize('key,label,path,body,query,status,setup', CASES, ids=['%s [%s]' % (c[0], c[1]) for c in CASES])
def test_endpoint_table(rig, key, label, path, body, query, status, setup):
    client, port = rig
    if setup: setup(port)
    r = send(client, key, path, body, query, status, label); assert r.status_code == status, r.text
    if status == 200 and key == 'GET /api/export.csv':      # a streamed body: the list names no JSON keys (P26-1)
        assert r.headers['content-type'].startswith('text/csv') and r.text.startswith('session_id,event_seq,log_ts,record_type'); return
    if status == 200 and key == 'GET /api/firefighters/readings.csv':      # S8-4a: a streamed body too
        assert r.headers['content-type'].startswith('text/csv') and r.text.startswith('session_id,event_seq,rx_ts,firefighter,node_id'); return
    if status == 200:
        rows = r.json() if isinstance(r.json(), list) else [r.json()]
        assert rows and all(set(x) == LIST[key]['keys'] for x in rows), '%s: body keys %s differ from the list %s' % (key, sorted(rows[0]), sorted(LIST[key]['keys']))
        return
    b = r.json(); M.ErrorEnvelope(**b); assert set(b) == {'error_code', 'detail', 'retry_after_s'}
    want = 'RECOVERING' if label == 'host recovering' else CODE_OF[status]
    assert b['error_code'] == want and (b['retry_after_s'] is not None) == (want == 'RECOVERING')
    if status == 403: assert 'ORIGIN_REJECTED' in port.audits and port.calls == []
    if status == 401 and key != 'POST /api/login': assert port.calls == []

def test_end_shift_with_a_stale_session_id_gives_409_state_conflict_and_changes_nothing(rig):
    client, port = rig; r = client.post('/api/session/end', json={'confirm_text': 'END', 'session_id': 3}, headers=GOOD)
    assert r.status_code == 409 and r.json()['error_code'] == 'STATE_CONFLICT' and port.calls == [] and port.sid == 4
def test_session_start_twice_gives_the_same_body_and_one_start_monitoring_row(rig):
    client, port = rig; a, b = (client.post('/api/session/start', json={}, headers=GOOD) for _ in range(2))
    assert a.status_code == b.status_code == 200 and a.json() == b.json() and port.audits.count('START_MONITORING') == 1
def test_an_alert_ack_on_an_already_cleared_alert_is_an_idempotent_200(rig):
    client, port = rig; a, b = (client.post('/api/alerts/8/ack', json={}, headers=GOOD) for _ in range(2)); assert a.status_code == b.status_code == 200 and a.json() == b.json()
@pytest.mark.parametrize('kind', ['host_gap'])
def test_banner_ack_on_host_gap_and_logging_fault_is_200_when_active(rig, kind):
    client, port = rig; port.banners['logging_fault'] = True
    for k in ('host_gap', 'logging_fault'): assert client.post('/api/system-banners/%s/ack' % k, json={}, headers=GOOD).status_code == 200
