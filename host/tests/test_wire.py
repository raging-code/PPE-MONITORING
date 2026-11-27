"""P24-3b-2a: wire.Wire (host/ppe_host/wire.py): reading, alert and episode messages built after the commit, held messages, unauth_alert repeats, and the snapshot (design 3.8).
Real DBWriter, database, HostPort and engine, a fake hub. Every body is checked against the WsMessage contract: with the real models when pydantic is installed, else against shared/ws.schema.json.
The REST routes and the real Hub are not run here (P24-3c wires them). Requirements: REQ-API-007, REQ-API-011."""
import json, threading, types, uuid
from pathlib import Path
import pytest
from ppe_host import constants as K
from ppe_host.core.rule_engine import EpisodeOpened, RaiseAlert
from ppe_host.wire import Wire
from test_effect_rows import by_type, wait
from test_gv_bytes import WRONG_KEY, pack
from test_host_port import port
from test_ingest import rows, send

SCHEMA = json.loads((Path(__file__).resolve().parents[2] / 'shared' / 'ws.schema.json').read_text(encoding='utf8'))['$defs']
def _ok(v, s):
    if '$ref' in s: return _ok(v, SCHEMA[s['$ref'].split('/')[-1]])
    if 'anyOf' in s: return any(_ok(v, x) for x in s['anyOf'])
    if 'const' in s and v != s['const']: return False
    if 'enum' in s and v not in s['enum']: return False
    t = s.get('type'); num = isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == 'integer' and not (isinstance(v, int) and not isinstance(v, bool)): return False
    if t == 'number' and not num: return False
    if t == 'string' and not isinstance(v, str): return False
    if t == 'boolean' and not isinstance(v, bool): return False
    if t == 'null' and v is not None: return False
    if num and (v < s.get('minimum', v) or v > s.get('maximum', v)): return False
    if t == 'array': return isinstance(v, list) and all(_ok(x, s['items']) for x in v) if 'items' in s else isinstance(v, list)
    if t == 'object':
        if not isinstance(v, dict): return False
        props, extra = s.get('properties', {}), s.get('additionalProperties', True)
        if any(k not in v for k in s.get('required', ())): return False
        return all(_ok(x, props[k]) if k in props else (extra is True or (isinstance(extra, dict) and _ok(x, extra))) for k, x in v.items())
    return True
def check(kind, body):
    """The body with its envelope must be a valid server message of that type."""
    msg = dict(body, v=1, type=kind, srv_seq=0, srv_ts=1, **({'epoch': str(uuid.uuid4())} if kind == 'snapshot' else {}))
    try: from ppe_host.api import models as M
    except ImportError: M = None
    if M is not None: M.parse_server(msg)
    else: assert _ok(msg, SCHEMA[{'reading': 'ReadingMsg', 'alert': 'AlertMsg', 'episode': 'EpisodeMsg', 'snapshot': 'SnapshotMsg'}[kind]]), (kind, msg)

class Hub:
    def __init__(self): self.sent = []
    def publish_reading(self, b): check('reading', b); self.sent.append(('reading', b))
    def publish_alert(self, b): check('alert', b); self.sent.append(('alert', b))
    def publish_episode(self, b): check('episode', b); self.sent.append(('episode', b))
def got(h, k): return [b for kk, b in h.sent if kk == k]
def wired(tmp_path, **kw):
    c, w, clock, ing, p = port(tmp_path); h = Hub(); return c, w, clock, ing, p, h, Wire(p, h, **kw).attach()

