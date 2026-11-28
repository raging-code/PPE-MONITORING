"""api/api_rest.py (P19-1): the REST shell of design 3.8: app factory, error envelope, bearer-token dependency, POST /api/login and GET /api/events.
The host process (P24) is behind the Port protocol below, so this file does no engine work and owns no event_seq: audit rows and the open session come through the port.
Reads open their own read-only connection inside the thread pool, never on the event loop. Token hashing, the failed-login delay and the Origin/Host checks are P19b: the
port's authenticate() is where P19b plugs in, and until then a failed login answers retry_after_s null. /docs and /openapi.json are not served (frozen endpoint list)."""
import asyncio, logging, time
from typing import NamedTuple, Optional, Protocol
from fastapi import APIRouter, Depends, FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from ..io.db_writer import connect_db
from ..services import csv_export
from . import models as M, pin_auth, security as sec

log = logging.getLogger('ppe.api')
class Operator(NamedTuple):
    operator_id: int
    display_name: str
class Port(Protocol):  # implemented by the host process (P24); tests use a fake
    def authenticate(self, token: str) -> Optional[Operator]: ...  # None for a missing, wrong or disabled-operator token
    def audit(self, action: str, operator_id: Optional[int] = None, node_id: Optional[int] = None, episode_id: Optional[int] = None, reason: Optional[str] = None) -> None: ...
    def session_id(self) -> int: ...
    def login_failed(self) -> Optional[float]: ...  # P19b: the delay for this failed login (retry_after_s), None for no delay
    def login_ok(self) -> None: ...  # P19b: a successful login resets the delay
    # P28-4a (ADR 0056). The three methods block (scrypt, the commit wait), so the routes call them in a worker thread.
    def pin_login(self, display_name: str, pin: str) -> 'pin_auth.PinResult': ...  # the scrypt check, then the failure count and the lock through the writer
    def start_login_session(self, operator_id: int, remember: bool) -> tuple: ...  # (session_token, expires_ts); the row is committed before this returns
    def logout(self, token: str) -> bool: ...  # revokes the login session of this token; False when there is nothing to revoke (an operator token)
    # P19-2. A method raises ApiError for a conflict and returns None for an unknown id. The host owns every write and every event_seq.
    def recovering_retry_s(self) -> Optional[float]: ...  # recovering_target_s while recovering, else None
    def start_monitoring(self, operator_id: int, session_label: Optional[str]) -> tuple: ...  # (SessionRow, changed); idempotent: sets operator_id only while NULL, never changes label or a second START_MONITORING
    def end_session(self, session_id: int, operator_id: int) -> 'EndResult': ...  # close_session('ENDED') incl. its END_SHIFT audit row, then the backup; runs in a worker thread; ApiError STATE_CONFLICT if session_id is no longer open
    def ack_alert(self, alert_id: int, operator_id: int) -> Optional['AlertAck']: ...  # idempotent; also for a cleared alert
    def ack_episode(self, episode_id: int, operator_id: int) -> Optional['EpisodeAck']: ...  # idempotent when ACKNOWLEDGED; ApiError STATE_CONFLICT when RESOLVED
    def resolve_episode(self, episode_id: int, reason: str, operator_id: int) -> Optional['EpisodeResolve']: ...  # ApiError STATE_CONFLICT when already RESOLVED
    # P19c-2
    def set_scba_correction(self, node_id: int, note: Optional[str], operator_id: int) -> Optional['ScbaRecord']: ...  # live state only; None when node_id is not in the roster; the audit row is written by the route
    def ack_banner(self, kind: str, operator_id: int) -> 'BannerAck': ...  # ApiError STATE_CONFLICT when the banner is not active or is already acknowledged (design 3.8 error-code list)

