// patches/part20_ws_hub.mjs  (run from repo root: node patches/part20_ws_hub.mjs [--dry] [--force])
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
  put('host/ppe_host/api/ws_hub.py', String.raw`"""api/ws_hub.py (P20): the /ws data socket and the /ws/tick socket of design 3.8, 1 (slow clients) and 5. No engine work and no database access of its own.
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
`);
  put('host/tests/test_ws_hub.py', String.raw`"""P20: api/ws_hub.py, the /ws and /ws/tick sockets (design 3.8, 1, 5, 8). Real protocol tests use TestClient; slow-client, coalescing and unauth_alert tests drive Hub.serve with a fake socket."""
import asyncio, json, time
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect, WebSocketState
from ppe_host.api import api_rest as R, models as M, ws_hub as W
AUTH = json.dumps({'v': 1, 'type': 'auth', 'token': 'good-token'})
NODE = dict(node_id=1, alias='FF-01', last_rx_ts=None, co_ppm=None, temp_c=None, hum_pct=None, motion_g=None, bat_pct=None, scba=None, mandown=None, level=None, link_state='not_connected',
            status2=None, flags=None, id_mode=None, status3=None, status4=None, co_validity='VALID', co_reason=None, scba_correction=None)
SNAP = dict(recovering=False, monitoring_active=True, session=dict(session_id=4, started_ts=1, mode='LIVE', session_label=None), roster=[dict(node_id=1, alias='FF-01', active=1)],
            nodes=[NODE], open_alerts=[], open_episodes=[], co_history_30m={'1': [[1, 12.0]]}, banners=dict(base_offline=False, logging_fault=False, host_gap=None, host_power='ac', audio_fault=False), constants={'co_warn_ppm': 35.0})
def reading(n=1, co=12.0): return dict(node_id=n, alias='FF-0%d' % n, rx_ts=5, co_ppm=co, co_over_range=0, co_validity='VALID', co_reason=None, temp_c=25.0, hum_pct=50, motion_g=0.0, posture='UPRIGHT', stillness_s=0.0, bat_pct=80,
                       scba=0, mandown=0, level='NORMAL', reasons=[], seq_class='fresh', rssi=-90.0, snr=7.0, status2=0, flags=0, id_mode=65, status3=0, status4=0)
def alert(aid=1, t='man_down', **kw): return dict(dict(alert_id=aid, node_id=1, alert_type=t, level='DANGER', reasons=None, authenticated=1, episode_id=None, raised_ts=5, cleared_ts=None, acknowledged_ts=None, acknowledged_by=None, unauth_count=None, last_seen_ts=None), **kw)
SYSTEM = dict(base='ok', recovering=False, session_id=4, session_mode='LIVE', rejected_frames=0, logging_fault=False, host_gap=None, host_power='ac', audio_fault=False, banner=None, acknowledged_ts=None)
class Src:
    def __init__(self): self.audits, self.dropped, self.ok = [], [], {'good-token'}
    def authenticate(self, t): return R.Operator(1, 'Ana') if t in self.ok else None
    def audit(self, action, **kw): self.audits.append(action)
    def snapshot(self): return dict(SNAP)
    def client_dropped(self, d): self.dropped.append(d)
@pytest.fixture
def rig():
    src = Src(); hub = W.Hub(src, tick_s=0.05, auth_timeout_s=0.4); app = R.create_app(None, 'unused.db'); W.install(app, hub)
    with TestClient(app, base_url='http://127.0.0.1:8420') as client: yield client, hub, src
def recv(ws): m = json.loads(ws.receive_text()); M.parse_server(m); return m   # every message must be a valid server message
def closes(ws):
    with pytest.raises(WebSocketDisconnect) as e:
        for _ in range(200): ws.receive_text()
    return e.value.code
def open_ws(client, path='/ws', origin=None, host='127.0.0.1:8420'):   # websocket_connect ignores base_url, so the Host comes from the URL
    return client.websocket_connect('ws://%s%s' % (host, path), headers={'origin': origin} if origin else {})

def test_snapshot_then_tick_then_srv_seq_counts_from_zero(rig):
    client, hub, src = rig
    with open_ws(client) as ws:
        ws.send_text(AUTH); a, b, c = recv(ws), recv(ws), recv(ws)
        assert (a['type'], a['srv_seq'], b['type'], b['srv_seq'], c['srv_seq']) == ('snapshot', 0, 'tick', 1, 2) and a['epoch'] == hub.epoch and a['constants'] == {'co_warn_ppm': 35.0}
def test_one_epoch_per_host_start_and_each_connection_restarts_srv_seq(rig):
    client, hub, src = rig; seen = []
    for _ in range(2):
        with open_ws(client) as ws: ws.send_text(AUTH); m = recv(ws); seen.append((m['epoch'], m['srv_seq']))
    assert seen[0] == seen[1] == (hub.epoch, 0)
@pytest.mark.parametrize('first', [json.dumps({'v': 1, 'type': 'hb', 'srv_ts': 1}), json.dumps({'v': 1, 'type': 'tick'}), 'not json', json.dumps({'v': 1, 'type': 'auth', 'token': 'wrong'})])
def test_ws_rejects_anything_but_a_good_auth_first_with_4401_and_sends_nothing(rig, first):
    client, hub, src = rig
    with open_ws(client) as ws: ws.send_text(first); assert closes(ws) == 4401
    assert src.audits == ['LOGIN_REJECTED'] and hub.conns == set()
def test_no_auth_within_ws_auth_timeout_closes_4401_on_both_sockets(rig):
    client, hub, src = rig
    for path in ('/ws', '/ws/tick'):
        t0 = time.monotonic()
        with open_ws(client, path) as ws: assert closes(ws) == 4401
        assert 0.3 <= time.monotonic() - t0 < 2.0
def test_origin_or_host_rejected_is_4403_and_audited_before_any_token(rig):
    client, hub, src = rig
    with open_ws(client, origin='http://evil.example') as ws: ws.send_text(AUTH); assert closes(ws) == 4403
    with open_ws(client, '/ws/tick', origin='http://evil.example') as ws: assert closes(ws) == 4403
    with open_ws(client, host='evil.example:8420') as ws: assert closes(ws) == 4403
    assert src.audits == ['ORIGIN_REJECTED'] * 3
def test_ws_tick_sends_only_tick_messages_counting_from_zero_and_ignores_data_broadcasts(rig):
    client, hub, src = rig
    with open_ws(client, '/ws/tick') as ws:
        ws.send_text(AUTH); client.portal.call(hub.publish_reading, reading()); client.portal.call(hub.publish_alert, alert())
        got = [recv(ws) for _ in range(3)]
    assert [m['type'] for m in got] == ['tick'] * 3 and [m['srv_seq'] for m in got] == [0, 1, 2]
def test_tick_is_1_hz_by_default():
    src = Src(); hub = W.Hub(src); app = R.create_app(None, 'unused.db'); W.install(app, hub)
    with TestClient(app, base_url='http://127.0.0.1:8420') as client, open_ws(client, '/ws/tick') as ws:
        ws.send_text(AUTH); a = recv(ws); t0 = time.monotonic(); b = recv(ws); c = recv(ws)
    assert 0.8 <= time.monotonic() - t0 <= 2.4 and (a['srv_seq'], c['srv_seq']) == (0, 2) and 0 < b['srv_ts'] - a['srv_ts'] < 2000
def test_client_hb_is_accepted_counted_and_keeps_the_socket_open(rig):
    client, hub, src = rig
    with open_ws(client) as ws:
        ws.send_text(AUTH); recv(ws); assert hub.connected_tabs() == 0
        ws.send_text(json.dumps({'v': 1, 'type': 'hb', 'srv_ts': 1})); ws.send_text('garbage'); time.sleep(0.2)
        assert hub.connected_tabs() == 1 and recv(ws)['type'] == 'tick'
    time.sleep(0.2); assert hub.connected_tabs() == 0
def test_every_data_message_type_is_broadcast_in_order_with_no_srv_seq_gap(rig):
    client, hub, src = rig; call = client.portal.call
    with open_ws(client) as ws:
        ws.send_text(AUTH); recv(ws)
        for f, b in ((hub.publish_reading, reading()), (hub.publish_alert, alert()), (hub.publish_episode, dict(episode_id=1, node_id=1, kind='MAN_DOWN', state='OPEN', man_down_motion_state='no_response', resolve_reason=None, operator=None)),
                     (hub.publish_link, dict(node_id=1, state='ok', since_ts=1, last_state=None)), (hub.publish_system, SYSTEM), (hub.publish_advisory, dict(node_id=1, risk='NOMINAL', reasons='r', action='a', quality='high', source='table'))): call(f, b)
        got = []
        while len(got) < 6:
            m = recv(ws)
            if m['type'] != 'tick': got.append(m)
    assert [m['type'] for m in got] == ['reading', 'alert', 'episode', 'link', 'system', 'advisory'] and got[0]['co_ppm'] == 12.0
def test_every_alert_event_is_sent_each_one_as_its_own_message(rig):
    client, hub, src = rig; call = client.portal.call
    with open_ws(client) as ws:
        ws.send_text(AUTH); recv(ws)
        for b in (alert(), alert(level='WARNING'), alert(acknowledged_ts=7, acknowledged_by=1), alert(cleared_ts=9), alert(acknowledged_ts=7, acknowledged_by=1, episode_id=3, cleared_ts=9)): call(hub.publish_alert, b)
        got = []
        while len(got) < 5:
            m = recv(ws)
            if m['type'] == 'alert': got.append(m)
    assert [(m['level'], m['acknowledged_ts'], m['cleared_ts']) for m in got] == [('DANGER', None, None), ('WARNING', None, None), ('DANGER', 7, None), ('DANGER', None, 9), ('DANGER', 7, 9)]
def test_clean_shutdown_closes_every_socket_with_1000(rig):
    client, hub, src = rig
    with open_ws(client) as a, open_ws(client, '/ws/tick') as b:
        a.send_text(AUTH); b.send_text(AUTH); recv(a); recv(b); client.portal.call(hub.shutdown); assert closes(a) == 1000 and closes(b) == 1000
def test_a_socket_of_a_disabled_operator_is_closed_4401_within_a_few_ticks(rig):
    client, hub, src = rig
    with open_ws(client) as ws: ws.send_text(AUTH); recv(ws); src.ok.discard('good-token'); assert closes(ws) == 4401

# ---- fake-socket tests: the hub's own queues and timers ----
class FakeWS:
    def __init__(self, hang=False):
        self.headers = {'host': '127.0.0.1:8420'}; self.inbox, self.sent, self.closed, self.hang, self.gate = asyncio.Queue(), [], None, hang, asyncio.Event()
        self.application_state = self.client_state = WebSocketState.CONNECTING; self.inbox.put_nowait(AUTH); self.gate.set()
    async def accept(self): self.application_state = self.client_state = WebSocketState.CONNECTED
    async def receive_text(self):
        m = await self.inbox.get()
        if m is None: raise WebSocketDisconnect(1000)
        return m
    async def send_text(self, t):
        if self.hang: await asyncio.Event().wait()
        await self.gate.wait(); self.sent.append(json.loads(t))
    async def close(self, code=1000): self.closed = code; self.application_state = WebSocketState.DISCONNECTED
async def attach(hub, ws, kind='/ws'):
    t = asyncio.ensure_future(hub.serve(ws, kind))
    for _ in range(100):
        await asyncio.sleep(0.01)
        if hub.conns and all(c.ready for c in hub.conns): break
    return t
def arun(coro): return asyncio.run(coro)

def test_a_slow_client_is_closed_4408_after_the_send_timeout_logs_client_dropped_and_blocks_nobody():
    async def go():
        src = Src(); hub = W.Hub(src, send_timeout_s=0.2, tick_s=60); slow, fast = FakeWS(hang=True), FakeWS()
        await attach(hub, slow); await attach(hub, fast); hub.publish_reading(reading()); await asyncio.sleep(0.5)
        hub.publish_reading(reading(co=13.0)); await asyncio.sleep(0.05)
        return slow.closed, src.dropped, [m['type'] for m in fast.sent], fast.closed
    closed, dropped, fast_types, fast_closed = arun(go())
    assert closed == 4408 and len(dropped) == 1 and fast_types == ['snapshot', 'reading', 'reading'] and fast_closed is None
def test_a_frozen_client_causes_no_tick_gap_for_the_others():
    async def go():
        src = Src(); hub = W.Hub(src, send_timeout_s=0.4, tick_s=0.05); frozen, ok = FakeWS(hang=True), FakeWS(); stamps = []; hub.on_tick = lambda: stamps.append(time.monotonic())
        hub.start(); await attach(hub, frozen); await attach(hub, ok); await asyncio.sleep(0.8); await hub.shutdown(); return stamps, [m for m in ok.sent if m['type'] == 'tick']
    stamps, ticks = arun(go()); gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    assert len(stamps) >= 10 and max(gaps) < 0.25 and len(ticks) >= 8
def test_coalescing_in_a_full_queue_drops_old_readings_and_leaves_srv_seq_gapless():
    async def go():
        hub = W.Hub(Src(), queue_max=4, tick_s=60); ws = FakeWS(); ws.gate.clear(); await attach(hub, ws)
        for i in range(10): hub.publish_reading(reading(co=float(i)))
        hub.publish_alert(alert()); hub.publish_reading(reading(n=2, co=99.0)); await asyncio.sleep(0.05); ws.gate.set(); await asyncio.sleep(0.1); return ws.sent, ws.closed
    sent, closed = arun(go())
    assert closed is None and [m['srv_seq'] for m in sent] == list(range(len(sent))) and sent[0]['type'] == 'snapshot' and len(sent) <= 6
    assert [m['co_ppm'] for m in sent if m['type'] == 'reading' and m['node_id'] == 1][-1] == 9.0 and any(m['type'] == 'alert' for m in sent) and sent[-1]['co_ppm'] == 99.0
def test_a_queue_full_of_alerts_closes_the_client_4408_instead_of_dropping_one():
    async def go():
        src = Src(); hub = W.Hub(src, queue_max=3, tick_s=60); ws = FakeWS(); ws.gate.clear(); await attach(hub, ws)
        for i in range(8): hub.publish_alert(alert(aid=i + 1))
        await asyncio.sleep(0.1); return ws.closed, src.dropped
    closed, dropped = arun(go()); assert closed == 4408 and len(dropped) == 1
def test_unauth_alert_repeats_go_out_at_most_once_per_second_and_a_clear_goes_at_once():
    async def go():
        now = [100.0]; hub = W.Hub(Src(), tick_s=60, mono=lambda: now[0]); ws = FakeWS(); await attach(hub, ws)
        u = lambda n, **kw: alert(aid=7, t='unauth_alert', level='WARNING', authenticated=0, unauth_count=n, last_seen_ts=n, **kw)
        hub.publish_alert(u(1))
        for n in (2, 3, 4): now[0] += 0.2; hub.publish_alert(u(n))
        await asyncio.sleep(0.05); a = [m['unauth_count'] for m in ws.sent if m['type'] == 'alert']
        now[0] += 0.5; hub._flush_unauth(); await asyncio.sleep(0.05); b = [m['unauth_count'] for m in ws.sent if m['type'] == 'alert']
        hub.publish_alert(u(5)); hub.publish_alert(u(6, cleared_ts=9)); now[0] += 5; hub._flush_unauth(); await asyncio.sleep(0.05)
        return a, b, [(m['unauth_count'], m['cleared_ts']) for m in ws.sent if m['type'] == 'alert']
    a, b, c = arun(go()); assert a == [1] and b == [1, 4] and c == [(1, None), (4, None), (6, 9)]
`);
  putB64('docs/adr/0012.md', 'IyBBRFIgMDAxMjogV2ViU29ja2V0IGh1YiAoUDIwKQoKU3RhdHVzOiBQcm9wb3NlZCAoZGVjaWRlZCBpbiB0aGUgUDIwIHNlc3Npb247IGNvbmZpcm0gYXQgdGhlIG5leHQgZGVzaWduIHJldmlldykuCkRlc2lnbjogUmV2IDMuNDUgaXMgZnJvemVuLiBOb3RoaW5nIGluIHRoZSBmcmFtZSwgdGhlIG1pZ3JhdGlvbiwgYGNvbnN0YW50cy5qc29uYCBvciBgd3Muc2NoZW1hLmpzb25gIGNoYW5nZXMuCgotICoqU2VhbToqKiBgYXBpL3dzX2h1Yi5weWAgaGFzIGEgYEh1YmAgYW5kIGEgYFNvdXJjZWAgcHJvdG9jb2wgKGBhdXRoZW50aWNhdGVgLCBgYXVkaXRgLCBgc25hcHNob3RgLCBgY2xpZW50X2Ryb3BwZWRgKS4gVGhlIGhvc3QgKFAyNCkgaW1wbGVtZW50cyBgU291cmNlYCwgY2FsbHMgYGluc3RhbGwoYXBwLCBodWIpYCBhZnRlciBgY3JlYXRlX2FwcGAsIGFuZCBjYWxscyBgaHViLnB1Ymxpc2hfcmVhZGluZ2AsIGBwdWJsaXNoX2FsZXJ0YCwgYHB1Ymxpc2hfZXBpc29kZWAsIGBwdWJsaXNoX2xpbmtgLCBgcHVibGlzaF9zeXN0ZW1gIGFuZCBgcHVibGlzaF9hZHZpc29yeWAgb24gdGhlIGV2ZW50IGxvb3Agd2l0aCB0aGUgbWVzc2FnZSBib2R5IChubyBgdmAsIGBzcnZfc2VxYCBvciBgc3J2X3RzYCkuIGBzbmFwc2hvdCgpYCByZXR1cm5zIGV2ZXJ5IGBTbmFwc2hvdE1zZ2AgZmllbGQgZXhjZXB0IHRoZSBlbnZlbG9wZSBhbmQgYGVwb2NoYDsgdGhlIGh1YiBhZGRzIGBlcG9jaGAgKG9uZSBVVUlEIHBlciBgSHViYCwgc28gb25lIHBlciBob3N0IHN0YXJ0KS4gYGluc3RhbGxgIHdyYXBzIHRoZSBhcHAgbGlmZXNwYW46IHRoZSB0aWNrIGxvb3Agc3RhcnRzIHdpdGggdGhlIGFwcCBhbmQgYHNodXRkb3duKClgIGNsb3NlcyBldmVyeSBzb2NrZXQgd2l0aCAxMDAwLiBQMjQgbWF5IGFsc28gY2FsbCBgaHViLnN0YXJ0KClgIGVhcmxpZXIsIGJlY2F1c2UgdGhlIDEgSHogdGltZXIgYWxzbyBzdGFtcHMgd2F0Y2hkb2cgbGl2ZW5lc3MgdGhyb3VnaCB0aGUgYG9uX3RpY2tgIGNhbGxiYWNrLiBgYXBpX3Jlc3QucHlgIGlzIG5vdCB0b3VjaGVkLgotICoqT3JpZ2luIGFuZCB0b2tlbiBvbiBhIFdlYlNvY2tldDoqKiB0aGUgSFRUUCBtaWRkbGV3YXJlIGRvZXMgbm90IHNlZSBXZWJTb2NrZXRzLCBzbyBgSHViLnNlcnZlYCBhcHBsaWVzIGBzZWN1cml0eS5vcmlnaW5fb2tgIGl0c2VsZi4gVGhlIHNvY2tldCBpcyBhY2NlcHRlZCBmaXJzdCBhbmQgdGhlbiBjbG9zZWQgd2l0aCB0aGUgY29kZSwgYmVjYXVzZSBhIGJyb3dzZXIgc2VlcyAxMDA2IGZvciBhIHJlZnVzYWwgYmVmb3JlIGFjY2VwdC4gT3JkZXI6IE9yaWdpbi9Ib3N0ICg0NDAzLCBhdWRpdCBgT1JJR0lOX1JFSkVDVEVEYCksIHRoZW4gdGhlIGZpcnN0IG1lc3NhZ2UgbXVzdCBiZSBhIHZhbGlkIGBhdXRoYCB3aXRoaW4gYHdzX2F1dGhfdGltZW91dF9zYCAoNDQwMSkuIEEgbGF0ZSwgbWlzc2luZywgbWFsZm9ybWVkIG9yIHdyb25nLXRva2VuIGZpcnN0IG1lc3NhZ2UgaXMgNDQwMTsgYW4gaW52YWxpZCB0b2tlbiBvciBhIG5vbi1hdXRoIGZpcnN0IG1lc3NhZ2Ugd3JpdGVzIGBMT0dJTl9SRUpFQ1RFRGAgbGlrZSBhIFJFU1QgNDAxLCBhIHBsYWluIHRpbWVvdXQgd3JpdGVzIG5vdGhpbmcuCi0gKipBZnRlciBhdXRoOioqIGBoYmAgb24gYC93c2AgaXMgYWNjZXB0ZWQgYW5kIGNvdW50ZWQgKGBjb25uZWN0ZWRfdGFicygpYDogYSBgL3dzYCBzb2NrZXQgd2hvc2UgbGFzdCBgaGJgIGlzIHVuZGVyIDMgcyBvbGQ7IG5vIGF1ZGlvIGZpZWxkKS4gQW55IG90aGVyIG9yIG1hbGZvcm1lZCBtZXNzYWdlIGlzIGlnbm9yZWQuIEV2ZXJ5IDV0aCB0aWNrIHRoZSBodWIgY2hlY2tzIGVhY2ggb3BlbiBzb2NrZXQncyB0b2tlbiBhZ2Fpbiwgb2ZmIHRoZSBldmVudCBsb29wLCBhbmQgY2xvc2VzIGEgZGlzYWJsZWQgb3Igcm90YXRlZC1vdXQgb3BlcmF0b3IncyBzb2NrZXQgd2l0aCA0NDAxICh0aGUgaXRlbSBBRFIgMDAwOCBsZWZ0IHRvIFAyMCkuCi0gKipQZXItY29ubmVjdGlvbiBxdWV1ZSBhbmQgc3J2X3NlcToqKiBlYWNoIGNvbm5lY3Rpb24gaGFzIGEgZGVxdWUgKGB3c19zZW5kX3F1ZXVlX21heGAsIDY0KSBhbmQgYSBzZW5kZXIgdGFzay4gVGhlIHNlbmRlciBhc3NpZ25zIGBzcnZfc2VxYCBhbmQgYHNydl90c2Agd2hlbiBpdCBzZW5kcywgc28gYSBtZXNzYWdlIHJlbW92ZWQgZnJvbSB0aGUgcXVldWUgbmV2ZXIgbGVhdmVzIGEgZ2FwLiBUaGUgc25hcHNob3QgaXMgYnVpbHQgYW5kIHF1ZXVlZCB3aXRoIG5vIGF3YWl0IGJlZm9yZSB0aGUgY29ubmVjdGlvbiBqb2lucyB0aGUgYnJvYWRjYXN0LCBzbyBpdCBpcyBhbHdheXMgZmlyc3QgYW5kIG5vdGhpbmcgY2FuIHNsaXAgaW4gYmVmb3JlIGl0LiBgL3dzL3RpY2tgIGhhcyBubyBzbmFwc2hvdDogaXRzIGBzcnZfc2VxYCBzdGFydHMgYXQgMCBvbiBpdHMgZmlyc3QgdGljay4KLSAqKkNvYWxlc2NpbmcgKFByb3Bvc2VkIHJ1bGUsIHRoZSBkZXNpZ24gc2F5cyBvbmx5IHRoYXQgY29hbGVzY2luZyBsZWF2ZXMgbm8gZ2FwKToqKiBhIGB0aWNrYCByZXBsYWNlcyBhbiBvbGRlciBxdWV1ZWQgYHRpY2tgLiBXaGVuIHRoZSBxdWV1ZSBpcyBmdWxsLCB0aGUgb2xkZXN0IHF1ZXVlZCBgcmVhZGluZ2AgKG9mIHRoZSBzYW1lIG5vZGUgaWYgdGhlcmUgaXMgb25lKSBpcyBkcm9wcGVkIHRvIG1ha2Ugcm9vbS4gQSBxdWV1ZSB3aXRoIG5vIGByZWFkaW5nYCB0byBkcm9wIChmdWxsIG9mIGFsZXJ0cywgZXBpc29kZXMsIGxpbmtzKSBtZWFucyB0aGUgY2xpZW50IGlzIHRvbyBzbG93OiBpdCBnZXRzIDQ0MDggYW5kIGBjbGllbnRfZHJvcHBlZGAsIGFuZCBubyBzYWZldHkgbWVzc2FnZSBpcyBldmVyIGRyb3BwZWQuIEEgc2VuZCB0aGF0IHRha2VzIG1vcmUgdGhhbiBgd3Nfc2VuZF90aW1lb3V0X3NgIGdpdmVzIDQ0MDggdG9vLiBBIGNsaWVudCBiZWluZyBkcm9wcGVkIGlzIG9mZmVyZWQgbm90aGluZyBtb3JlLCBzbyBgQ0xJRU5UX0RST1BQRURgIGlzIHdyaXR0ZW4gb25jZS4KLSAqKnVuYXV0aF9hbGVydCByZXBlYXRzOioqIGEgcmVwZWF0IG9mIGFuIG9wZW4sIHVuYWNrbm93bGVkZ2VkIGB1bmF1dGhfYWxlcnRgIGlzIHNlbnQgYXQgb25jZSBpZiB0aGUgbGFzdCBvbmUgZm9yIHRoYXQgYGFsZXJ0X2lkYCB3YXMgb3ZlciAxIHMgYWdvLCBvdGhlcndpc2UgdGhlIG5ld2VzdCBpcyBoZWxkIGFuZCB0aGUgMSBIeiBsb29wIHNlbmRzIGl0LiBBIGNsZWFyIG9yIGFuIEFja25vd2xlZGdlIGlzIGFsd2F5cyBzZW50IGF0IG9uY2UgYW5kIGRpc2NhcmRzIGEgaGVsZCByZXBlYXQuIEV2ZXJ5IG90aGVyIGFsZXJ0IG1lc3NhZ2UgKHJhaXNlLCBjbGVhciwgbGV2ZWwgY2hhbmdlLCBBY2tub3dsZWRnZSwgb25lIHBlciBsaW5rZWQgYWxlcnQgb2YgYW4gZXBpc29kZSBBY2tub3dsZWRnZSkgaXMgc2VudCBhdCBvbmNlOyB0aGUgaG9zdCBkZWNpZGVzIHdoYXQgdG8gcHVibGlzaCwgdGhlIGh1YiBkb2VzIG5vdCBsb29rIGluc2lkZS4KLSAqKlRpY2s6Kiogb25lIHRpbWVyIGZvciBib3RoIHNvY2tldHMgYXQgYHRpY2tfc2AgKDEgcywgZGVmYXVsdCksIHNjaGVkdWxlZCBmcm9tIGEgZml4ZWQgc3RhcnQgc28gb25lIHNsb3cgdHVybiBkb2VzIG5vdCBzaGlmdCB0aGUgbmV4dC4gSXQgb25seSBlbnF1ZXVlcywgc28gYSBmcm96ZW4gY2xpZW50IGNhbm5vdCBkZWxheSBpdC4KLSAqKk5vdCBkb25lIGhlcmU6KiogdGhlIHJlYWwgYFNvdXJjZWAgYW5kIHRoZSBlbmdpbmUtdG8taHViIHdpcmluZyAoUDI0KTsgdGhlIGRhc2hib2FyZCBjbGllbnQgKFAyMik7IGAvd3NgIGlzIG5vdCBpbiB0aGUgUkVTVCBlbmRwb2ludCB0YWJsZSB0ZXN0Lgo=');
  append('docs/PROGRESS.md', '- Part 20 done: api/ws_hub.py (Hub, Source protocol, install): /ws sends the snapshot first (epoch per host start, srv_seq 0) and then increments, /ws/tick sends only ticks at 1 Hz; auth message within ws_auth_timeout_s or close 4401, Origin/Host 4403, slow client 4408 with CLIENT_DROPPED (send timeout, or a queue with no reading left to coalesce), clean shutdown 1000; per-connection bounded queue and sender task assign srv_seq at send time so coalescing leaves no gap; unauth_alert repeats at most once per second; hb accepted and counted; sockets of a disabled operator close 4401 within 5 ticks; host/tests/test_ws_hub.py (20 tests), docs/adr/0012.md; api_rest.py untouched; the real Source and the engine wiring are P24, the dashboard client is P22');
}
