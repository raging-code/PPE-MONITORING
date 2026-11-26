"""P19-2: POST /api/session/start, /api/session/end, /api/alerts/{id}/ack, /api/episodes/{id}/ack and /resolve (design 3.8, 8). The host is a fake Port that keeps
a little state, so idempotence, conflicts and the audit rows can be checked at the route. What the real port must do is in docs/adr/0007.md (P24 builds it)."""
import threading
import pytest
from fastapi.testclient import TestClient
from ppe_host.api import api_rest as R, models as M
GOOD = {'Authorization': 'Bearer good-token'}
class FakePort:
    def __init__(self):
        self.audits, self.calls, self.threads, self.recovering = [], [], {}, None
        self.sid, self.started, self.label, self.op, self.monitoring, self.backup_ok = 4, 1000, None, None, False, True
        self.alerts = {7: dict(node=1, cleared=False, ts=None, by=None), 8: dict(node=2, cleared=True, ts=None, by=None)}   # 8 is already auto-cleared
        self.eps = {3: dict(node=1, state='OPEN', ack=None, latch=True), 4: dict(node=2, state='RESOLVED', ack=None, latch=False)}
    def authenticate(self, token): return R.Operator(1, 'Ana') if token == 'good-token' else None
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append((action, operator_id, node_id, episode_id, reason))
    def session_id(self): return self.sid
    def recovering_retry_s(self): return self.recovering
    def start_monitoring(self, operator_id, label):
        self.calls.append('start'); changed = not self.monitoring
        if changed: self.monitoring, self.label = True, label
        if self.op is None: self.op = operator_id
        return R.SessionRow(self.sid, self.started, 'LIVE'), changed
    def end_session(self, session_id, operator_id):
        self.calls.append('end'); self.threads['end'] = threading.get_ident()
        if session_id != self.sid: raise R.ApiError(409, 'STATE_CONFLICT', 'session_id is not the open session')
        old, self.sid = self.sid, self.sid + 1; return R.EndResult(old, self.sid, self.backup_ok)
    def ack_alert(self, alert_id, operator_id):
        self.calls.append('ack_alert'); a = self.alerts.get(alert_id)
        if a is None: return None
        if a['ts'] is None: a['ts'], a['by'] = 5000, operator_id          # a repeat keeps the first ack
        return R.AlertAck(alert_id, a['node'], a['ts'], a['by'])
    def ack_episode(self, episode_id, operator_id):
        self.calls.append('ack_episode'); e = self.eps.get(episode_id)
        if e is None: return None
        if e['state'] == 'RESOLVED': raise R.ApiError(409, 'STATE_CONFLICT', 'episode is already resolved')
        if e['ack'] is None: e['state'], e['ack'] = 'ACKNOWLEDGED', (6000, operator_id)
        return R.EpisodeAck(episode_id, e['node'], *e['ack'])
    def resolve_episode(self, episode_id, reason, operator_id):
        self.calls.append('resolve'); e = self.eps.get(episode_id)
        if e is None: return None
        if e['state'] == 'RESOLVED': raise R.ApiError(409, 'STATE_CONFLICT', 'episode is already resolved')
        e['state'] = 'RESOLVED'; return R.EpisodeResolve(episode_id, e['node'], 7000, reason, operator_id, e['latch'])
@pytest.fixture
def rig():
    port = FakePort(); return TestClient(R.create_app(port, 'unused.db'), raise_server_exceptions=False), port
def envelope(r):
    b = r.json(); M.ErrorEnvelope(**b); assert set(b) == {'error_code', 'detail', 'retry_after_s'}; return b
def post(client, url, body=None, headers=GOOD): return client.post(url, json=body, headers=headers) if body is not None else client.post(url, headers=headers)

ALL = [('/api/session/start', {}), ('/api/session/end', {'confirm_text': 'END', 'session_id': 4}), ('/api/alerts/7/ack', {}), ('/api/episodes/3/ack', {}), ('/api/episodes/3/resolve', {'reason': 'rescued'})]
@pytest.mark.parametrize('url,body', ALL)
def test_every_action_needs_a_token_and_reaches_nothing_without_one(rig, url, body):
    client, port = rig
    for h in ({}, {'Authorization': 'Bearer wrong'}):
        r = client.post(url, json=body, headers=h); assert r.status_code == 401 and envelope(r)['error_code'] == 'UNAUTHENTICATED'
    assert port.calls == [] and port.audits == []
