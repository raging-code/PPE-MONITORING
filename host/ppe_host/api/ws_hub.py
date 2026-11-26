"""api/ws_hub.py (P20): the /ws data socket and the /ws/tick socket of design 3.8, 1 (slow clients) and 5. No engine work and no database access of its own.
The host (P24) gives the hub a Source and calls publish_*(body) for each thing the engine does. A body is the message without its envelope; each connection's sender task
adds v, srv_seq and srv_ts when it sends, so srv_seq never has a gap, even when readings are coalesced in that connection's queue (docs/adr/0012.md).
HTTP middleware does not see WebSockets, so the Origin/Host rule (security.origin_ok) and the token are checked here. Close codes: 4401, 4403, 4408 and 1000."""
import asyncio, collections, json, logging, time, uuid
from contextlib import asynccontextmanager
from typing import Callable, Optional, Protocol
from fastapi import FastAPI, WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketState
from . import models as M, security as sec

log = logging.getLogger('ppe.ws')
UNAUTH_MIN_S = 1.0   # a coalesced unauth_alert repeat is broadcast at most once per second (3.8)
HB_FRESH_S = 3.0     # a /ws tab counts as connected while its last client hb is younger than this
RECHECK_S = 5        # every 5th tick the tokens of open sockets are checked again, so a disabled operator's socket closes (ADR 0008)
class Source(Protocol):  # implemented by the host process (P24); tests use a fake
    def authenticate(self, token: str): ...        # an Operator or None (Port.authenticate)
    def audit(self, action: str, **kw) -> None: ...  # ORIGIN_REJECTED, LOGIN_REJECTED
    def snapshot(self) -> dict: ...                # every SnapshotMsg field except v, type, srv_seq, srv_ts and epoch; called on the event loop
    def client_dropped(self, detail: str) -> None: ...  # writes the CLIENT_DROPPED system_events row

class Conn:
    def __init__(self, ws, kind, token, op):
        self.ws, self.kind, self.token, self.op, self.q, self.seq, self.wake, self.last_hb = ws, kind, token, op, collections.deque(), 0, asyncio.Event(), None
        self.closing, self.ready, self.dead = False, False, False   # dead: being dropped as too slow, offered nothing more