class ApiError(Exception):
    """Any non-2xx answer. The envelope model refuses a code outside the 3.8 list and a retry_after_s on a code that may not carry one."""
    def __init__(self, status, code, detail, retry_after_s=None):
        super().__init__(detail); self.status = status; self.env = M.ErrorEnvelope(error_code=code, detail=detail, retry_after_s=retry_after_s)
def _reply(status, code, detail, retry_after_s=None):
    return JSONResponse(M.ErrorEnvelope(error_code=code, detail=detail, retry_after_s=retry_after_s).model_dump(), status_code=status)

_sleep = asyncio.sleep  # the failed-login delay; tests replace it
router = APIRouter(prefix='/api')
def create_app(port, db_path, bind_port=8420):
    app = FastAPI(title='PPE Monitoring host', docs_url=None, redoc_url=None, openapi_url=None)
    app.state.port, app.state.db_path, app.state.bind_port = port, db_path, bind_port
    app.include_router(router)
    @app.middleware('http')
    async def _origin(request, call_next):  # P19b: Host and Origin on every call, before the token is looked at (design 4); a rejection is audited as ORIGIN_REJECTED
        if not sec.origin_ok(request.headers.get('origin'), request.headers.get('host'), bind_port):
            port.audit('ORIGIN_REJECTED'); return _reply(403, 'ORIGIN_REJECTED', 'origin or host not allowed')
        return await call_next(request)
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
    if op is None: request.app.state.port.audit('LOGIN_REJECTED'); raise ApiError(401, 'UNAUTHENTICATED', 'missing, invalid or disabled token')
    return op

@router.post('/login', response_model=None)  # the token form answers M.LoginResp and the PIN form M.PinLoginResp: two key sets, so no single response model
async def login(body: M.LoginReq, request: Request):
    port = request.app.state.port
    if body.token is None: return await _pin_login(port, body)
    op = port.authenticate(body.token)
    if op is None:
        port.audit('LOGIN_REJECTED'); delay = port.login_failed()
        if delay: await _sleep(delay)  # slows guessing without locking a valid token out
        raise ApiError(401, 'UNAUTHENTICATED', 'invalid token', delay)
    port.login_ok(); port.audit('LOGIN_OK', operator_id=op.operator_id)
    return M.LoginResp(operator_id=op.operator_id, display_name=op.display_name, session_id=port.session_id())

async def _pin_login(port, body):
    """P28-4a (ADR 0056): display name + PIN. The scrypt check and the lock write run in a worker thread, and the session is committed before its token is returned.
    An unknown name, a wrong PIN, an operator without a PIN and a disabled operator give the same 401 with the same growing delay; only a locked operator answers differently (no delay, retry_after_s is the seconds left)."""
    r = await run_in_threadpool(port.pin_login, body.display_name, body.pin)
    if r.status == 'ok':
        token, expires = await run_in_threadpool(port.start_login_session, r.operator.operator_id, body.remember)
        port.login_ok(); port.audit('LOGIN_OK', operator_id=r.operator.operator_id, reason='pin')
        return M.PinLoginResp(operator_id=r.operator.operator_id, display_name=r.operator.display_name, session_id=port.session_id(), session_token=token, expires_ts=expires)
    if r.newly_locked: port.audit('LOGIN_LOCKED', operator_id=r.operator_id, reason='pin')
    port.audit('LOGIN_REJECTED', reason='pin')
    if r.status == 'locked': raise ApiError(401, 'UNAUTHENTICATED', 'PIN login is locked for this operator: use the operator token or wait', r.retry_after_s)
    delay = port.login_failed()
    if delay: await _sleep(delay)
    raise ApiError(401, 'UNAUTHENTICATED', 'invalid name or PIN', delay)

