"""P20: api/ws_hub.py, the /ws and /ws/tick sockets (design 3.8, 1, 5, 8). Real protocol tests use TestClient; slow-client, coalescing and unauth_alert tests drive Hub.serve with a fake socket."""
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