def test_the_five_routes_are_registered_beside_login_and_events():
    paths = {(m, r.path) for r in R.router.routes for m in r.methods}
    assert {('POST', '/api' + u) for u in ('/session/start', '/session/end', '/alerts/{alert_id}/ack', '/episodes/{episode_id}/ack', '/episodes/{episode_id}/resolve')} <= paths

def test_session_start_returns_the_session_and_logs_one_start_monitoring(rig):
    client, port = rig; r = post(client, '/api/session/start', {'session_label': 'shift-1'})
    assert r.status_code == 200 and r.json() == {'session_id': 4, 'started_ts': 1000, 'mode': 'LIVE', 'monitoring_active': True}
    assert port.audits == [('START_MONITORING', 1, None, None, None)] and port.label == 'shift-1'
def test_session_start_twice_gives_the_same_body_and_one_audit_row_and_keeps_the_label(rig):
    client, port = rig; a = post(client, '/api/session/start', {'session_label': 'shift-1'}); b = post(client, '/api/session/start', {'session_label': 'other'})
    assert a.json() == b.json() and [x[0] for x in port.audits] == ['START_MONITORING'] and port.label == 'shift-1'
def test_session_start_accepts_no_body_and_an_empty_body_and_refuses_extras(rig):
    client, port = rig; assert post(client, '/api/session/start').status_code == 200 and post(client, '/api/session/start', {}).status_code == 200
    for bad in ({'session_label': 5}, {'label': 'x'}): r = post(client, '/api/session/start', bad); assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR'

def test_end_shift_returns_both_ids_and_the_route_does_not_write_end_shift_itself(rig):
    client, port = rig; r = post(client, '/api/session/end', {'confirm_text': 'END', 'session_id': 4})
    assert r.status_code == 200 and r.json() == {'closed_session_id': 4, 'new_session_id': 5, 'backup_ok': True} and port.audits == []      # END_SHIFT is written inside close_session
def test_a_failed_backup_is_reported_not_hidden(rig):
    client, port = rig; port.backup_ok = False; assert post(client, '/api/session/end', {'confirm_text': 'END', 'session_id': 4}).json()['backup_ok'] is False
def test_end_shift_conflict_second_call_is_409_state_conflict_and_changes_nothing(rig):
    client, port = rig; body = {'confirm_text': 'END', 'session_id': 4}
    assert post(client, '/api/session/end', body).status_code == 200; port.calls.clear()
    r = post(client, '/api/session/end', body); assert r.status_code == 409 and envelope(r) == {'error_code': 'STATE_CONFLICT', 'detail': 'session_id is not the open session', 'retry_after_s': None}
    assert port.sid == 5 and port.calls == []      # refused before the port ran anything
def test_end_shift_wrong_or_missing_confirm_text(rig):
    client, port = rig
    for ct in ('end', 'END ', '', 'YES'):
        r = post(client, '/api/session/end', {'confirm_text': ct, 'session_id': 4}); assert r.status_code == 400 and envelope(r)['error_code'] == 'BAD_REQUEST'
    r = post(client, '/api/session/end', {'session_id': 4}); assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR'
    assert port.sid == 4 and port.calls == []
def test_end_shift_while_recovering_is_409_recovering_with_retry_after(rig):
    client, port = rig; port.recovering = 3.0; r = post(client, '/api/session/end', {'confirm_text': 'END', 'session_id': 4})
    assert r.status_code == 409 and envelope(r)['error_code'] == 'RECOVERING' and r.json()['retry_after_s'] == 3.0 and port.sid == 4 and port.calls == []
def test_a_conflict_raised_by_the_port_inside_the_worker_thread_still_uses_the_envelope(rig, monkeypatch):
    client, port = rig; monkeypatch.setattr(port, 'session_id', lambda: 9)      # the route's check passes, the port's atomic re-check refuses
    r = post(client, '/api/session/end', {'confirm_text': 'END', 'session_id': 9}); assert r.status_code == 409 and envelope(r)['error_code'] == 'STATE_CONFLICT'
def test_end_shift_runs_the_port_off_the_event_loop(rig):
    client, port = rig; seen = []; real = port.authenticate
    port.authenticate = lambda t: (seen.append(threading.get_ident()), real(t))[1]
    assert post(client, '/api/session/end', {'confirm_text': 'END', 'session_id': 4}).status_code == 200 and port.threads['end'] != seen[-1]