@router.post('/logout', response_model=M.LogoutResp)
async def logout(request: Request, authorization: Optional[str] = Header(None), op: Operator = Depends(current_operator)):
    """P28-4a: revokes the login session of the bearer token. An operator token has no session: nothing is revoked and the answer is still 200 with logged_out false."""
    port = request.app.state.port; revoked = await run_in_threadpool(port.logout, authorization.partition(' ')[2].strip())
    port.audit('LOGOUT', operator_id=op.operator_id, reason='session' if revoked else 'operator token')
    return M.LogoutResp(logged_out=revoked)

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
@router.get('/export.csv')
async def export_csv(request: Request, session_id: Optional[int] = Query(None, ge=0), op: Operator = Depends(current_operator)):
    """P26-1 (ADR 0038): v_full_log as text/csv, the whole database or one session; the file is read in 500-row chunks on a read-only connection in a worker thread and streamed. CSV_EXPORT is audited before the first byte
    (a failed audit write is a 500 and nothing is sent). A session_id that does not exist gives the header row only: the frozen list (3.8) has no 404 for this endpoint."""
    port = request.app.state.port; port.audit('CSV_EXPORT', operator_id=op.operator_id, reason='all' if session_id is None else str(session_id))
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(_now_ms() / 1000)); name = 'export_%s_%s.csv' % ('all' if session_id is None else 'session_%d' % session_id, stamp)
    return StreamingResponse(iterate_in_threadpool(csv_export.iter_csv(request.app.state.db_path, session_id)), media_type='text/csv', headers={'Content-Disposition': 'attachment; filename="%s"' % name, 'Cache-Control': 'no-store'})

# ---- P19-2: session start and end, Acknowledge and Resolve (design 3.8) ----
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
# ---- P19c-1: GET /api/sessions and POST /api/dashboard-outage (design 3.8, 3.10) ----
# Both read the clock through _now_ms (tests replace it; the api layer may read the clock, core/ may not). Neither needs a new Port method: the sessions list is a
# read-only query in a worker thread (like GET /api/events, no audit row), and the outage route only validates and writes one audit row through port.audit.
import time as _time
_now_ms = lambda: int(_time.time() * 1000)
SESSIONS_SQL = ("SELECT s.session_id, s.started_ts, s.ended_ts, s.mode, s.session_label, s.end_kind, "
                "(SELECT COUNT(*) FROM alerts a WHERE a.session_id = s.session_id), "
                "(SELECT COUNT(*) FROM episodes e WHERE e.session_id = s.session_id AND e.state != 'RESOLVED') "
                "FROM sessions s ORDER BY s.session_id DESC LIMIT ?")
HIGHEST_SQL = ("SELECT session_id, node_id, MAX(CASE level WHEN 'DANGER' THEN 2 WHEN 'WARNING' THEN 1 ELSE 0 END) AS rank FROM alerts "
               "WHERE session_id IN (%s) AND node_id IS NOT NULL GROUP BY session_id, node_id HAVING rank > 0")
LEVEL_OF_RANK = {1: 'WARNING', 2: 'DANGER'}
def query_sessions(db_path, limit, now_ms):
    """Runs in a worker thread, newest session first. It reads sessions, alerts and episodes only, never the frames table, so it stays fast on a 24 h database."""
    c = connect_db(db_path, readonly=True)
    try:
        c.execute('BEGIN')  # one snapshot for both statements
        rows = c.execute(SESSIONS_SQL, (limit,)).fetchall()
        top = {}
        if rows:
            for sid, node, rank in c.execute(HIGHEST_SQL % ','.join('?' * len(rows)), [r[0] for r in rows]): top.setdefault(sid, {})[str(node)] = LEVEL_OF_RANK[rank]
    finally: c.close()
    return [M.SessionListRow(session_id=sid, started_ts=st, ended_ts=en, duration_s=max(0, ((en if en is not None else now_ms) - st) / 1000), mode=mode, session_label=label,
                             end_kind=kind, alert_count=na, unresolved_episodes=ne, highest_level_by_node=top.get(sid, {})) for sid, st, en, mode, label, kind, na, ne in rows]

