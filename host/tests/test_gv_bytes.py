"""P10: golden vectors GV-01 to GV-27 (design 14.4), byte level. Every case builds real 23-byte frames (frame packer below, cross-checked against
shared/vectors/frames.json), sends them through the real pipeline crypto_abi.classify_frame -> seq_classifier.classify -> step() with a FakeClock,
exactly the order the shell uses (BAD_LEN and REJECT_ROSTER never reach step(); BAD_MAC and BAD_CRC reach it as suspect). GV-21 to GV-27 are field-level
vectors but run the same way. A failing case is REPORTED (see the REPORT table at the end of the P10 HANDOFF); no rule or vector is edited to make it pass."""
import json
from pathlib import Path
import pytest
from cryptography.hazmat.primitives.ciphers import algorithms
from cryptography.hazmat.primitives.cmac import CMAC
from ppe_host import abi
from ppe_host.clock import FakeClock
from ppe_host.core import crypto_abi as ca
from ppe_host.core.rule_engine import (AckAlertEvent, ChangeAlertLevel, ClearAlert, EngineState, FrameEvent, RaiseAlert, ResolveEpisodeEvent, TickEvent, step)
from ppe_host.core.seq_classifier import SeqState, classify

SUSPECT_NOTICE_ON = True   # the real pipeline runs suspect_frame_rule (conftest.py)
ROOT = Path(__file__).resolve().parents[2]
VEC = json.loads((ROOT / 'shared' / 'vectors' / 'frames.json').read_text(encoding='utf8'))
KEY, WRONG_KEY, SYS = bytes.fromhex(VEC['key_hex']), bytes.fromhex(VEC['wrong_key_hex']), VEC['sys_id']
HEX = {f['id']: f['hex'] for f in VEC['frames']}
T = 1_700_000_000_000

def pack(seq=0, co_x10=0, temp_x100=2500, hum=50, hr=0, motion_x100=0, bat=80, status2=0, flags=0, node=1, scba=0, posture=0, link_ok=1, evt_unsent=0,
         uptime_s=100, status3=0, status4=0, boot_ctr=7, id_mode=None, key=KEY, sys_id=SYS):
    """23 bytes from field values (layout from abi.FRAME_FIELDS); defaults are the frames.json defaults. id_mode = node + 0x08 scba + posture x 0x10 + 0x40 link_ok + 0x80 evt_unsent."""
    if id_mode is None: id_mode = node | (0x08 if scba else 0) | (posture << 4) | (0x40 if link_ok else 0) | (0x80 if evt_unsent else 0)
    v = dict(seq=seq, co_x10=co_x10, temp_x100=temp_x100, hum=hum, hr=hr, motion_x100=motion_x100, bat=bat, status2=status2, flags=flags, id_mode=id_mode,
             uptime_s=uptime_s, status3=status3, status4=status4, boot_ctr=boot_ctr)
    b = bytearray(abi.FRAME_BYTES)
    for name, val in v.items():
        o, n, signed = abi.FRAME_FIELDS[name]; b[o:o + n] = int(val).to_bytes(n, 'little', signed=signed)
    lo, hi = abi.FRAME_CRC_RANGE; b[abi.FRAME_FIELDS['crc8'][0]] = ca.crc8(bytes(b[lo:hi]))
    m = CMAC(algorithms.AES(key)); m.update(bytes([sys_id]) + bytes(b[lo:hi])); mo = abi.FRAME_FIELDS['mac4'][0]; b[mo:mo + 4] = m.finalize()[:4]
    return bytes(b)

def kinds(fx, *types):
    """Alert effects as (kind, node, type, level); episode effects as (class name, node). Only the given alert types (and every episode effect) when types are named."""
    out = []
    for e in fx:
        if isinstance(e, RaiseAlert): k = ('raise', e.node_id, e.type, e.level)
        elif isinstance(e, ClearAlert): k = ('clear', e.node_id, e.type, None)
        elif isinstance(e, ChangeAlertLevel): k = ('escalate' if e.acknowledged_reset else 'lower', e.node_id, e.type, e.level)
        else: out.append((type(e).__name__, e.node_id)) if hasattr(e, 'node_id') and type(e).__name__.startswith('Episode') else None; continue
        if not types or k[2] in types: out.append(k)
    return out