def test_a_verified_frame_gives_one_reading_with_raw_co_the_bits_and_the_engine_level(tmp_path):         # GV-01 (F-01)
    c, w, clock, ing, p, h, wire = wired(tmp_path); r = send(ing, clock, pack(seq=100, co_x10=520, flags=1, scba=1, posture=2, bat=77, motion_x100=4)); wait(w, r.unit)
    (b,) = got(h, 'reading'); assert r.ctx is not None and r.ctx['node'] == 1
    assert (b['node_id'], b['alias'], b['co_ppm'], b['temp_c'], b['hum_pct'], b['motion_g'], b['posture'], b['bat_pct'], b['scba'], b['mandown'], b['level'], b['seq_class']) == \
           (1, rows(c, 'SELECT alias FROM roster WHERE node_id = 1')[0]['alias'], 52.0, 25.0, 50, 0.04, 'HORIZONTAL', 77, 1, 0, 'WARNING', 'fresh')
    assert (b['rssi'], b['snr'], b['co_over_range'], b['co_validity'], b['co_reason'], b['stillness_s'], b['status2'], b['flags'], b['id_mode']) == (-68.5, 9.2, 0, 'VALID', None, 0.0, 0, 1, 0x49 | 0x20)
    assert isinstance(b['reasons'], list) and b['rx_ts'] == clock.wall_ms(); w.stop()

def test_a_duplicate_still_gives_a_reading_but_a_frame_that_fails_its_mac_with_no_claim_gives_nothing(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); raw = pack(seq=7); wait(w, send(ing, clock, raw).unit); r2 = send(ing, clock, raw); wait(w, r2.unit)
    assert [b['seq_class'] for b in got(h, 'reading')] == ['fresh', 'duplicate']
    n = len(h.sent); r3 = send(ing, clock, pack(seq=8, key=WRONG_KEY), base='BAD_MAC'); assert r3.ctx is None and len(h.sent) == n; w.stop()

def test_the_alert_message_carries_the_database_id_and_every_change_is_sent_after_its_commit(tmp_path):      # GV-01, GV-09
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1, co_x10=520, flags=1)).unit)
    (a,) = got(h, 'alert'); row = by_type(c, 'co_threshold')[0]
    assert (a['alert_id'], a['alert_type'], a['level'], a['authenticated'], a['cleared_ts'], a['acknowledged_ts'], a['unauth_count']) == (row['alert_id'], 'co_threshold', 'WARNING', 1, None, None, None)
    p.ack_alert(row['alert_id'], 1); a2 = got(h, 'alert')[-1]; assert (a2['alert_id'], a2['acknowledged_by']) == (row['alert_id'], 1) and a2['acknowledged_ts']
    wait(w, send(ing, clock, pack(seq=2, co_x10=2500, flags=2)).unit); a3 = got(h, 'alert')[-1]; assert (a3['alert_id'], a3['level'], a3['acknowledged_ts']) == (row['alert_id'], 'DANGER', None)   # escalation clears the acknowledgement
    w.stop()

def test_acknowledging_a_cleared_alert_sends_its_message_too(tmp_path):                                       # 3.8: also for an alert that already cleared
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1, co_x10=520, flags=1)).unit)
    for s in range(2, 20): wait(w, send(ing, clock, pack(seq=s, co_x10=0)).unit)
    row = by_type(c, 'co_threshold')[0]; assert row['cleared_ts'] is not None; p.ack_alert(row['alert_id'], 1); a = got(h, 'alert')[-1]
    assert (a['alert_id'], a['acknowledged_by']) == (row['alert_id'], 1) and a['cleared_ts'] == row['cleared_ts']; w.stop()

