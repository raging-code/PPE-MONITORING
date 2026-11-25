// patches/part19_1_rest_shell.mjs  (run from repo root: node patches/part19_1_rest_shell.mjs [--dry] [--force])
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
  put('host/ppe_host/api/api_rest.py', String.raw`"""api/api_rest.py (P19-1): the REST shell of design 3.8: app factory, error envelope, bearer-token dependency, POST /api/login and GET /api/events.
The host process (P24) is behind the Port protocol below, so this file does no engine work and owns no event_seq: audit rows and the open session come through the port.
Reads open their own read-only connection inside the thread pool, never on the event loop. Token hashing, the failed-login delay and the Origin/Host checks are P19b: the
port's authenticate() is where P19b plugs in, and until then a failed login answers retry_after_s null. /docs and /openapi.json are not served (frozen endpoint list)."""
import logging
from typing import NamedTuple, Optional, Protocol
from fastapi import APIRouter, Depends, FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from ..io.db_writer import connect_db
from . import models as M

log = logging.getLogger('ppe.api')
class Operator(NamedTuple):
    operator_id: int
    display_name: str
class Port(Protocol):  # implemented by the host process (P24); tests use a fake
    def authenticate(self, token: str) -> Optional[Operator]: ...  # None for a missing, wrong or disabled-operator token
    def audit(self, action: str, operator_id: Optional[int] = None, node_id: Optional[int] = None, episode_id: Optional[int] = None, reason: Optional[str] = None) -> None: ...
    def session_id(self) -> int: ...

class ApiError(Exception):
    """Any non-2xx answer. The envelope model refuses a code outside the 3.8 list and a retry_after_s on a code that may not carry one."""
    def __init__(self, status, code, detail, retry_after_s=None):
        super().__init__(detail); self.status = status; self.env = M.ErrorEnvelope(error_code=code, detail=detail, retry_after_s=retry_after_s)
def _reply(status, code, detail, retry_after_s=None):
    return JSONResponse(M.ErrorEnvelope(error_code=code, detail=detail, retry_after_s=retry_after_s).model_dump(), status_code=status)

router = APIRouter(prefix='/api')
def create_app(port, db_path):
    app = FastAPI(title='PPE Monitoring host', docs_url=None, redoc_url=None, openapi_url=None)
    app.state.port, app.state.db_path = port, db_path
    app.include_router(router)
    @app.exception_handler(ApiError)
    async def _api(request, e): return JSONResponse(e.env.model_dump(), status_code=e.status)
    @app.exception_handler(RequestValidationError)
    async def _invalid(request, e):  # loc and message only: the submitted value (a token) is never echoed
        return _reply(422, 'VALIDATION_ERROR', '; '.join('%s: %s' % ('.'.join(str(p) for p in x['loc']), x['msg']) for x in e.errors()))
    @app.exception_handler(StarletteHTTPException)
    async def _http(request, e):
        code = {404: 'NOT_FOUND', 401: 'UNAUTHENTICATED'}.get(e.status_code, 'INTERNAL_ERROR' if e.status_code >= 500 else 'BAD_REQUEST')
        return _reply(e.status_code, code, str(e.detail))
    @app.exception_handler(Exception)
    async def _boom(request, e): log.exception('unhandled error on %s', request.url.path); return _reply(500, 'INTERNAL_ERROR', 'internal error')
    return app

async def current_operator(request: Request, authorization: Optional[str] = Header(None)) -> Operator:
    scheme, _, token = (authorization or '').partition(' ')
    op = request.app.state.port.authenticate(token.strip()) if scheme.lower() == 'bearer' and token.strip() else None
    if op is None: raise ApiError(401, 'UNAUTHENTICATED', 'missing, invalid or disabled token')
    return op

@router.post('/login', response_model=M.LoginResp)
async def login(body: M.LoginReq, request: Request):
    port = request.app.state.port; op = port.authenticate(body.token)
    if op is None: port.audit('LOGIN_REJECTED'); raise ApiError(401, 'UNAUTHENTICATED', 'invalid token')
    port.audit('LOGIN_OK', operator_id=op.operator_id)
    return M.LoginResp(operator_id=op.operator_id, display_name=op.display_name, session_id=port.session_id())

EV_COLS = 'event_seq, log_ts, record_type, node_id, level, code, detail, operator_id'
EVENTS_SQL = 'SELECT %s FROM v_events WHERE event_seq > ? ORDER BY event_seq, log_ts LIMIT ?' % EV_COLS
SAME_SEQ_SQL = 'SELECT %s FROM v_events WHERE event_seq = ? ORDER BY log_ts' % EV_COLS
def query_events(db_path, after_seq, limit):
    """Runs in a worker thread. A page never splits the rows that share one event_seq: if the limit cuts through the last event_seq, that seq is read again in full."""
    c = connect_db(db_path, readonly=True)
    try:
        rows = c.execute(EVENTS_SQL, (after_seq, limit)).fetchall()
        if len(rows) == limit:
            last = rows[-1][0]; rows = [r for r in rows if r[0] != last] + c.execute(SAME_SEQ_SQL, (last,)).fetchall()
    finally: c.close()
    return M.EventsResp(events=[M.EventRow(**dict(zip(EV_COLS.split(', '), r))) for r in rows], last_seq=rows[-1][0] if rows else after_seq)

@router.get('/events', response_model=M.EventsResp)
async def events(request: Request, after_seq: int = Query(0, ge=0), limit: int = Query(200, ge=1, le=1000), op: Operator = Depends(current_operator)):
    return await run_in_threadpool(query_events, request.app.state.db_path, after_seq, limit)  # read-only, no audit row
`);
  put('host/tests/test_api_rest.py', String.raw`"""P19-1: REST shell (design 3.8): error envelope, bearer dependency, POST /api/login, GET /api/events. The host is a fake Port; the database is a real migrated file."""
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
`);
  putB64('docs/adr/0006.md', 'IyBBRFIgMDAwNjogUkVTVCBzaGVsbCBkZWNpc2lvbnMgZm9yIFAxOSAoUDE5LTEpCgpTdGF0dXM6IFByb3Bvc2VkIChkZWNpZGVkIGluIHRoZSBQMTktMSBzZXNzaW9uOyBjb25maXJtIGF0IHRoZSBuZXh0IGRlc2lnbiByZXZpZXcpLgpEZXNpZ246IFJldiAzLjQ1IGlzIGZyb3plbi4gTm90aGluZyBpbiB0aGUgZnJhbWUsIHRoZSBtaWdyYXRpb24gb3IgYGNvbnN0YW50cy5qc29uYCBjaGFuZ2VzLgoKLSAqKlNwbGl0OioqIFAxOSB3YXMgYWJvdXQgNDgwIGxpbmVzIGFnYWluc3QgdGhlIDM1MCBsaW1pdC4gUDE5LTEgaXMgdGhlIHNoZWxsLCBsb2dpbiBhbmQgYEdFVCAvYXBpL2V2ZW50c2AuIFAxOS0yIGlzIHNlc3Npb24gc3RhcnQgYW5kIGVuZCwgQWNrbm93bGVkZ2UgYW5kIFJlc29sdmUuIFAxOWIgKHNlY3VyaXR5KSBhbmQgUDE5YyAodGhlIHJlc3Qgb2YgdGhlIGZyb3plbiBsaXN0KSBhcmUgdW5jaGFuZ2VkLgotICoqUG9ydCBzZWFtOioqIGBhcGlfcmVzdC5weWAgdGFsa3MgdG8gdGhlIGhvc3QgdGhyb3VnaCBhIGBQb3J0YCAoYGF1dGhlbnRpY2F0ZWAsIGBhdWRpdGAsIGBzZXNzaW9uX2lkYCkuIFRoZSBlbmdpbmUsIHRoZSB3cml0ZXIgYW5kIHRoZSBvbmUgYGV2ZW50X3NlcWAgY291bnRlciBzdGF5IHdpdGggdGhlIGhvc3QgcHJvY2Vzcywgc28gYXVkaXQgcm93cyBnZXQgdGhlaXIgYGV2ZW50X3NlcWAgZnJvbSBpdCAoUDI0IGltcGxlbWVudHMgdGhlIHBvcnQpLiBQMTliIHN1cHBsaWVzIHRoZSByZWFsIGBhdXRoZW50aWNhdGVgLgotICoqRGVmZXJyZWQgdG8gUDE5YjoqKiB0aGUgZmFpbGVkLWxvZ2luIGJhY2tvZmYgKGEgZmFpbGVkIGxvZ2luIGFuc3dlcnMgYHJldHJ5X2FmdGVyX3NgIG51bGwgdW50aWwgdGhlbiksIHRoZSBPcmlnaW4gYW5kIEhvc3QgY2hlY2sgKGBPUklHSU5fUkVKRUNURURgKSBhbmQgdG9rZW4gaGFzaGluZy4KLSAqKk5vIGAvZG9jc2AsIGAvcmVkb2NgIG9yIGAvb3BlbmFwaS5qc29uYCByb3V0ZXM6KiogdGhlIGVuZHBvaW50IGxpc3QgaXMgZnJvemVuIGFuZCBhIHRlc3QgY291bnRzIHJvdXRlcyBpbiBQMTljLiBgc2hhcmVkL29wZW5hcGkuanNvbmAgaXMgZXhwb3J0ZWQgZnJvbSBgYXBwLm9wZW5hcGkoKWAsIHdoaWNoIHdvcmtzIHdpdGhvdXQgdGhlIHJvdXRlLCBvbmNlIFAxOWMgaGFzIGV2ZXJ5IGVuZHBvaW50LgotICoqRW52ZWxvcGUgbWFwcGluZzoqKiBhIHJvdXRlIHRoYXQgZG9lcyBub3QgZXhpc3QgaXMgNDA0IGBOT1RfRk9VTkRgOyBhIHdyb25nIG1ldGhvZCAoNDA1KSB1c2VzIGBCQURfUkVRVUVTVGAsIGJlY2F1c2UgdGhlIDMuOCBsaXN0IGhhcyBubyA0MDUgY29kZTsgYW55IHVuaGFuZGxlZCBlcnJvciBpcyA1MDAgYElOVEVSTkFMX0VSUk9SYCB3aXRoIGEgZml4ZWQgdGV4dCBhbmQgbm8gZXhjZXB0aW9uIHRleHQuIEEgNDIyIG5hbWVzIG9ubHkgdGhlIGZpZWxkIGFuZCB0aGUgcnVsZSwgbmV2ZXIgdGhlIHN1Ym1pdHRlZCB2YWx1ZS4KLSAqKkV2ZW50cyBwYWdpbmc6KiogYWZ0ZXIgcmVhZGluZyBgbGltaXRgIHJvd3MsIGlmIHRoZSBsYXN0IGBldmVudF9zZXFgIG1heSBjb250aW51ZSwgdGhhdCBgZXZlbnRfc2VxYCBpcyByZWFkIGFnYWluIGluIGZ1bGwsIHNvIGEgcGFnZSBjYW4gaG9sZCBtb3JlIHRoYW4gYGxpbWl0YCByb3dzIGFuZCBuZXZlciBzcGxpdHMgYSBzZXEuIGBsYXN0X3NlcWAgaXMgdGhlIGxhc3Qgcm93J3MgYGV2ZW50X3NlcWAsIG9yIGBhZnRlcl9zZXFgIHdoZW4gdGhlcmUgYXJlIG5vbmUuCg==');
  append('host/ppe_host/api/models.py', String.raw`# ---- REST bodies (P19-1; the rest of the frozen endpoint list follows in P19-2 and P19c) ----
class LoginReq(_Strict):
    token: str = Field(min_length=1)
class LoginResp(_Strict):
    operator_id: int
    display_name: str
    session_id: int
EventRecordType = Literal['alert_raised', 'alert_cleared', 'audit', 'system', 'advisory']
class EventRow(_Strict):  # one row of v_events (11 DDL): never a frame row, no raw_hex, no measurement column
    event_seq: int
    log_ts: int
    record_type: EventRecordType
    node_id: Optional[int]
    level: Optional[str]
    code: str
    detail: Optional[str]
    operator_id: Optional[int]
class EventsResp(_Strict):
    events: list[EventRow]
    last_seq: int`);
  append('docs/PROGRESS.md', '- Part 19-1 done: api/api_rest.py (create_app with a Port seam for the host, error envelope for every 4xx and 5xx, bearer-token dependency, POST /api/login, GET /api/events from v_events in a worker thread with whole-event_seq paging; no /docs or /openapi.json route), REST bodies LoginReq, LoginResp, EventRow and EventsResp appended to api/models.py, host/tests/test_api_rest.py, docs/adr/0006.md; session start and end, Acknowledge and Resolve are P19-2; token hashing, login backoff and Origin checks are P19b');
}
