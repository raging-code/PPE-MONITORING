"""P24-3b-2b-i: the link and system messages of wire.Wire (design 3.8). Real DBWriter, database, HostPort and engine, a fake hub; every body is checked against the WsMessage contract
(real models when pydantic is installed, else shared/ws.schema.json). The 3b-2a hub fakes have no publish_link or publish_system: Wire sends those messages only to a hub that has them. Requirements: REQ-API-007."""
from ppe_host import constants as K
from ppe_host.wire import Wire
from test_effect_rows import wait
from test_gv_bytes import WRONG_KEY, pack
from test_host_port import port
from test_ingest import send
from test_wire import Hub as Hub1, SCHEMA, _ok, got

NAMES = {'link': 'LinkMsg', 'system': 'SystemMsg', 'advisory': 'AdvisoryMsg'}
def check2(kind, body):
    msg = dict(body, v=1, type=kind, srv_seq=0, srv_ts=1)
    try: from ppe_host.api import models as M
    except ImportError: assert _ok(msg, SCHEMA[NAMES[kind]]), msg; return
    M.parse_server(msg)
class Hub(Hub1):
    def publish_link(self, b): check2('link', b); self.sent.append(('link', b))
    def publish_system(self, b): check2('system', b); self.sent.append(('system', b))
def wired(tmp_path, **kw):
    c, w, clock, ing, p = port(tmp_path); h = Hub(); return c, w, clock, ing, p, h, Wire(p, h, **kw).attach()

def test_the_first_frame_of_a_node_is_a_link_message_from_not_connected_to_ok(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); assert got(h, 'link') == []
    wait(w, send(ing, clock, pack(seq=1)).unit); (m,) = got(h, 'link')
    assert (m['node_id'], m['state'], m['last_state'], m['since_ts']) == (1, 'ok', 'not_connected', clock.wall_ms())
    wait(w, send(ing, clock, pack(seq=2)).unit); assert len(got(h, 'link')) == 1; w.stop()

def test_silence_and_recovery_walk_the_link_states_and_the_snapshot_agrees(tmp_path):                           # GV-08
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1)).unit)
    def now(): return got(h, 'link')[-1]
    def snap(): return wire.snapshot()['nodes'][0]['link_state']
    clock.advance((K.SIGNAL_LOST_S + 1) * 1000); wire.tick(); assert (now()['state'], now()['last_state'], snap()) == ('signal_lost', 'ok', 'signal_lost')
    clock.advance(K.LINK_LOST_MAX_S * 1000); wire.tick(); assert (now()['state'], now()['last_state'], snap()) == ('link_lost', 'signal_lost', 'link_lost')
    wait(w, send(ing, clock, pack(seq=2)).unit); assert (now()['state'], now()['last_state'], snap()) == ('recovered', 'link_lost', 'recovered')
    for s in range(3, 3 + K.REBASELINE_CLEAN_FRAMES): wait(w, send(ing, clock, pack(seq=s)).unit)                   # the recovery frame and the next rebaseline_clean_frames are not tracked
    assert (now()['state'], now()['last_state'], snap()) == ('ok', 'recovered', 'ok') and len(got(h, 'link')) == 5; w.stop()

def test_a_base_recovery_session_or_banner_source_change_is_one_system_message(tmp_path):
    off, fault, pw = [False], [False], ['ac']
    c, w, clock, ing, p, h, wire = wired(tmp_path, base_offline=lambda: off[0], audio_fault=lambda: fault[0], host_power=lambda: pw[0])
    wire.tick(); assert got(h, 'system') == []                                                                      # nothing changed since attach
    off[0] = True; wire.tick(); (m,) = got(h, 'system')
    assert (m['base'], m['recovering'], m['session_id'], m['session_mode'], m['banner'], m['acknowledged_ts']) == ('offline', True, 1, 'LIVE', None, None)
    wire.tick(); assert len(got(h, 'system')) == 1
    off[0], fault[0], pw[0], w.logging_fault = False, True, 'battery', True; p.set_recovering(False); wire.tick(); m = got(h, 'system')[-1]
    assert len(got(h, 'system')) == 2 and (m['base'], m['recovering'], m['audio_fault'], m['host_power'], m['logging_fault']) == ('ok', False, True, 'battery', True); w.stop()

def test_the_rejected_frame_count_goes_out_with_the_tick_and_not_more_often(tmp_path):                           # 3.8: rejected_frames, GV-04
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=5, key=WRONG_KEY), base='BAD_MAC').unit); assert got(h, 'system') == []
    wire.tick(); (m,) = got(h, 'system'); assert m['rejected_frames'] == 1
    wire.tick(); wait(w, send(ing, clock, pack(seq=6)).unit); wire.tick(); assert len(got(h, 'system')) == 1; w.stop()

def test_a_banner_acknowledgement_is_a_system_message_with_the_banner_and_the_time(tmp_path):                   # 3.8: BANNER_ACK
    c, w, clock, ing, p, h, wire = wired(tmp_path); p.set_host_gap(12.5, 'db_restored'); wire.tick(); assert got(h, 'system')[-1]['host_gap'] == {'gap_s': 12.5, 'reason': 'db_restored'}
    n = len(got(h, 'system')); clock.advance(5); p.ack_banner('host_gap', 1); m = got(h, 'system')[-1]
    assert len(got(h, 'system')) == n + 1 and (m['banner'], m['acknowledged_ts'], m['host_gap']) == ('host_gap', clock.wall_ms(), None)
    wire.tick(); assert len(got(h, 'system')) == n + 1                                                              # the tick does not repeat it
    w.logging_fault = True; wire.tick(); p.ack_banner('logging_fault', 1); m = got(h, 'system')[-1]; assert (m['banner'], m['logging_fault']) == ('logging_fault', True); w.stop()