def test_episode_messages_open_acknowledge_and_resolve_with_the_operator_name(tmp_path):                         # GV-02, GV-20
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1, flags=6)).unit); eid = rows(c, 'SELECT episode_id FROM episodes')[0]['episode_id']
    (e,) = got(h, 'episode'); assert (e['episode_id'], e['kind'], e['state'], e['man_down_motion_state'], e['operator'], e['resolve_reason']) == (eid, 'MAN_DOWN', 'OPEN', 'no_response', None, None)
    md = [a for a in got(h, 'alert') if a['alert_type'] == 'man_down']; assert md and md[0]['episode_id'] == eid
    p.ack_episode(eid, 1); e = got(h, 'episode')[-1]; assert (e['state'], e['operator']) == ('ACKNOWLEDGED', 'Ana') and got(h, 'alert')[-1]['acknowledged_by'] == 1
    p.resolve_episode(eid, 'rescued', 1); e = got(h, 'episode')[-1]
    assert (e['state'], e['resolve_reason'], e['operator'], e['man_down_motion_state']) == ('RESOLVED', 'rescued', 'Ana', None) and any(a['alert_type'] == 'man_down' and a['cleared_ts'] for a in got(h, 'alert'))
    n = len(got(h, 'episode')); wire.on_effects([EpisodeOpened(10 ** 6, 1, 'MAN_DOWN', 12345)], None, None); assert len(got(h, 'episode')) == n      # an Opened row that was never stored does not repeat the old episode
    w.stop()

def test_a_mayday_upgrade_sends_the_episode_as_mayday_without_a_label(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1, flags=6)).unit); wait(w, send(ing, clock, pack(seq=2, flags=6, status4=16)).unit)
    e = got(h, 'episode')[-1]; assert (e['kind'], e['state'], e['man_down_motion_state']) == ('MAYDAY', 'OPEN', None); w.stop()

def test_a_unit_that_did_not_commit_in_time_is_held_and_sent_when_it_has_committed(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); r = send(ing, clock, pack(seq=1, co_x10=520, flags=1)); wait(w, r.unit); h.sent.clear()
    slow = types.SimpleNamespace(done=threading.Event()); wire.on_effects(r.effects, slow, False); wire.flush()
    assert got(h, 'alert') == [] and len(wire.pending) == 1
    slow.done.set(); wire.flush(); assert [a['alert_type'] for a in got(h, 'alert')] == ['co_threshold'] and not wire.pending; w.stop()

def test_an_alert_row_that_was_not_stored_sends_no_message_and_is_remembered(tmp_path):                        # Rev 3.36: unpersisted
    c, w, clock, ing, p, h, wire = wired(tmp_path); wire.on_effects([RaiseAlert(10 ** 6, 1, 'co_threshold', 'WARNING', '', 1)], None, True)
    assert got(h, 'alert') == [] and wire.unpersisted == {10 ** 6}; w.stop()

def test_unauth_alert_repeats_are_sent_from_the_tick_once_per_change(tmp_path):                                 # GV-04: a repeat has no effect, so the tick sends it
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=200, flags=6, node=2, key=WRONG_KEY), base='BAD_MAC').unit)
    (a,) = got(h, 'alert'); assert (a['alert_type'], a['node_id'], a['authenticated'], a['level'], a['unauth_count']) == ('unauth_alert', 2, 0, 'NONE', 1)
    wait(w, send(ing, clock, pack(seq=201, flags=6, node=2, key=WRONG_KEY), base='BAD_MAC').unit); assert len(got(h, 'alert')) == 1
    wire.tick(); assert [x['unauth_count'] for x in got(h, 'alert')] == [1, 2] and got(h, 'alert')[-1]['last_seen_ts'] == clock.wall_ms()
    wire.tick(); assert len(got(h, 'alert')) == 2; w.stop()

def test_the_tick_sends_the_alerts_of_the_silence_rules(tmp_path):                                              # GV-08
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1)).unit); clock.advance((K.SIGNAL_LOST_S + 1) * 1000); wire.tick()
    assert 'signal_lost' in [a['alert_type'] for a in got(h, 'alert')] and wire.snapshot()['nodes'][0]['link_state'] == 'signal_lost'; w.stop()

