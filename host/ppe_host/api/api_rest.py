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