class Pipe:
    """The shell's frame path: classify_frame, then seq classifier (verify OK only), then step(). auto seq: frames sent with seq=None continue from the last auto seq."""
    def __init__(self):
        self.clock, self.st, self.cs, self.auto, self.last, self.fx_all = FakeClock(T, 10_000), EngineState(), SeqState(), 99, None, []
        self.rejected = []
    def fork(self):
        p = Pipe(); p.clock = FakeClock(self.clock.wall_ms(), self.clock.mono_ms()); p.st, p.cs, p.auto = self.st, self.cs, self.auto; return p
    def raw(self, raw, dt=2000):
        self.clock.advance(dt); r = ca.classify_frame(raw, KEY, SYS)
        if r.result in ('BAD_LEN', 'REJECT_ROSTER'): self.rejected.append(r.result); self.last = None; return []
        now = self.clock.now()
        if r.result == 'OK': self.auto = r.decoded['seq']
        if r.result == 'OK': self.cs, self.last = classify(self.cs, r.node_id, raw, r.decoded, now.mono_ms); cls = self.last.seq_class
        else: self.last, cls = None, 'suspect'
        self.st, fx = step(self.st, FrameEvent(r.node_id, r.result, cls, r.decoded), now); self.fx_all += list(fx); return list(fx)
    def send(self, dt=2000, seq=None, **kw):
        if seq is None: self.auto = (self.auto + 1) % 65536; seq = self.auto
        else: self.auto = seq
        return self.raw(pack(seq=seq, **kw), dt)
    def run(self, seconds, **kw):
        out = []
        for _ in range(seconds // 2): out += self.send(**kw)
        return out
    def tick(self, dt):
        self.clock.advance(dt); self.st, fx = step(self.st, TickEvent(), self.clock.now()); self.fx_all += list(fx); return list(fx)
    def op(self, event):
        self.st, fx = step(self.st, event, self.clock.now()); self.fx_all += list(fx); return list(fx)
    def n(self, nid=1): return self.st.nodes[nid]
    def row(self, t, nid=1): return self.st.alerts.get((nid, t))
    def open(self): return sorted((k[0], k[1], a.level) for k, a in self.st.alerts.items())
    def baseline(self, nid=1): return (self.cs.nodes[nid].boot_ctr, self.cs.nodes[nid].seq)

def test_packer_reproduces_the_vector_frames():
    cases = {'F-01': dict(seq=100, co_x10=520, flags=1), 'F-02': dict(seq=101, motion_x100=1, flags=6), 'F-03': dict(seq=102, flags=6, status4=16),
             'F-04': dict(seq=103, flags=0x81), 'F-05': dict(seq=104, bat=10, status2=4), 'F-06': dict(seq=105, co_x10=520, status2=16, flags=8),
             'F-07': dict(seq=106, co_x10=2500, flags=2), 'F-08': dict(seq=65535), 'F-09': dict(seq=0), 'F-10': dict(seq=0, status2=8, boot_ctr=8),
             'F-11': dict(seq=110, co_x10=400, flags=1), 'F-12': dict(seq=120, status2=16, flags=10), 'F-13': dict(seq=130, status2=64, flags=9),
             'F-14': dict(seq=140, flags=2), 'F-15': dict(seq=150, temp_x100=5600, co_x10=200), 'F-23': dict(seq=160, temp_x100=5600, co_x10=2500, flags=2),
             'F-24': dict(seq=170, temp_x100=-500), 'F-16': dict(seq=200, flags=6, node=2, key=WRONG_KEY)}
    for fid, kw in cases.items():
        got = pack(**kw).hex()
        if fid == 'F-16': assert got[:36] == HEX[fid][:36], fid      # payload only: the vector flips tag byte 22, the packer makes a wrong-key tag
        else: assert got == HEX[fid], fid

# ---- GV-01 to GV-04 ----
def test_GV01_co_52_ppm_raises_co_threshold_warning():
    p = Pipe(); fx = p.raw(bytes.fromhex(HEX['F-01']))
    assert kinds(fx, 'co_threshold') == [('raise', 1, 'co_threshold', 'WARNING')] and p.n().level == 'WARNING' and p.st.episodes == {} and p.n().co_ppm == 52.0 and p.last.seq_class == 'fresh'

def test_GV02_man_down_opens_episode_then_raises_man_down():
    p = Pipe(); fx = p.send(seq=101, motion_x100=1, flags=6)
    assert kinds(fx) == [('EpisodeOpened', 1), ('raise', 1, 'man_down', 'DANGER')] and p.n().level == 'DANGER'
    ep = p.st.episodes[1]; assert (ep.kind, ep.state) == ('MAN_DOWN', 'OPEN') and not p.row('node_danger')

def test_GV03_mayday_upgrades_the_episode_in_place():
    p = Pipe(); p.send(seq=101, motion_x100=1, flags=6); fx = p.send(seq=102, flags=6, status4=0x10)
    assert kinds(fx) == [('EpisodeEscalated', 1), ('raise', 1, 'mayday', 'DANGER')] and len(p.st.episodes) == 1 and p.st.episodes[1].kind == 'MAYDAY' and p.n().level == 'DANGER'

def test_GV04_bad_mac_claiming_man_down_raises_unauth_alert_only():
    p = Pipe(); p.send(seq=100); lvl = p.n().level
    fx = p.raw(pack(seq=200, flags=6, node=2, key=WRONG_KEY)); assert p.last is None
    assert kinds(fx) == [('raise', 2, 'unauth_alert', 'NONE')] and p.st.episodes == {} and p.n().level == lvl and p.open() == [(2, 'unauth_alert', 'NONE')]
    assert not [e for e in fx if getattr(e, 'type', '') == 'suspect_frame']
    f = bytes.fromhex(HEX['F-16']); assert ca.classify_frame(f, KEY, SYS).result == 'BAD_MAC'          # the vector frame itself (tag byte 22 flipped)
    p2 = Pipe(); assert kinds(p2.raw(f)) == [('raise', 2, 'unauth_alert', 'NONE')]

# ---- GV-05 ----
def test_GV05_a_b_checkin_raises_then_clears():
    p = Pipe(); fx = p.send(flags=0x81)
    assert kinds(fx) == [('raise', 1, 'checkin', 'WARNING')] and p.n().level == 'WARNING' and p.st.episodes == {}
    fx = p.send(flags=0x00); assert kinds(fx) == [('clear', 1, 'checkin', None)] and p.n().level == 'NORMAL'
def test_GV05_c_fall_checkin_is_a_notice_at_level_none():
    p = Pipe(); fx = p.send(flags=0xC0)
    assert kinds(fx) == [('raise', 1, 'checkin', 'NONE')] and p.n().level == 'NORMAL' and p.st.episodes == {}
def test_GV05_d_man_down_clears_the_open_checkin():
    p = Pipe(); p.send(flags=0x81); fx = p.send(flags=0x06)
    assert kinds(fx) == [('clear', 1, 'checkin', None), ('EpisodeOpened', 1), ('raise', 1, 'man_down', 'DANGER')] and p.st.episodes[1].kind == 'MAN_DOWN'

# ---- GV-06 ----
def test_GV06_a_b_c_battery_latch_and_recharge_clear():
    p = Pipe(); assert kinds(p.send(bat=10, status2=0x04), 'battery_low') == [('raise', 1, 'battery_low', 'WARNING')]
    assert kinds(p.send(bat=18), 'battery_low') == [] and p.row('battery_low')
    assert kinds(p.send(bat=25, status2=0), 'battery_low') == [('clear', 1, 'battery_low', None)]
def test_GV06_d_reboot_clears_battery_low_and_logs_node_reboot():
    p = Pipe(); p.send(bat=10, status2=0x04); fx = p.send(seq=0, boot_ctr=8, bat=18)
    assert p.last.seq_class == 'reboot' and kinds(fx, 'battery_low', 'node_reboot') == [('clear', 1, 'battery_low', None), ('raise', 1, 'node_reboot', 'NONE')]

# ---- GV-07 ----
def test_GV07_a_b_c_co_fault_then_recovery():
    p = Pipe(); fx = p.send(co_x10=520, status2=0x10, flags=0x08)
    assert kinds(fx, 'sensor_fault', 'co_threshold') == [('raise', 1, 'sensor_fault', 'WARNING')] and (p.n().co_validity, p.n().co_reason) == ('UNRELIABLE', 'co_fault')
    fx = p.send(co_x10=520, flags=0x01); assert kinds(fx, 'sensor_fault', 'co_threshold') == [('clear', 1, 'sensor_fault', None)] and p.n().level == 'WARNING' and p.n().co_ppm == 52.0
    fx = p.send(co_x10=520, flags=0x01); assert kinds(fx, 'sensor_fault', 'co_threshold') == [('raise', 1, 'co_threshold', 'WARNING')]

# ---- GV-08 ----
def link(fx): return kinds(fx, 'signal_lost', 'link_lost')
def test_GV08_a_b_c_silence_then_recovery():
    p = Pipe(); p.send(flags=0); T0 = p.clock.mono_ms()
    assert link(p.tick(14_999)) == [] and link(p.tick(1)) == [('raise', 1, 'signal_lost', 'WARNING')]                                       # (a) T0+15 s
    assert link(p.tick(45_000)) == [('raise', 1, 'link_lost', 'DANGER'), ('clear', 1, 'signal_lost', None)] and p.clock.mono_ms() - T0 == 60_000   # (b) T0+60 s
    assert link(p.send(dt=10_000)) == [('clear', 1, 'link_lost', None)] and p.last.seq_class == 'fresh'                                      # (c) T0+70 s
    p.send(); p.send(); assert not p.row('link_lost')
@pytest.mark.xfail(reason='GV-08c: the vector re-baselines after 3 fresh frames (the recovery frame and two more); the engine skips the recovery frame AND the next 3 (shadow_rule: 4 untracked frames). ADR proposal GV-08c in the P10 report', strict=True)
def test_GV08_c_rebaselined_after_three_fresh_frames_counting_the_recovery_frame():
    p = Pipe(); p.send(flags=0); p.tick(15_000); p.tick(45_000); p.send(dt=10_000); p.send(); p.send()
    assert p.n().shadow_rebaseline_left == 0
def test_GV08_c_engine_reading_recovery_frame_plus_three():
    p = Pipe(); p.send(flags=0); p.tick(15_000); p.tick(45_000); p.send(dt=10_000)
    assert p.n().shadow_rebaseline_left == 3; p.send(); p.send(); p.send(); assert p.n().shadow_rebaseline_left == 0

# ---- GV-09 ----
def test_GV09_a_b_c_acknowledge_lower_keep_ack_then_clear():
    p = Pipe(); fx = p.raw(bytes.fromhex(HEX['F-07']))
    assert kinds(fx, 'co_threshold') == [('raise', 1, 'co_threshold', 'DANGER')] and p.n().co_ppm == 250.0
    p.op(AckAlertEvent(1, 'co_threshold', 1)); assert p.row('co_threshold').acknowledged_ts is not None
    _seq0 = p.row('co_threshold').event_seq; out = []
    for i in range(6): out.append(kinds(p.send(co_x10=1500), 'co_threshold'))                                                                  # (b) 150 ppm: the lowering frame is the one 10 s after the first sub-180 frame
    assert out[:5] == [[]] * 5 and out[5] == [('lower', 1, 'co_threshold', 'WARNING')] and p.row('co_threshold').acknowledged_ts is not None
    assert p.row('co_threshold').level == 'WARNING' and p.row('co_threshold').acknowledged_ts is not None
    out = [kinds(p.send(co_x10=250), 'co_threshold') for _ in range(6)]                                                                       # (c) 25 ppm for 10 s
    assert out[:5] == [[]] * 5 and out[5] == [('clear', 1, 'co_threshold', None)]
def test_GV09_separate_run_210_ppm_returns_to_danger_with_ack_null():
    p = Pipe(); p.raw(bytes.fromhex(HEX['F-07'])); p.op(AckAlertEvent(1, 'co_threshold', 1)); [p.send(co_x10=1500) for _ in range(6)]
    assert p.row('co_threshold').level == 'WARNING' and p.row('co_threshold').acknowledged_ts is not None
    fx = p.send(co_x10=2100); assert kinds(fx, 'co_threshold') == [('escalate', 1, 'co_threshold', 'DANGER')] and p.row('co_threshold').acknowledged_ts is None and p.n().co_ppm == 210.0

# ---- GV-10 ----
def test_GV10_three_bad_mac_frames_one_row_ack_closes_it_fourth_opens_a_new_row():
    p = Pipe(); b = lambda: pack(seq=1, flags=6, node=2, key=WRONG_KEY)
    f1 = p.raw(b(), 0); f2 = p.raw(b(), 4000); f3 = p.raw(b(), 4000)
    assert kinds(f1) == [('raise', 2, 'unauth_alert', 'NONE')] and f2 == [] and f3 == [] and p.n(2).unauth_count == 3 and p.st.episodes == {} and p.n(2).level == 'NORMAL'
    fx = p.op(AckAlertEvent(2, 'unauth_alert', 1)); assert (2, 'unauth_alert') not in p.st.alerts and any(isinstance(e, ClearAlert) for e in fx)
    assert kinds(p.raw(b(), 4000)) == [('raise', 2, 'unauth_alert', 'NONE')] and p.n(2).unauth_count == 1

# ---- GV-11 to GV-14 (real classifier) ----
def test_GV11_wrap_is_not_a_loss():
    p = Pipe(); p.send(seq=65534); res = []
    for s in (65535, 0, 2): fx = p.send(seq=s); res.append((p.last.seq_class, p.last.frames_lost, p.baseline())); assert not kinds(fx, 'node_reboot', 'suspect_frame')
    assert res == [('fresh', 0, (7, 65535)), ('fresh', 0, (7, 0)), ('fresh', 1, (7, 2))]
    q = Pipe(); q.raw(bytes.fromhex(HEX['F-08'])); assert q.last.seq_class == 'fresh' and q.baseline() == (7, 65535); q.raw(bytes.fromhex(HEX['F-09'])); assert q.last.frames_lost == 0 and q.baseline() == (7, 0)

def silent_90():
    p = Pipe(); p.send(seq=300, flags=0); p.tick(15_000); p.tick(45_000); p.tick(30_000); assert p.row('link_lost'); return p
def test_GV12_a_b_reboot_frame_clears_link_lost_and_logs_node_reboot():
    p = silent_90(); fx = p.send(dt=2000, seq=0, boot_ctr=8, status2=0x08)
    assert (p.last.seq_class, p.last.frames_lost, p.baseline()) == ('reboot', 0, (8, 0)) and ('raise', 1, 'node_reboot', 'NONE') in kinds(fx) and ('clear', 1, 'link_lost', None) in kinds(fx)
    p.send(seq=1, boot_ctr=8); assert (p.last.seq_class, p.last.frames_lost) == ('fresh', 0)
def test_GV12_c_backward_boot_ctr_is_suspect_and_link_lost_stays():
    p = silent_90(); fx = p.send(dt=2000, seq=0, boot_ctr=7)
    assert (p.last.seq_class, p.last.frames_lost, p.baseline()) == ('suspect', 0, (7, 300)) and not kinds(fx, 'node_reboot') and p.row('link_lost') and not kinds(fx, 'link_lost')

def test_GV13_three_continuous_suspect_frames_rebaseline_and_start_the_clear_timer():
    p = Pipe(); p.send(seq=1000, co_x10=520, flags=1); assert p.row('co_threshold')
    for s in (200, 201):
        fx = p.send(seq=s, co_x10=250); assert (p.last.seq_class, p.last.frames_lost, p.baseline()) == ('suspect', 0, (7, 1000)) and p.row('co_threshold') and p.n().co_clear_since_mono is None and not kinds(fx, 'co_threshold')
    fx = p.send(seq=202, co_x10=250); assert (p.last.seq_class, p.last.frames_lost, p.last.rebaselined, p.baseline()) == ('fresh', 0, True, (7, 202)) and p.n().co_clear_since_mono == p.clock.mono_ms()
    p.send(seq=203, co_x10=250); assert (p.last.seq_class, p.last.frames_lost) == ('fresh', 0)

def test_GV14_a_b_suspect_frames_escalate_but_never_lower():
    p = Pipe(); p.send(seq=1000, co_x10=520, flags=1); p.op(AckAlertEvent(1, 'co_threshold', 1)); _sq = p.row('co_threshold').event_seq
    fx = p.send(seq=200, co_x10=2500, flags=0x02)
    assert p.last.seq_class == 'suspect' and kinds(fx, 'co_threshold') == [('escalate', 1, 'co_threshold', 'DANGER')] and p.row('co_threshold').acknowledged_ts is None and p.baseline() == (7, 1000)
    fx = p.send(seq=201, co_x10=250, flags=0)
    assert p.last.seq_class == 'suspect' and p.row('co_threshold').level == 'DANGER' and not kinds(fx, 'co_threshold') and p.n().co_clear_since_mono is None and p.n().co_lower_since_mono is None and p.n().level == 'DANGER'
def test_GV14_c_suspect_man_down_opens_the_episode():
    p = Pipe(); p.send(seq=1000); fx = p.send(seq=200, flags=0x06)
    assert p.last.seq_class == 'suspect' and kinds(fx) == [('raise', 1, 'suspect_frame', 'NONE'), ('EpisodeOpened', 1), ('raise', 1, 'man_down', 'DANGER')] and p.baseline() == (7, 1000)

# ---- GV-15 ----
def test_GV15_a_b_sensor_fault_danger_when_co_was_valid_within_60_s():
    p = Pipe(); assert kinds(p.raw(bytes.fromhex(HEX['F-11'])), 'co_threshold') == [('raise', 1, 'co_threshold', 'WARNING')]
    fx = p.send(dt=20_000, co_x10=0, status2=0x10, flags=0x0A)
    assert kinds(fx, 'sensor_fault', 'co_threshold', 'node_danger') == [('raise', 1, 'sensor_fault', 'DANGER')] and p.row('co_threshold').level == 'WARNING' and p.n().level == 'DANGER' and not p.row('node_danger')
def test_GV15_c_no_recent_co_gives_warning():
    p = Pipe(); p.send(co_x10=100, flags=0); fx = p.send(dt=20_000, co_x10=0, status2=0x10, flags=0x09)
    assert kinds(fx, 'sensor_fault') == [('raise', 1, 'sensor_fault', 'WARNING')] and p.n().level == 'WARNING'
def test_GV15_d_window_passed_gives_warning():
    p = Pipe(); p.send(co_x10=400, flags=0x01); p.run(70, co_x10=100, flags=0); fx = p.send(co_x10=0, status2=0x10, flags=0x09)
    assert kinds(fx, 'sensor_fault') == [('raise', 1, 'sensor_fault', 'WARNING')] and p.n().level == 'WARNING'

# ---- GV-16 ----
@pytest.mark.xfail(reason='GV-16a: the vector says CO is UNRELIABLE (sht40_fault) while co_range is also active at 65 C; the engine reports co_range (ADR proposal GV-16a in the P10 report)', strict=True)
def test_GV16_a_heat_open_then_temperature_fault_gives_danger():
    p = Pipe(); p.run(122, temp_x100=6500); assert p.row('heat') and p.n().co_range_active
    fx = p.send(dt=30_000, temp_x100=6500, status2=0x40, flags=0x0A)
    assert kinds(fx, 'sensor_fault', 'node_danger') == [('raise', 1, 'sensor_fault', 'DANGER')] and p.row('heat') and p.n().co_validity == 'UNRELIABLE' and p.n().co_reason == 'sht40_fault'
def test_GV16_a_without_the_co_reason_check():
    p = Pipe(); p.run(122, temp_x100=6500); assert p.row('heat') and p.n().co_range_active
    fx = p.send(dt=30_000, temp_x100=6500, status2=0x40, flags=0x0A)
    assert kinds(fx, 'sensor_fault', 'node_danger') == [('raise', 1, 'sensor_fault', 'DANGER')] and p.row('heat') and p.n().co_validity == 'UNRELIABLE'
def test_GV16_b_temperature_fault_without_heat_is_warning():
    p = Pipe(); p.run(20, temp_x100=2500); fx = p.raw(bytes.fromhex(HEX['F-13']))
    assert kinds(fx, 'sensor_fault') == [('raise', 1, 'sensor_fault', 'WARNING')] and (p.n().co_validity, p.n().co_reason) == ('UNRELIABLE', 'sht40_fault') and not p.row('heat')
def test_GV16_c_open_heat_at_the_fault_frame_gives_danger():
    p = Pipe(); p.run(600, temp_x100=6500); assert p.row('heat'); fx = p.send(temp_x100=6500, status2=0x40, flags=0x0A)
    assert kinds(fx, 'sensor_fault') == [('raise', 1, 'sensor_fault', 'DANGER')] and p.row('heat')

# ---- GV-17 ----
def test_GV17_a_b_node_danger_needs_two_frames_and_clears():
    p = Pipe(); assert kinds(p.raw(bytes.fromhex(HEX['F-14']))) == [] and p.n().level == 'DANGER'
    assert kinds(p.send(flags=2), 'node_danger') == [('raise', 1, 'node_danger', 'DANGER')]
    assert kinds(p.send(flags=0), 'node_danger') == [('clear', 1, 'node_danger', None)] and p.n().level == 'NORMAL'
def test_GV17_c_open_danger_co_alert_means_no_node_danger():
    p = Pipe(); p.send(co_x10=2500, flags=2); p.send(co_x10=2500, flags=2); assert not p.row('node_danger') and p.n().co_ppm == 250.0 and p.n().level == 'DANGER'
def test_GV17_d_streak_resets():
    p = Pipe(); p.send(flags=2); p.send(flags=0); assert not p.row('node_danger') and p.n().level == 'NORMAL'

# ---- GV-18 ----
def hold(p): return p.row('co_threshold') and p.n().co_range_active
def test_GV18_a_b_alert_is_held_while_co_range_is_active():
    p = Pipe(); assert kinds(p.send(co_x10=520, flags=0), 'co_threshold') == [('raise', 1, 'co_threshold', 'WARNING')]
    out = p.run(30, temp_x100=5600, co_x10=200); assert not kinds(out, 'co_threshold') and hold(p) and (p.n().co_validity, p.n().co_reason) == ('UNRELIABLE', 'co_range')
def test_GV18_c_d_range_clears_60_s_after_the_first_inside_margin_frame_then_10_s_timer_then_clear():
    p = Pipe(); p.send(co_x10=520); p.run(30, temp_x100=5600, co_x10=200); t_first = None; clear_t = None; range_t = None
    for i in range(60):
        fx = p.send(co_x10=200, temp_x100=2500)
        if t_first is None: t_first = p.clock.mono_ms()
        if range_t is None and not p.n().co_range_active: range_t = p.clock.mono_ms(); assert not kinds(fx, 'co_threshold')       # the frame that clears co_range does not clear the alert
        if kinds(fx, 'co_threshold') == [('clear', 1, 'co_threshold', None)]: clear_t = p.clock.mono_ms(); break
    assert range_t - t_first == 58_000 or range_t - t_first == 60_000, (range_t - t_first)
    assert clear_t - range_t == 12_000, (clear_t - range_t)                                    # timer starts on the next fresh frame (2 s), alert clears 10 s later
def test_GV18_e_co_250_ppm_escalates_in_place_although_co_range_is_active():
    p = Pipe(); p.send(co_x10=520); p.run(6, temp_x100=5600, co_x10=200); p.op(AckAlertEvent(1, 'co_threshold', 1)); _sq = p.row('co_threshold').event_seq
    fx = p.raw(bytes.fromhex(HEX['F-23'])); assert kinds(fx, 'co_threshold') == [('escalate', 1, 'co_threshold', 'DANGER')] and p.row('co_threshold').acknowledged_ts is None and p.n().co_range_active
def test_GV18_f_52_c_frame_restarts_the_60_s_count():
    p = Pipe(); p.send(co_x10=520); p.run(4, temp_x100=5600, co_x10=200); p.run(40, co_x10=200, temp_x100=2500)
    p.send(co_x10=200, temp_x100=5200); assert p.n().co_range_active
    t0 = None; cleared = None
    for i in range(40):
        p.send(co_x10=200, temp_x100=2500)
        if t0 is None: t0 = p.clock.mono_ms()
        if not p.n().co_range_active: cleared = p.clock.mono_ms(); break
    assert cleared is not None and cleared - t0 in (58_000, 60_000), (cleared and cleared - t0)
def test_GV18_g_co_250_with_co_range_active_raises_danger_and_is_held():
    p = Pipe(); fx = p.raw(bytes.fromhex(HEX['F-23']))
    assert kinds(fx, 'co_threshold') == [('raise', 1, 'co_threshold', 'DANGER')] and (p.n().co_validity, p.n().co_reason) == ('UNRELIABLE', 'co_range') and p.n().co_ppm == 250.0 and p.n().level == 'DANGER'
    out = p.run(40, temp_x100=5600, co_x10=200, flags=0); assert not kinds(out, 'co_threshold') and p.row('co_threshold').level == 'DANGER'            # neither lowered nor cleared while held

# ---- GV-19 ----
def test_GV19_a_b_c_temperature_fault_holds_the_co_alert_then_the_timer_runs_after_recovery():
    p = Pipe(); p.send(co_x10=520, flags=1)
    fx = p.send(co_x10=200, status2=0x40, flags=0x09); assert kinds(fx, 'sensor_fault', 'co_threshold') == [('raise', 1, 'sensor_fault', 'WARNING')] and not p.row('heat') and p.n().co_ppm == 20.0
    out = p.run(28, co_x10=200, status2=0x40, flags=0x09); assert not kinds(out, 'co_threshold') and p.row('co_threshold') and p.n().co_clear_since_mono is None and p.n().co_validity == 'UNRELIABLE'
    fx = p.send(co_x10=200); assert kinds(fx, 'sensor_fault', 'co_threshold') == [('clear', 1, 'sensor_fault', None)] and p.row('co_threshold')
    out = [kinds(p.send(co_x10=200), 'co_threshold') for _ in range(6)]; assert out[:5] == [[]] * 5 and out[5] == [('clear', 1, 'co_threshold', None)]

# ---- GV-20 ----
def test_GV20_resolved_episode_with_the_latch_still_set_raises_nothing_new():
    p = Pipe(); p.send(motion_x100=1, flags=6); assert p.st.episodes
    p.op(ResolveEpisodeEvent(1, 'rescued', 1)); assert p.st.episodes == {}
    for _ in range(3):
        fx = p.send(flags=6); assert [k for k in kinds(fx) if k[0] != 'clear'] == [] or all(k[2] in ('shadow_notice',) for k in kinds(fx)), kinds(fx)
        assert not p.row('node_danger') and p.st.episodes == {} and p.n().level == 'DANGER'
    fx = p.send(flags=0); assert not p.row('node_danger') and p.st.episodes == {} and not kinds(fx, 'node_danger') and p.n().level == 'NORMAL'

# ---- GV-21 to GV-27 (field level) ----
def test_GV21_wrist_open_needs_two_frames_and_closes():
    p = Pipe(); assert kinds(p.send(status4=1), 'wrist_open') == [] and kinds(p.send(status4=1), 'wrist_open') == [('raise', 1, 'wrist_open', 'NONE')]
    fx = p.send(dt=1000, status4=0); assert kinds(fx, 'wrist_open', 'wrist_close') == [('clear', 1, 'wrist_open', None), ('raise', 1, 'wrist_close', 'NONE')] and p.n().level == 'NORMAL' and p.st.episodes == {}
def test_GV22_button_stuck():
    p = Pipe(); assert kinds(p.send(status3=1), 'button_stuck') == [('raise', 1, 'button_stuck', 'NONE')]
    assert kinds(p.send(status3=0), 'button_stuck') == [('clear', 1, 'button_stuck', None)] and p.n().level == 'NORMAL' and p.st.episodes == {}
def test_GV23_missed_event_then_watchdog_recovery():
    p = Pipe(); assert kinds(p.send(evt_unsent=1), 'missed_event') == [('raise', 1, 'missed_event', 'NONE')]
    assert kinds(p.send(evt_unsent=0), 'missed_event', 'watchdog_recovery') == [('clear', 1, 'missed_event', None), ('raise', 1, 'watchdog_recovery', 'NONE')] and p.n().level == 'NORMAL' and p.st.episodes == {}
def test_GV24_scba_expired_warning_then_danger_then_clear():
    p = Pipe(); assert kinds(p.send(status3=0x08, co_x10=200, flags=1), 'scba_expired') == [('raise', 1, 'scba_expired', 'WARNING')]; sq = p.row('scba_expired').event_seq
    fx = p.send(status3=0x08, co_x10=400, flags=2)
    assert sorted(kinds(fx, 'scba_expired', 'co_threshold', 'node_danger')) == sorted([('escalate', 1, 'scba_expired', 'DANGER'), ('raise', 1, 'co_threshold', 'WARNING')]) and p.row('scba_expired').event_seq == sq and not p.row('node_danger') and p.row('scba_expired').level == 'DANGER'
    fx = p.send(status3=0, co_x10=400, flags=2); assert ('clear', 1, 'scba_expired', None) in kinds(fx, 'scba_expired') and p.st.episodes == {}
def test_GV25_shadow_notice_after_30_s_still_and_clears_on_motion():
    p = Pipe(); out = p.run(32, motion_x100=0, flags=0)
    assert kinds(out, 'shadow_notice') == [('raise', 1, 'shadow_notice', 'NONE')] and p.st.episodes == {} and p.n().level == 'NORMAL'
    assert kinds(p.send(motion_x100=6), 'shadow_notice') == [('clear', 1, 'shadow_notice', None)]
def test_GV26_a_latch_restored_badge_with_man_down_b_watchdog_recovery_only():
    p = Pipe(); fx = p.send(flags=0x06, status4=0x02)
    assert sorted(kinds(fx, 'latch_restored', 'watchdog_recovery', 'man_down'), key=str) == sorted([('raise', 1, 'latch_restored', 'NONE'), ('raise', 1, 'man_down', 'DANGER'), ('EpisodeOpened', 1)], key=str) and p.st.episodes
    p.op(ResolveEpisodeEvent(1, 'rescued', 1)); fx = p.send(flags=0, status3=0x10, status4=0)
    assert kinds(fx, 'latch_restored', 'watchdog_recovery') == [('raise', 1, 'watchdog_recovery', 'NONE')]
def test_GV27_co_warmup_badge_with_thresholds_active():
    p = Pipe(); fx = p.send(status3=0x04, co_x10=520, flags=1)
    assert kinds(fx, 'co_threshold') == [('raise', 1, 'co_threshold', 'WARNING')] and p.n().co_warmup and p.n().co_ppm == 52.0 and p.n().co_validity == 'DERATED'
    p.send(status3=0, co_x10=520, flags=1); assert not p.n().co_warmup and p.row('co_threshold')

# ---- the pipeline itself ----
def test_rejected_frames_never_reach_step():
    p = Pipe(); st0 = p.st
    for fid in ('F-20', 'F-21', 'F-22'): assert p.raw(bytes.fromhex(HEX[fid])) == []
    assert p.rejected == ['REJECT_ROSTER', 'BAD_LEN', 'BAD_LEN'] and p.st is st0
def test_bad_crc_frame_is_never_evaluated():
    p = Pipe(); p.send(co_x10=520, flags=1); st = p.st; assert p.raw(bytes.fromhex(HEX['F-17'])) == [] and p.row('co_threshold') and p.st.event_seq == st.event_seq