def test_the_snapshot_of_a_host_that_has_heard_nothing_is_valid_and_every_node_is_not_connected(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); s = wire.snapshot(); check('snapshot', s)
    assert [n['node_id'] for n in s['nodes']] == [1, 2, 3] and all(n['level'] is None and n['link_state'] == 'not_connected' and n['co_ppm'] is None and n['last_rx_ts'] is None for n in s['nodes'])
    assert (s['recovering'], s['monitoring_active'], s['open_alerts'], s['open_episodes'], s['co_history_30m']) == (True, False, [], [], {'1': [], '2': [], '3': []})
    assert s['banners'] == {'base_offline': False, 'logging_fault': False, 'host_gap': None, 'host_power': 'ac', 'audio_fault': False, 'abi_mismatch': False} and s['constants'] == K.CONSTANTS
    assert s['session']['session_id'] == 1 and s['session']['mode'] == 'LIVE' and [r['active'] for r in s['roster']] == [1, 1, 1]; w.stop()

def test_the_snapshot_after_traffic_has_values_open_items_chart_points_and_banners(tmp_path):                    # 3.8 snapshot, GV-02, GV-18
    c, w, clock, ing, p, h, wire = wired(tmp_path, base_offline=lambda: True); wait(w, send(ing, clock, pack(seq=1, co_x10=120, scba=1)).unit)
    raw = pack(seq=2, co_x10=130); wait(w, send(ing, clock, raw).unit); wait(w, send(ing, clock, raw).unit)                       # the duplicate adds no point
    wait(w, send(ing, clock, pack(seq=3, co_x10=140, status2=16)).unit)                                                              # a CO fault adds none either
    wait(w, send(ing, clock, pack(seq=4, co_x10=150, flags=6)).unit); p.set_scba_correction(1, 'x', 1); s = wire.snapshot(); check('snapshot', s); n = s['nodes'][0]
    assert (n['co_ppm'], n['temp_c'], n['hum_pct'], n['bat_pct'], n['scba'], n['mandown'], n['level'], n['link_state'], n['flags']) == (15.0, 25.0, 50, 80, 0, 1, 'DANGER', 'ok', 6)
    assert n['scba_correction'] == {'recorded_ts': clock.wall_ms(), 'operator': 'Ana'} and s['nodes'][1]['level'] is None
    assert [pt[1] for pt in s['co_history_30m']['1']] == [12.0, 13.0, 15.0] and s['co_history_30m']['2'] == []
    assert {a['alert_type'] for a in s['open_alerts']} >= {'man_down'} and [(e['kind'], e['state'], e['man_down_motion_state']) for e in s['open_episodes']] == [('MAN_DOWN', 'OPEN', 'no_response')]
    assert s['banners']['base_offline'] is True
    clock.advance(31 * 60 * 1000); assert wire.snapshot()['co_history_30m']['1'] == []; w.stop()

def test_the_host_gap_banner_leaves_the_snapshot_once_acknowledged_and_the_logging_fault_follows_the_writer(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); p.set_host_gap(12.5, 'db_restored'); check('snapshot', wire.snapshot()); assert wire.snapshot()['banners']['host_gap'] == {'gap_s': 12.5, 'reason': 'db_restored'}
    p.ack_banner('host_gap', 1); assert wire.snapshot()['banners']['host_gap'] is None
    w.logging_fault = True; assert wire.snapshot()['banners']['logging_fault'] is True; p.ack_banner('logging_fault', 1); assert wire.snapshot()['banners']['logging_fault'] is True; w.stop()

def test_a_port_with_no_wire_cannot_make_a_snapshot(tmp_path):
    c, w, clock, ing, p = port(tmp_path)
    with pytest.raises(RuntimeError): p.snapshot()
    w.stop()

def test_the_contract_check_refuses_a_body_with_an_extra_key_a_missing_key_or_a_wrong_value(tmp_path):         # the check itself must be able to fail
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1, co_x10=520, flags=1)).unit); a = got(h, 'alert')[0]
    for bad in (dict(a, extra=1), {k: v for k, v in a.items() if k != 'alert_id'}, dict(a, level='LOUD'), dict(a, authenticated=2), dict(a, alert_type='nope')):
        with pytest.raises(Exception): check('alert', bad)
    w.stop()
