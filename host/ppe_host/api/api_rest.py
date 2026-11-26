"""api/api_rest.py (P19-1): the REST shell of design 3.8: app factory, error envelope, bearer-token dependency, POST /api/login and GET /api/events.
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
    # P19-2. A method raises ApiError for a conflict and returns None for an unknown id. The host owns every write and every event_seq.
    def recovering_retry_s(self) -> Optional[float]: ...  # recovering_target_s while recovering, else None
    def start_monitoring(self, operator_id: int, session_label: Optional[str]) -> tuple: ...  # (SessionRow, changed); idempotent: sets operator_id only while NULL, never changes label or a second START_MONITORING
    def end_session(self, session_id: int, operator_id: int) -> 'EndResult': ...  # close_session('ENDED') incl. its END_SHIFT audit row, then the backup; runs in a worker thread; ApiError STATE_CONFLICT if session_id is no longer open
    def ack_alert(self, alert_id: int, operator_id: int) -> Optional['AlertAck']: ...  # idempotent; also for a cleared alert
    def ack_episode(self, episode_id: int, operator_id: int) -> Optional['EpisodeAck']: ...  # idempotent when ACKNOWLEDGED; ApiError STATE_CONFLICT when RESOLVED
    def resolve_episode(self, episode_id: int, reason: str, operator_id: int) -> Optional['EpisodeResolve']: ...  # ApiError STATE_CONFLICT when already RESOLVED

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