def test_alert_ack_open_alert_logs_ack_alert_with_node_and_alert_id(rig):
    client, port = rig; r = post(client, '/api/alerts/7/ack', {})
    assert r.status_code == 200 and r.json() == {'alert_id': 7, 'acknowledged_ts': 5000, 'acknowledged_by': 1} and port.audits == [('ACK_ALERT', 1, 1, None, 'alert_id 7')]
def test_alert_ack_of_an_already_cleared_alert_is_200(rig):
    client, _ = rig; r = post(client, '/api/alerts/8/ack'); assert r.status_code == 200 and r.json()['alert_id'] == 8
def test_alert_ack_twice_is_the_same_200(rig):
    client, _ = rig; assert post(client, '/api/alerts/7/ack', {}).json() == post(client, '/api/alerts/7/ack', {}).json()
def test_alert_ack_unknown_is_404_and_writes_no_audit_row(rig):
    client, port = rig; r = post(client, '/api/alerts/99/ack', {}); assert r.status_code == 404 and envelope(r)['error_code'] == 'NOT_FOUND' and port.audits == []
@pytest.mark.parametrize('url', ['/api/alerts/abc/ack', '/api/episodes/1.5/ack', '/api/episodes/x/resolve'])
def test_a_path_id_that_is_not_an_integer_is_422(rig, url):
    client, port = rig; r = post(client, url, {'reason': 'rescued'} if 'resolve' in url else {}); assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and port.calls == []
def test_ack_bodies_refuse_extra_fields(rig):
    client, port = rig; r = post(client, '/api/alerts/7/ack', {'x': 1}); assert r.status_code == 422 and port.calls == []

def test_episode_ack_returns_acknowledged_and_logs_ack_episode(rig):
    client, port = rig; r = post(client, '/api/episodes/3/ack', {})
    assert r.status_code == 200 and r.json() == {'episode_id': 3, 'state': 'ACKNOWLEDGED', 'acknowledged_ts': 6000, 'acknowledged_by': 1} and port.audits == [('ACK_EPISODE', 1, 1, 3, None)]
def test_episode_ack_unknown_is_404_and_resolved_is_409(rig):
    client, port = rig
    assert post(client, '/api/episodes/99/ack', {}).status_code == 404
    r = post(client, '/api/episodes/4/ack', {}); assert r.status_code == 409 and envelope(r)['error_code'] == 'STATE_CONFLICT' and port.audits == []

@pytest.mark.parametrize('reason', ['rescued', 'false_alarm', 'device_removed'])
def test_resolve_returns_the_reason_the_operator_and_latch_still_set(rig, reason):
    client, port = rig; r = post(client, '/api/episodes/3/resolve', {'reason': reason})
    assert r.status_code == 200 and r.json() == {'episode_id': 3, 'state': 'RESOLVED', 'resolved_ts': 7000, 'resolve_reason': reason, 'resolved_by': 1, 'latch_still_set': True}
    assert port.audits == [('RESOLVE_EPISODE', 1, 1, 3, reason)]
def test_resolve_reports_latch_still_set_false_when_the_jacket_latch_is_clear(rig):
    client, port = rig; port.eps[3]['latch'] = False; assert post(client, '/api/episodes/3/resolve', {'reason': 'rescued'}).json()['latch_still_set'] is False
@pytest.mark.parametrize('body', [{}, {'reason': 'lost'}, {'reason': ''}, {'reason': 'rescued', 'x': 1}, {'reason': 5}])
def test_resolve_with_a_bad_reason_is_422_and_never_reaches_the_port(rig, body):
    client, port = rig; r = post(client, '/api/episodes/3/resolve', body); assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and port.calls == [] and port.audits == []
def test_resolve_unknown_is_404_and_a_second_resolve_is_409_state_conflict(rig):
    client, port = rig; assert post(client, '/api/episodes/99/resolve', {'reason': 'rescued'}).status_code == 404
    assert post(client, '/api/episodes/3/resolve', {'reason': 'rescued'}).status_code == 200
    r = post(client, '/api/episodes/3/resolve', {'reason': 'false_alarm'}); assert r.status_code == 409 and envelope(r)['error_code'] == 'STATE_CONFLICT'
    assert [a[0] for a in port.audits] == ['RESOLVE_EPISODE']      # the refused call wrote no audit row
def test_resolve_needs_a_body_and_acknowledge_is_never_a_resolve(rig):
    client, port = rig; assert post(client, '/api/episodes/3/resolve').status_code == 422
    post(client, '/api/episodes/3/ack', {}); assert port.eps[3]['state'] == 'ACKNOWLEDGED'      # only Resolve closes an episode