@router.get('/sessions', response_model=list[M.SessionListRow])
async def sessions(request: Request, limit: int = Query(50, ge=1, le=500), op: Operator = Depends(current_operator)):
    return await run_in_threadpool(query_sessions, request.app.state.db_path, limit, _now_ms())  # read-only, no audit row

OUTAGE_MAX_S, OUTAGE_TOLERANCE_MS = 86400, 1000  # design 3.8: at most 86400 s, duration_s within 1 s of the difference
@router.post('/dashboard-outage', response_model=M.OutageResp)
async def dashboard_outage(body: M.OutageReq, request: Request, op: Operator = Depends(current_operator)):
    port, now = request.app.state.port, _now_ms()
    def bad(why): raise ApiError(422, 'VALIDATION_ERROR', why)  # a refused report writes no audit row (ADR 0010)
    if body.ended_ts < body.started_ts: bad('ended_ts is before started_ts')
    if body.started_ts > now or body.ended_ts > now: bad('started_ts and ended_ts must not be in the future')
    if body.duration_s > OUTAGE_MAX_S: bad('duration_s is over %d' % OUTAGE_MAX_S)
    if abs(body.duration_s * 1000 - (body.ended_ts - body.started_ts)) > OUTAGE_TOLERANCE_MS: bad('duration_s differs from ended_ts - started_ts by more than 1 s')
    port.audit('DASHBOARD_OUTAGE', operator_id=op.operator_id, reason='started_ts %d ended_ts %d duration_s %g' % (body.started_ts, body.ended_ts, body.duration_s))
    return M.OutageResp(logged=True)
# ---- P19c-2: POST /api/scba-correction and POST /api/system-banners/{kind}/ack (design 3.8) ----
# The host owns the live state and every write (ADR 0011). SCBA correction is display state only: it is never an input of the rule engine, so it cannot clear
# scba_expired or suppress an ambient CO alert. The latest correction of each node is re-applied after a restart by io/db_writer.load_scba_corrections.
from typing import get_args as _get_args
class ScbaRecord(NamedTuple):
    recorded_ts: int
    operator: str
class BannerAck(NamedTuple):
    kind: str
    acknowledged_ts: int
BANNER_KINDS = ('no_live_data', 'base_offline', 'logging_fault', 'host_gap', 'recovering', 'host_power', 'audio_fault', 'abi_mismatch')  # the banners of alert_catalog.json (a test compares)

@router.post('/scba-correction', response_model=M.ScbaCorrection)
async def scba_correction(body: M.ScbaCorrectionReq, request: Request, op: Operator = Depends(current_operator)):
    port = request.app.state.port; r = port.set_scba_correction(body.node_id, body.note, op.operator_id)  # None for a node that is not in the roster
    if r is None: raise ApiError(404, 'NOT_FOUND', 'unknown node')
    port.audit('SCBA_CORRECTION', operator_id=op.operator_id, node_id=body.node_id, reason=body.note)
    return M.ScbaCorrection(recorded_ts=r.recorded_ts, operator=r.operator)

@router.post('/system-banners/{kind}/ack', response_model=M.BannerAckResp)
async def ack_banner(kind: str, request: Request, op: Operator = Depends(current_operator), body: Optional[M.EmptyReq] = None):
    if kind not in BANNER_KINDS: raise ApiError(404, 'NOT_FOUND', 'unknown banner kind')
    if kind not in _get_args(M.BannerKind): raise ApiError(400, 'BAD_REQUEST', 'this banner cannot be acknowledged')  # host_gap and logging_fault only
    port = request.app.state.port; r = port.ack_banner(kind, op.operator_id)  # the port raises ApiError STATE_CONFLICT for a banner that is not active or is already acknowledged; a refused call writes no audit row
    port.audit('BANNER_ACK', operator_id=op.operator_id, reason=kind)
    return M.BannerAckResp(kind=r.kind, acknowledged_ts=r.acknowledged_ts)
