// patches/part19_2_session_ack_resolve.mjs  (run from repo root: node patches/part19_2_session_ack_resolve.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
const putB64 = (p, b64) => put(p, Buffer.from(b64, 'base64').toString('utf8'));
const replace = (p, oldStr, newStr) => plan.push({ op: 'replace', p, oldStr, newStr });
const append = (p, text) => plan.push({ op: 'append', p, text });
function apply() {
  const state = new Map(), log = [];
  const get = (p) => state.has(p) ? state.get(p) : (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && cur !== s.content && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : cur === s.content ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) {
      throw new Error(`MISSING file: ${s.p}`);
    } else if (s.op === 'replace') {
      const n = cur.split(s.oldStr).length - 1;
      if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
      else if (n === 0 && cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else throw new Error(`ANCHOR found ${n} times in ${s.p}: ${s.oldStr.slice(0, 60)}`);
    } else if (s.op === 'append') {
      if (cur.includes(s.text)) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : '\n') + s.text); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : `OK: ${state.size} file(s) written`);
}
try { await run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }

// ---- write only this part below ----
async function run() {
  replace('host/ppe_host/api/api_rest.py', String.raw`    def session_id(self) -> int: ...

class ApiError`, String.raw`    def session_id(self) -> int: ...
    # P19-2. A method raises ApiError for a conflict and returns None for an unknown id. The host owns every write and every event_seq.
    def recovering_retry_s(self) -> Optional[float]: ...  # recovering_target_s while recovering, else None
    def start_monitoring(self, operator_id: int, session_label: Optional[str]) -> tuple: ...  # (SessionRow, changed); idempotent: sets operator_id only while NULL, never changes label or a second START_MONITORING
    def end_session(self, session_id: int, operator_id: int) -> 'EndResult': ...  # close_session('ENDED') incl. its END_SHIFT audit row, then the backup; runs in a worker thread; ApiError STATE_CONFLICT if session_id is no longer open
    def ack_alert(self, alert_id: int, operator_id: int) -> Optional['AlertAck']: ...  # idempotent; also for a cleared alert
    def ack_episode(self, episode_id: int, operator_id: int) -> Optional['EpisodeAck']: ...  # idempotent when ACKNOWLEDGED; ApiError STATE_CONFLICT when RESOLVED
    def resolve_episode(self, episode_id: int, reason: str, operator_id: int) -> Optional['EpisodeResolve']: ...  # ApiError STATE_CONFLICT when already RESOLVED

class ApiError`);
  append('host/ppe_host/api/api_rest.py', String.raw`# ---- P19-2: session start and end, Acknowledge and Resolve (design 3.8) ----
# Start, Acknowledge and Resolve call the port on the event loop (the engine is single-threaded). End shift is awaited in a worker thread because it runs
# the backup. The port owns every database write and every event_seq; this file only checks the request, maps the answer and writes the audit row
# the port does not write itself. END_SHIFT is written by close_session inside its own transaction (2.3), so the route never audits it.
class SessionRow(NamedTuple):
    session_id: int
    started_ts: int
    mode: str
class EndResult(NamedTuple):
    closed_session_id: int
    new_session_id: int
    backup_ok: bool
class AlertAck(NamedTuple):
    alert_id: int
    node_id: Optional[int]
    acknowledged_ts: int
    acknowledged_by: int
class EpisodeAck(NamedTuple):
    episode_id: int
    node_id: int
    acknowledged_ts: int
    acknowledged_by: int
class EpisodeResolve(NamedTuple):
    episode_id: int
    node_id: int
    resolved_ts: int
    resolve_reason: str
    resolved_by: int
    latch_still_set: bool

@router.post('/session/start', response_model=M.SessionStartResp)
async def session_start(request: Request, op: Operator = Depends(current_operator), body: Optional[M.SessionStartReq] = None):
    port = request.app.state.port; row, changed = port.start_monitoring(op.operator_id, body.session_label if body else None)
    if changed: port.audit('START_MONITORING', operator_id=op.operator_id)  # a second call changes nothing and writes no second row
    return M.SessionStartResp(session_id=row.session_id, started_ts=row.started_ts, mode=row.mode, monitoring_active=True)

@router.post('/session/end', response_model=M.SessionEndResp)
async def session_end(body: M.SessionEndReq, request: Request, op: Operator = Depends(current_operator)):
    port = request.app.state.port
    if body.confirm_text != 'END': raise ApiError(400, 'BAD_REQUEST', 'confirm_text must be END')
    retry = port.recovering_retry_s()
    if retry is not None: raise ApiError(409, 'RECOVERING', 'host is recovering, try again shortly', retry)
    if body.session_id != port.session_id(): raise ApiError(409, 'STATE_CONFLICT', 'session_id is not the open session')
    r = await run_in_threadpool(port.end_session, body.session_id, op.operator_id)  # the port re-checks atomically and may raise ApiError STATE_CONFLICT
    return M.SessionEndResp(closed_session_id=r.closed_session_id, new_session_id=r.new_session_id, backup_ok=r.backup_ok)

@router.post('/alerts/{alert_id}/ack', response_model=M.AckAlertResp)
async def ack_alert(alert_id: int, request: Request, op: Operator = Depends(current_operator), body: Optional[M.EmptyReq] = None):
    port = request.app.state.port; r = port.ack_alert(alert_id, op.operator_id)  # 200 also for an alert that already cleared, and again on a repeat
    if r is None: raise ApiError(404, 'NOT_FOUND', 'unknown alert')
    port.audit('ACK_ALERT', operator_id=op.operator_id, node_id=r.node_id, reason='alert_id %d' % r.alert_id)
    return M.AckAlertResp(alert_id=r.alert_id, acknowledged_ts=r.acknowledged_ts, acknowledged_by=r.acknowledged_by)

@router.post('/episodes/{episode_id}/ack', response_model=M.AckEpisodeResp)
async def ack_episode(episode_id: int, request: Request, op: Operator = Depends(current_operator), body: Optional[M.EmptyReq] = None):
    port = request.app.state.port; r = port.ack_episode(episode_id, op.operator_id)  # the port raises ApiError STATE_CONFLICT for a RESOLVED episode
    if r is None: raise ApiError(404, 'NOT_FOUND', 'unknown episode')
    port.audit('ACK_EPISODE', operator_id=op.operator_id, node_id=r.node_id, episode_id=r.episode_id)
    return M.AckEpisodeResp(episode_id=r.episode_id, state='ACKNOWLEDGED', acknowledged_ts=r.acknowledged_ts, acknowledged_by=r.acknowledged_by)

@router.post('/episodes/{episode_id}/resolve', response_model=M.ResolveResp)
async def resolve_episode(episode_id: int, body: M.ResolveReq, request: Request, op: Operator = Depends(current_operator)):
    port = request.app.state.port; r = port.resolve_episode(episode_id, body.reason, op.operator_id)  # the port raises ApiError STATE_CONFLICT for an episode already RESOLVED
    if r is None: raise ApiError(404, 'NOT_FOUND', 'unknown episode')
    port.audit('RESOLVE_EPISODE', operator_id=op.operator_id, node_id=r.node_id, episode_id=r.episode_id, reason=r.resolve_reason)
    return M.ResolveResp(episode_id=r.episode_id, state='RESOLVED', resolved_ts=r.resolved_ts, resolve_reason=r.resolve_reason, resolved_by=r.resolved_by, latch_still_set=r.latch_still_set)
`);
  append('host/ppe_host/api/models.py', String.raw`# ---- REST bodies (P19-2): session start and end, Acknowledge, Resolve (design 3.8) ----
class EmptyReq(_Strict):  # the ack bodies are {} (or no body at all)
    pass
class SessionStartReq(_Strict):
    session_label: Optional[str] = None
class SessionStartResp(_Strict):
    session_id: int
    started_ts: int
    mode: SessionMode
    monitoring_active: Literal[True]
class SessionEndReq(_Strict):  # confirm_text is a plain str: a wrong value is 400 BAD_REQUEST (design 8), not a 422 schema failure
    confirm_text: str
    session_id: int
class SessionEndResp(_Strict):
    closed_session_id: int
    new_session_id: int
    backup_ok: bool
class AckAlertResp(_Strict):
    alert_id: int
    acknowledged_ts: int
    acknowledged_by: int
class AckEpisodeResp(_Strict):
    episode_id: int
    state: Literal['ACKNOWLEDGED']
    acknowledged_ts: int
    acknowledged_by: int
class ResolveReq(_Strict):  # a reason outside the three is 422 VALIDATION_ERROR
    reason: ResolveReason
class ResolveResp(_Strict):
    episode_id: int
    state: Literal['RESOLVED']
    resolved_ts: int
    resolve_reason: ResolveReason
    resolved_by: int
    latch_still_set: bool
`);
  put('host/tests/test_api_actions.py', String.raw`"""P19-2: POST /api/session/start, /api/session/end, /api/alerts/{id}/ack, /api/episodes/{id}/ack and /resolve (design 3.8, 8). The host is a fake Port that keeps
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
`);
  putB64('docs/adr/0007.md', 'IyBBRFIgMDAwNzogUkVTVCBhY3Rpb25zIG9mIFAxOS0yIChzZXNzaW9uIHN0YXJ0IGFuZCBlbmQsIEFja25vd2xlZGdlLCBSZXNvbHZlKQoKU3RhdHVzOiBQcm9wb3NlZCAoZGVjaWRlZCBpbiB0aGUgUDE5LTIgc2Vzc2lvbjsgY29uZmlybSBhdCB0aGUgbmV4dCBkZXNpZ24gcmV2aWV3KS4KRGVzaWduOiBSZXYgMy40NSBpcyBmcm96ZW4uIE5vdGhpbmcgaW4gdGhlIGZyYW1lLCB0aGUgbWlncmF0aW9uIG9yIGBjb25zdGFudHMuanNvbmAgY2hhbmdlcy4KCi0gKipQb3J0IGdyb3dzIGJ5IHNpeCBtZXRob2RzOioqIGByZWNvdmVyaW5nX3JldHJ5X3NgLCBgc3RhcnRfbW9uaXRvcmluZ2AsIGBlbmRfc2Vzc2lvbmAsIGBhY2tfYWxlcnRgLCBgYWNrX2VwaXNvZGVgLCBgcmVzb2x2ZV9lcGlzb2RlYC4gVGhlIGhvc3QgKFAyNCkgaW1wbGVtZW50cyB0aGVtOyB0aGUgcm91dGVzIGNoZWNrIHRoZSByZXF1ZXN0LCBtYXAgdGhlIGFuc3dlciBhbmQgd3JpdGUgdGhlIGF1ZGl0IHJvd3MgdGhlIHBvcnQgZG9lcyBub3Qgd3JpdGUuIEEgbWV0aG9kIHJldHVybnMgYE5vbmVgIGZvciBhbiB1bmtub3duIGlkICg0MDQpIGFuZCByYWlzZXMgYEFwaUVycm9yYCBmb3IgYSBjb25mbGljdC4KLSAqKlRocmVhZHM6KiogU3RhcnQsIEFja25vd2xlZGdlIGFuZCBSZXNvbHZlIGNhbGwgdGhlIHBvcnQgb24gdGhlIGV2ZW50IGxvb3AgYmVjYXVzZSB0aGUgZW5naW5lIGlzIHNpbmdsZS10aHJlYWRlZC4gRW5kIHNoaWZ0IGlzIGF3YWl0ZWQgaW4gYSB3b3JrZXIgdGhyZWFkIGJlY2F1c2UgaXQgcnVucyB0aGUgYmFja3VwIChkZXNpZ24gMy44OiBvZmYtbG9vcCBiYWNrdXApLCBzbyB0aGUgcG9ydCdzIGBlbmRfc2Vzc2lvbmAgbXVzdCBiZSB0aHJlYWQtc2FmZS4KLSAqKkF1ZGl0IG93bmVyc2hpcDoqKiBgRU5EX1NISUZUYCBpcyB3cml0dGVuIGJ5IGBjbG9zZV9zZXNzaW9uKCdFTkRFRCcpYCBpbnNpZGUgaXRzIG93biB0cmFuc2FjdGlvbiAoMi4zKSwgc28gdGhlIHJvdXRlIG5ldmVyIHdyaXRlcyBpdC4gYFNUQVJUX01PTklUT1JJTkdgIGlzIHdyaXR0ZW4gYnkgdGhlIHJvdXRlIG9ubHkgd2hlbiBgc3RhcnRfbW9uaXRvcmluZ2AgcmVwb3J0cyBhIGNoYW5nZSwgc28gYSBzZWNvbmQgY2FsbCBhZGRzIG5vIHJvdy4gYEFDS19BTEVSVGAsIGBBQ0tfRVBJU09ERWAgYW5kIGBSRVNPTFZFX0VQSVNPREVgIGFyZSB3cml0dGVuIGZvciBldmVyeSBhY2NlcHRlZCBjYWxsLiBBIHJlZnVzZWQgY2FsbCAoNDAwLCA0MDQsIDQwOSwgNDIyKSB3cml0ZXMgbm8gcm93LCBiZWNhdXNlIGBhdWRpdF9hY3Rpb25zYCBoYXMgbm8gcmVqZWN0aW9uIGFjdGlvbnMgYXBhcnQgZnJvbSBgTE9HSU5fUkVKRUNURURgIGFuZCBgT1JJR0lOX1JFSkVDVEVEYC4KLSAqKkNoZWNrIG9yZGVyIG9mIEVuZCBzaGlmdDoqKiB3cm9uZyBgY29uZmlybV90ZXh0YCA0MDAsIHRoZW4gcmVjb3ZlcmluZyA0MDkgYFJFQ09WRVJJTkdgIChgcmV0cnlfYWZ0ZXJfc2AgPSBgcmVjb3ZlcmluZ190YXJnZXRfc2ApLCB0aGVuIGEgYHNlc3Npb25faWRgIHRoYXQgaXMgbm90IHRoZSBvcGVuIHNlc3Npb24gNDA5IGBTVEFURV9DT05GTElDVGAuIGBjb25maXJtX3RleHRgIGlzIGEgcGxhaW4gc3RyaW5nIGluIHRoZSBtb2RlbCBzbyBhIHdyb25nIHZhbHVlIGlzIDQwMCwgbm90IGEgNDIyIHNjaGVtYSBmYWlsdXJlLiBUaGUgcG9ydCByZXBlYXRzIHRoZSBzZXNzaW9uIGNoZWNrIGF0b21pY2FsbHkgYW5kIG1heSBzdGlsbCByYWlzZSBgU1RBVEVfQ09ORkxJQ1RgLgotICoqQWNrbm93bGVkZ2Ugc2VtYW50aWNzIHRoZSByZWFsIHBvcnQgbXVzdCBrZWVwIChQMjQpOioqIGFuIGFsZXJ0IEFja25vd2xlZGdlIGlzIGEgMjAwIGFsc28gZm9yIGFuIGFsZXJ0IHRoYXQgYWxyZWFkeSBjbGVhcmVkLCBhbmQgYSByZXBlYXQgcmV0dXJucyB0aGUgZmlyc3QgYGFja25vd2xlZGdlZF90c2AgYW5kIGBhY2tub3dsZWRnZWRfYnlgLiBBbiBlcGlzb2RlIEFja25vd2xlZGdlIG9uIGFuIGBBQ0tOT1dMRURHRURgIGVwaXNvZGUgaXMgYW4gaWRlbXBvdGVudCAyMDAgd2l0aCB0aGUgc3RvcmVkIHZhbHVlczsgb24gYSBgUkVTT0xWRURgIGVwaXNvZGUgaXQgaXMgNDA5IGBTVEFURV9DT05GTElDVGAsIGJlY2F1c2UgdGhlIGFuc3dlcidzIGBzdGF0ZTogJ0FDS05PV0xFREdFRCdgIHdvdWxkIGJlIGZhbHNlICgzLjggbGlzdHMgb25seSA0MDQgZm9yIHRoaXMgcm91dGU7IHByb3Bvc2FsKS4gUmVzb2x2ZSBvZiBhIGBSRVNPTFZFRGAgZXBpc29kZSBpcyA0MDkgYFNUQVRFX0NPTkZMSUNUYCAoMy44KS4gYGxhdGNoX3N0aWxsX3NldGAgaXMgdGhlIG5vZGUncyBgbWFuZG93bl9wcmV2YCBhZnRlciBSZXNvbHZlLgotICoqQXVkaXQgZGV0YWlsIChwcm9wb3NhbCk6KiogYEFDS19BTEVSVGAgY2FycmllcyBgcmVhc29uID0gJ2FsZXJ0X2lkIDxuPidgLCBiZWNhdXNlIGBhdWRpdF9ldmVudHNgIGhhcyBubyBhbGVydCBjb2x1bW4uCi0gKipOb3QgaW4gdGhpcyBQYXJ0OioqIHRoZSBlbmdpbmUgd2lyaW5nIGJlaGluZCB0aGUgcG9ydCAoUDI0KSwgdGhlIHJlYWwgYGF1dGhlbnRpY2F0ZWAgYW5kIGxvZ2luIGJhY2tvZmYgKFAxOWIpLCBgR0VUIC9hcGkvc2Vzc2lvbnNgIGFuZCB0aGUgcmVtYWluaW5nIGVuZHBvaW50cyAoUDE5YykuCg==');
  append('docs/PROGRESS.md', '- Part 19-2 done: api/api_rest.py gains POST /api/session/start (idempotent, one START_MONITORING row), POST /api/session/end (400 wrong confirm_text, 409 RECOVERING with retry_after_s, 409 STATE_CONFLICT for a stale session_id, port awaited in a worker thread, END_SHIFT written by close_session), POST /api/alerts/{id}/ack (200 also for a cleared alert), POST /api/episodes/{id}/ack and /resolve (reason outside the three is 422, latch_still_set returned, second Resolve 409) over six new Port methods; REST bodies appended to api/models.py, host/tests/test_api_actions.py (37 tests), docs/adr/0007.md; the engine wiring behind the port is P24, token hashing and Origin checks are P19b, GET /api/sessions and the remaining endpoints are P19c');
}