class Hub:
    def __init__(self, source, bind_port=8420, queue_max=64, send_timeout_s=1.0, auth_timeout_s=3.0, wall_ms: Callable = None, mono: Callable = None, on_tick: Optional[Callable] = None, tick_s=1.0):
        self.src, self.bind_port, self.queue_max, self.send_timeout_s, self.auth_timeout_s = source, bind_port, queue_max, send_timeout_s, auth_timeout_s
        self.wall_ms = wall_ms or (lambda: int(time.time() * 1000)); self.mono = mono or time.monotonic; self.on_tick, self.tick_s = on_tick, tick_s
        self.epoch = str(uuid.uuid4()); self.conns, self._tick_task, self._tick_n, self._unauth = set(), None, 0, {}
    # ---- publishing (called on the event loop by the host) ----
    def _offer(self, c, body):
        if c.dead: return
        t = body['type']
        if t == 'tick':   # only the newest tick matters
            for i, b in enumerate(c.q):
                if b['type'] == 'tick': del c.q[i]; break
        elif len(c.q) >= self.queue_max:   # full: coalesce the oldest queued reading (same node first), else this client is too slow
            for want in (body.get('node_id') if t == 'reading' else None, None):
                hit = next((i for i, b in enumerate(c.q) if b['type'] == 'reading' and (want is None or b['node_id'] == want)), None)
                if hit is not None: del c.q[hit]; break
            else:
                c.dead = True; self.src.client_dropped('send queue full (%d) on %s' % (self.queue_max, c.kind)); asyncio.ensure_future(self._close(c, 4408)); return
        c.q.append(body); c.wake.set()
    def publish(self, body, kinds=('/ws',)):
        for c in tuple(self.conns):
            if c.kind in kinds and c.ready and not c.closing: self._offer(c, dict(body))
    def publish_reading(self, b): self.publish(dict(b, type='reading'))
    def publish_episode(self, b): self.publish(dict(b, type='episode'))
    def publish_link(self, b): self.publish(dict(b, type='link'))
    def publish_system(self, b): self.publish(dict(b, type='system'))
    def publish_advisory(self, b): self.publish(dict(b, type='advisory'))
    def publish_alert(self, b):
        """Raise, clear, level change, Acknowledge: sent at once. A repeat of an open, unacknowledged unauth_alert is held and sent at most once per second."""
        aid, now = b.get('alert_id'), self.mono(); msg = dict(b, type='alert')
        if b.get('alert_type') != 'unauth_alert' or b.get('cleared_ts') is not None or b.get('acknowledged_ts') is not None:
            self._unauth.pop(aid, None); self.publish(msg); return
        last, _ = self._unauth.get(aid, (None, None))
        if last is None or now - last >= UNAUTH_MIN_S: self._unauth[aid] = (now, None); self.publish(msg)
        else: self._unauth[aid] = (last, msg)   # newest repeat wins; the tick loop sends it
    def _flush_unauth(self):
        now = self.mono()
        for aid, (last, held) in list(self._unauth.items()):
            if held is not None and now - last >= UNAUTH_MIN_S: self._unauth[aid] = (now, None); self.publish(held)
    def connected_tabs(self):
        now = self.mono(); return sum(1 for c in self.conns if c.kind == '/ws' and c.last_hb is not None and now - c.last_hb < HB_FRESH_S)
    # ---- tick ----
    async def tick_loop(self):
        nxt = self.mono()
        while True:
            self._tick_n += 1
            if self.on_tick: self.on_tick()   # the watchdog liveness stamp of the 1 Hz timer (1, stall timing)
            self._flush_unauth()
            for c in tuple(self.conns):
                if c.ready and not c.closing: self._offer(c, {'type': 'tick'})
            if self._tick_n % RECHECK_S == 0: await self._recheck()
            nxt += self.tick_s; await asyncio.sleep(max(0.0, nxt - self.mono()))
    async def _recheck(self):
        for c in tuple(self.conns):
            if c.closing: continue
            op = await asyncio.to_thread(self.src.authenticate, c.token)
            if op is None: await self._close(c, 4401)
    def start(self):
        if self._tick_task is None: self._tick_task = asyncio.ensure_future(self.tick_loop())
    async def shutdown(self):
        if self._tick_task: self._tick_task.cancel(); self._tick_task = None
        for c in tuple(self.conns): await self._close(c, 1000)
    # ---- one connection ----
    async def _close(self, c, code):
        if c.closing: return
        c.closing = True
        try:
            if c.ws.application_state == WebSocketState.CONNECTED: await asyncio.wait_for(c.ws.close(code), 1.0)
        except Exception: pass
        self.conns.discard(c); c.wake.set()
    async def _sender(self, c):
        try:
            while not c.closing:
                if not c.q: c.wake.clear(); await c.wake.wait(); continue
                body = c.q.popleft(); body.update(v=1, srv_seq=c.seq, srv_ts=self.wall_ms())
                try: await asyncio.wait_for(c.ws.send_text(json.dumps(body, separators=(',', ':'))), self.send_timeout_s)
                except asyncio.TimeoutError:
                    c.dead = True; self.src.client_dropped('send timeout over %.1f s on %s' % (self.send_timeout_s, c.kind)); await self._close(c, 4408); return
                except Exception: await self._close(c, 1000); return   # the socket is already gone
                c.seq += 1
        except asyncio.CancelledError: pass
    async def serve(self, ws: WebSocket, kind):
        h = ws.headers
        await ws.accept()   # accepted first, so a browser sees the close code (a refusal before accept shows as 1006)
        stub = Conn(ws, kind, '', None)
        if not sec.origin_ok(h.get('origin'), h.get('host'), self.bind_port):
            self.src.audit('ORIGIN_REJECTED'); await self._close(stub, 4403); return
        try:
            raw = await asyncio.wait_for(ws.receive_text(), self.auth_timeout_s); msg = M.parse_client(raw)
        except (asyncio.TimeoutError, WebSocketDisconnect): await self._close(stub, 4401); return
        except Exception: self.src.audit('LOGIN_REJECTED'); await self._close(stub, 4401); return   # anything but an auth message first
        op = self.src.authenticate(msg.token) if msg.type == 'auth' else None
        if op is None: self.src.audit('LOGIN_REJECTED'); await self._close(stub, 4401); return
        c = Conn(ws, kind, msg.token, op); self.conns.add(c)
        if kind == '/ws': snap = dict(self.src.snapshot(), type='snapshot', epoch=self.epoch); c.q.append(snap)   # built and queued with no await between: no increment can slip before it
        c.ready = True; c.wake.set(); sender = asyncio.ensure_future(self._sender(c))
        try:
            while not c.closing:
                try: m = M.parse_client(await ws.receive_text())
                except WebSocketDisconnect: break
                except asyncio.CancelledError: raise
                except Exception:   # an unknown or malformed message after auth is ignored (ADR 0012); a dead socket ends the loop
                    if ws.client_state != WebSocketState.CONNECTED: break
                    continue
                if m.type == 'hb' and kind == '/ws': c.last_hb = self.mono()
        finally:
            c.closing = True; self.conns.discard(c); sender.cancel()
            try:
                if ws.application_state == WebSocketState.CONNECTED: await ws.close(1000)
            except Exception: pass

def install(app: FastAPI, hub: Hub):
    """Adds /ws and /ws/tick to the app (P24 calls this after create_app) and starts the tick loop with the app."""
    @app.websocket('/ws')
    async def _ws(ws: WebSocket): await hub.serve(ws, '/ws')
    @app.websocket('/ws/tick')
    async def _wst(ws: WebSocket): await hub.serve(ws, '/ws/tick')
    inner = app.router.lifespan_context
    @asynccontextmanager
    async def _life(a):
        hub.start()
        async with inner(a): yield
        await hub.shutdown()
    app.router.lifespan_context = _life
    app.state.ws_hub = hub
