"""P19c-2: POST /api/scba-correction and POST /api/system-banners/{kind}/ack (design 3.8, 8). The host is a fake Port. What the real port must do is in docs/adr/0011.md (P24)."""
import json, pathlib
import pytest
from fastapi.testclient import TestClient
from ppe_host.api import api_rest as R, models as M
GOOD = {'Authorization': 'Bearer good-token'}
CATALOG = json.loads((pathlib.Path(__file__).resolve().parents[2] / 'shared' / 'alert_catalog.json').read_text(encoding='utf8'))
class FakePort:
    def __init__(self): self.audits, self.calls, self.active, self.acked, self.roster = [], [], {'host_gap': True, 'logging_fault': True}, {}, {1, 2, 3}
    def authenticate(self, token): return R.Operator(1, 'Ana') if token == 'good-token' else None
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append((action, operator_id, node_id, episode_id, reason))
    def session_id(self): return 4
    def login_failed(self): return None
    def login_ok(self): pass
    def set_scba_correction(self, node_id, note, operator_id):
        self.calls.append(('scba', node_id)); return R.ScbaRecord(8000, 'Ana') if node_id in self.roster else None
    def ack_banner(self, kind, operator_id):
        self.calls.append(('banner', kind))
        if not self.active.get(kind): raise R.ApiError(409, 'STATE_CONFLICT', 'banner is not active')
        return R.BannerAck(kind, self.acked.setdefault(kind, 9000))      # a repeat keeps the first time
@pytest.fixture
def rig():
    port = FakePort(); return TestClient(R.create_app(port, 'unused.db'), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port
def envelope(r):
    b = r.json(); M.ErrorEnvelope(**b); assert set(b) == {'error_code', 'detail', 'retry_after_s'}; return b
def post(client, url, body=None, headers=GOOD): return client.post(url, json=body, headers=headers) if body is not None else client.post(url, headers=headers)

def test_both_routes_are_registered():
    paths = {(m, r.path) for r in R.router.routes for m in r.methods}
    assert {('POST', '/api/scba-correction'), ('POST', '/api/system-banners/{kind}/ack')} <= paths
@pytest.mark.parametrize('url,body', [('/api/scba-correction', {'node_id': 1}), ('/api/system-banners/host_gap/ack', {})])
def test_both_routes_need_a_token_and_reach_nothing_without_one(rig, url, body):
    client, port = rig
    for h in ({}, {'Authorization': 'Bearer wrong'}): r = client.post(url, json=body, headers=h); assert r.status_code == 401 and envelope(r)['error_code'] == 'UNAUTHENTICATED'
    assert port.calls == [] and {a[0] for a in port.audits} == {'LOGIN_REJECTED'}

def test_scba_correction_returns_time_and_operator_and_logs_one_audit_row_with_the_note(rig):
    client, port = rig; r = post(client, '/api/scba-correction', {'node_id': 2, 'note': 'wearer removed the set'})
    assert r.status_code == 200 and r.json() == {'recorded_ts': 8000, 'operator': 'Ana'} and port.audits == [('SCBA_CORRECTION', 1, 2, None, 'wearer removed the set')]
def test_scba_correction_note_is_optional_and_a_repeat_is_a_new_correction(rig):
    client, port = rig; assert post(client, '/api/scba-correction', {'node_id': 1}).status_code == 200 and post(client, '/api/scba-correction', {'node_id': 1}).status_code == 200
    assert port.audits == [('SCBA_CORRECTION', 1, 1, None, None)] * 2
@pytest.mark.parametrize('node', [0, 4, -1, 99])
def test_scba_correction_for_a_node_outside_the_roster_is_404_and_logs_nothing(rig, node):
    client, port = rig; r = post(client, '/api/scba-correction', {'node_id': node}); assert r.status_code == 404 and envelope(r)['error_code'] == 'NOT_FOUND' and port.audits == []
@pytest.mark.parametrize('body', [{}, {'note': 'x'}, {'node_id': 'one'}, {'node_id': 1, 'note': 5}, {'node_id': 1, 'extra': 1}])
def test_scba_correction_body_that_fails_the_schema_is_422_and_reaches_nothing(rig, body):
    client, port = rig; r = post(client, '/api/scba-correction', body); assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and port.calls == [] and port.audits == []

@pytest.mark.parametrize('kind', ['host_gap', 'logging_fault'])
def test_banner_ack_on_the_two_allowed_kinds_is_200_and_logs_banner_ack(rig, kind):
    client, port = rig; r = post(client, '/api/system-banners/%s/ack' % kind, {})
    assert r.status_code == 200 and r.json() == {'kind': kind, 'acknowledged_ts': 9000} and port.audits == [('BANNER_ACK', 1, None, None, kind)]
def test_banner_ack_accepts_no_body_and_a_repeat_returns_the_first_time(rig):
    client, port = rig; a = post(client, '/api/system-banners/host_gap/ack'); port.acked['host_gap'] = 9000; b = post(client, '/api/system-banners/host_gap/ack', {})
    assert a.status_code == b.status_code == 200 and a.json() == b.json()
@pytest.mark.parametrize('kind', ['no_live_data', 'base_offline', 'recovering', 'host_power', 'audio_fault'])
def test_a_known_banner_that_cannot_be_acknowledged_is_400_and_reaches_nothing(rig, kind):
    client, port = rig; r = post(client, '/api/system-banners/%s/ack' % kind, {}); assert r.status_code == 400 and envelope(r)['error_code'] == 'BAD_REQUEST' and port.calls == [] and port.audits == []
@pytest.mark.parametrize('kind', ['nope', 'HOST_GAP', 'host-gap', 'co_threshold'])
def test_an_unknown_banner_kind_is_404(rig, kind):
    client, port = rig; r = post(client, '/api/system-banners/%s/ack' % kind, {}); assert r.status_code == 404 and envelope(r)['error_code'] == 'NOT_FOUND' and port.calls == [] and port.audits == []
def test_banner_ack_of_a_banner_that_is_not_active_is_409_state_conflict_and_logs_nothing(rig):
    client, port = rig; port.active['logging_fault'] = False; r = post(client, '/api/system-banners/logging_fault/ack', {})
    assert r.status_code == 409 and envelope(r)['error_code'] == 'STATE_CONFLICT' and port.audits == []
def test_banner_ack_with_a_body_that_is_not_empty_is_422(rig):
    client, port = rig; r = post(client, '/api/system-banners/host_gap/ack', {'x': 1}); assert r.status_code == 422 and port.calls == []
def test_banner_kinds_match_alert_catalog_and_the_allowlist_is_host_gap_and_logging_fault():
    assert set(R.BANNER_KINDS) == {e['type'] for e in CATALOG if e['owner'] == 'system_banner'} and len(R.BANNER_KINDS) == 7
    assert set(R._get_args(M.BannerKind)) == {'host_gap', 'logging_fault'}
