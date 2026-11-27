"""P8: core/seq_classifier.py (design s01-sequence; GV-11, GV-12 classifier half, GV-13, GV-14) and the suspect_frame notice (14.1b).
GV-11 to GV-14 run the real classifier in front of step(). Raw bytes only matter for duplicate detection, so synthetic frames carry (node, boot, seq) in their first bytes. Requirements: REQ-ING-004."""
from test_co_state import co_frame, HEX
from test_co_threshold import Eng
from ppe_host.core import crypto_abi as ca
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import ChangeAlertLevel, ClearAlert, FrameEvent, RaiseAlert, TickEvent, raise_alert
from ppe_host.core.seq_classifier import DUPLICATE, FRESH, REBOOT, SUSPECT, SeqNode, SeqState, classify, reserved_bit_set

SUSPECT_NOTICE_ON = True        # conftest.py: this module needs suspect_frame_rule in RULES
REBOOT_HINT, RESERVED = 0x08, 0x04     # status2 bit 3; status4 bit 2 (a reserved bit)

def raw_of(seq, boot=7, node=1): return bytes([node, boot, seq & 255, seq >> 8]) + bytes(19)
def dec(seq, boot=7, status2=0, status4=0, flags=0, co=0, node=1):
    d = dict(co_frame(co_x10=co, status2=status2, node=node).decoded); d.update(seq=seq, boot_ctr=boot, status4=status4, flags=flags); return d
def cl(cs, seq, boot=7, mono=0, **kw): return classify(cs, 1, raw_of(seq, boot), dec(seq, boot, **kw), mono)
def base(boot, seq): return SeqState(nodes={1: SeqNode(boot, seq)})
def baseline(cs): return (cs.nodes[1].boot_ctr, cs.nodes[1].seq)

class Pipe:
    """The real classifier in front of the real engine, with a FakeClock (frames 2 s apart unless dt says otherwise)."""
    def __init__(self, at=None): self.e, self.cs = Eng(), (base(*at) if at else SeqState())
    def send(self, seq, boot=7, dt=2000, event=None, **kw):
        self.e.clock.advance(dt); d = dec(seq, boot, **kw)
        self.cs, r = classify(self.cs, 1, raw_of(seq, boot), d, self.e.clock.now().mono_ms)
        return r, self.e.step(event or FrameEvent(1, 'OK', r.seq_class, d), 0)
def kinds(fx): return [(type(x).__name__, getattr(x, 'type', None), getattr(x, 'level', None)) for x in fx]
def notices(fx): return [x for x in fx if isinstance(x, RaiseAlert) and x.type == 'suspect_frame']

def test_registry_and_import_rule():
    assert re_.suspect_frame_rule in re_.RULES and re_.RULES[-1] is re_.node_danger_rule and re_.RULES[-2] is re_.man_down_rule and re_.RULES[-3] is re_.notice_rule
    assert re_.RULES.index(re_.scba_expired_rule) < re_.RULES.index(re_.suspect_frame_rule)

# ---- GV-11: wrap ----
def test_GV11_a_b_c_wrap_is_not_a_loss_and_the_baseline_follows_each_frame():
    cs = base(7, 65534)
    for fid, seq in (('F-08', 65535), ('F-09', 0)):                       # the two vector frames, through the real codec
        raw = bytes.fromhex(HEX[fid]); d = ca.decode_frame(raw); assert d['seq'] == seq
        cs, r = classify(cs, 1, raw, d, 0); assert (r.seq_class, r.frames_lost) == (FRESH, 0) and baseline(cs) == (7, seq)
    cs, r = cl(cs, 2); assert (r.seq_class, r.frames_lost) == (FRESH, 1) and baseline(cs) == (7, 2)
def test_GV11_no_node_reboot_badge_on_a_wrap():
    p = Pipe((7, 65534)); [fx for _, fx in (p.send(65535), p.send(0))]; _, fx = p.send(2)
    assert not [x for x in fx if getattr(x, 'type', None) in ('node_reboot', 'suspect_frame')]

# ---- boundaries of the classifier ----
def test_first_verified_frame_is_fresh_and_sets_the_baseline():
    cs, r = cl(SeqState(), 500); assert (r.seq_class, r.frames_lost) == (FRESH, 0) and baseline(cs) == (7, 500)
def test_ds_boundaries_32767_is_forward_and_32768_is_backward():
    cs, r = cl(base(7, 0), 32767); assert (r.seq_class, r.frames_lost) == (FRESH, 32766)
    cs, r = cl(base(7, 0), 32768); assert (r.seq_class, r.frames_lost) == (SUSPECT, 0) and baseline(cs) == (7, 0)
def test_boot_ctr_step_1_to_127_is_a_reboot_128_to_255_is_suspect_and_wraps_modulo_256():
    for step_, cls in ((1, REBOOT), (127, REBOOT), (128, SUSPECT), (255, SUSPECT)):
        cs, r = cl(base(7, 300), 0, boot=(7 + step_) % 256); assert (r.seq_class, r.frames_lost) == (cls, 0), step_
        assert baseline(cs) == ((7 + step_) % 256, 0) if cls == REBOOT else baseline(cs) == (7, 300)
    cs, r = cl(base(255, 300), 0, boot=0); assert r.seq_class == REBOOT and baseline(cs) == (0, 0)
def test_a_boot_frame_with_an_unchanged_boot_ctr_is_suspect_but_the_hint_alone_is_not():
    cs, r = cl(base(7, 300), 0, status2=REBOOT_HINT); assert r.seq_class == SUSPECT and baseline(cs) == (7, 300)
    cs, r = cl(base(8, 0), 1, boot=8, status2=REBOOT_HINT); assert (r.seq_class, r.frames_lost) == (FRESH, 0)     # the hint stays set for 30 s after a real reboot
def test_a_repeated_seq_that_is_not_an_in_window_copy_is_suspect():
    cs, r = classify(base(7, 300), 1, raw_of(300) + b'x', dec(300), 0); assert r.seq_class == SUSPECT          # same (boot, seq), different bytes
    cs, r = cl(base(7, 300), 300); assert r.seq_class == SUSPECT                                              # no earlier copy remembered
def test_reserved_status_bit_is_suspect_and_leaves_baseline_and_run_alone():
    assert reserved_bit_set(dec(1, status4=RESERVED)) and not reserved_bit_set(dec(1))
    cs, r = cl(base(7, 1000), 1001, status4=RESERVED); assert (r.seq_class, r.frames_lost) == (SUSPECT, 0) and baseline(cs) == (7, 1000)
    cs, r = classify(cs, 1, raw_of(1001) + b'y', dec(1001), 2000); assert (r.seq_class, r.frames_lost) == (FRESH, 0)      # a different frame with the same seq: ds = 1 against the unchanged baseline
def test_duplicates_inside_5_s_are_flagged_never_counted_and_boot_ctr_is_part_of_the_key():
    cs, r = cl(SeqState(), 10); cs, r = cl(cs, 10, mono=4999); assert (r.seq_class, r.frames_lost) == (DUPLICATE, 0) and baseline(cs) == (7, 10)
    cs, r = cl(cs, 11, mono=5000); assert (r.seq_class, r.frames_lost) == (FRESH, 0)
    cs, r = cl(base(7, 300), 0, boot=8, mono=0); cs, r = cl(cs, 0, boot=8, mono=100); assert r.seq_class == DUPLICATE   # same bytes again
    cs, r = cl(base(7, 0), 0, boot=7, mono=0); assert r.seq_class == SUSPECT                                        # a pre-reboot seq 0 is no copy of the post-reboot one
    cs, r = cl(base(7, 0), 0, boot=8); assert r.seq_class == REBOOT
def test_the_same_bytes_after_the_window_are_a_suspect_repeat():
    cs, r = cl(SeqState(), 10); cs, r = cl(cs, 10, mono=5001); assert r.seq_class == SUSPECT
def test_classify_is_pure_and_deterministic():
    s0 = base(7, 5); a = cl(s0, 6); b = cl(s0, 6); assert a == b and s0 == base(7, 5)
def test_rebaseline_needs_three_mutually_continuous_suspects_and_a_gap_or_a_fresh_frame_restarts_the_count():
    cs = base(7, 1000)
    cs, r1 = cl(cs, 200, mono=0); cs, r2 = cl(cs, 201, mono=2000); cs, r3 = cl(cs, 202, mono=4000)
    assert [x.seq_class for x in (r1, r2, r3)] == [SUSPECT, SUSPECT, FRESH] and r3.rebaselined and r3.frames_lost == 0 and baseline(cs) == (7, 202)
    cs = base(7, 1000)
    cs, a = cl(cs, 200); cs, b = cl(cs, 201, mono=2000); cs, c = cl(cs, 500, mono=4000)                    # 201 -> 500 is a forward step: continuous, so this is the third
    assert c.seq_class == FRESH and c.rebaselined
    cs = base(7, 1000)
    cs, a = cl(cs, 200); cs, b = cl(cs, 100, mono=2000); cs, c = cl(cs, 101, mono=4000); assert c.seq_class == SUSPECT and not c.rebaselined      # 200 -> 100 is not continuous: the count restarts
    cs = base(7, 1000)
    cs, a = cl(cs, 200); cs, b = cl(cs, 201, mono=2000); cs, f = cl(cs, 1001, mono=4000); cs, c = cl(cs, 202, mono=6000)
    assert f.seq_class == FRESH and c.seq_class == SUSPECT                                                   # a fresh frame in between resets the run

# ---- GV-12: reboot (classifier half and its engine effects) ----
def _silent_node():
    p = Pipe(); p.send(300); p.e.step(TickEvent(), 90_000); assert (1, 'link_lost') in p.e.state.alerts; return p
def test_GV12_a_b_reboot_frame_clears_link_lost_and_raises_node_reboot_then_the_next_frame_is_fresh():
    p = _silent_node(); r, fx = p.send(0, boot=8, status2=REBOOT_HINT)
    assert (r.seq_class, r.frames_lost) == (REBOOT, 0) and baseline(p.cs) == (8, 0)
    assert ('ClearAlert', 'link_lost', None) in kinds(fx) and ('RaiseAlert', 'node_reboot', 'NONE') in kinds(fx) and not notices(fx)
    r, fx = p.send(1, boot=8); assert (r.seq_class, r.frames_lost) == (FRESH, 0)
def test_GV12_c_backward_seq_is_suspect_no_badge_link_lost_stays_and_the_baseline_stays():
    p = _silent_node(); r, fx = p.send(0, boot=7)
    assert (r.seq_class, r.frames_lost) == (SUSPECT, 0) and baseline(p.cs) == (7, 300) and (1, 'link_lost') in p.e.state.alerts
    assert not [x for x in fx if isinstance(x, ClearAlert) or getattr(x, 'type', None) == 'node_reboot'] and len(notices(fx)) == 1

# ---- GV-13: backward frames and re-baseline ----
def _co_warning_node():
    p = Pipe((7, 1000)); p.e.state, _ = raise_alert(p.e.state, 1, 'co_threshold', 'WARNING', 'setup', p.e.clock.now()); return p
def test_GV13_a_to_d_two_suspects_then_the_third_is_accepted_and_starts_the_clear_timer():
    p = _co_warning_node(); n = lambda: p.e.state.nodes[1]
    r, fx = p.send(200, co=250); assert r.seq_class == SUSPECT and baseline(p.cs) == (7, 1000) and (1, 'co_threshold') in p.e.state.alerts and n().co_clear_since_mono is None
    r, fx = p.send(201, co=250); assert r.seq_class == SUSPECT and n().co_clear_since_mono is None and not [x for x in fx if isinstance(x, ClearAlert)]
    r, fx = p.send(202, co=250); t0 = p.e.clock.now().mono_ms
    assert (r.seq_class, r.frames_lost, r.rebaselined) == (FRESH, 0, True) and baseline(p.cs) == (7, 202) and n().co_clear_since_mono == t0 and (1, 'co_threshold') in p.e.state.alerts
    r, fx = p.send(203, co=250); assert (r.seq_class, r.frames_lost) == (FRESH, 0)
    for seq in (204, 205, 206): r, fx = p.send(seq, co=250); assert (1, 'co_threshold') in p.e.state.alerts       # 8 s after the third frame
    r, fx = p.send(207, co=250); assert [x.reason for x in fx if isinstance(x, ClearAlert)] and (1, 'co_threshold') not in p.e.state.alerts    # 10 s

# ---- GV-14: suspect frames are raise-only ----
def test_GV14_a_b_a_suspect_frame_escalates_in_place_and_never_lowers():
    p = _co_warning_node(); row = p.e.state.alerts[(1, 'co_threshold')]
    p.e.state = re_.replace(p.e.state, alerts={**p.e.state.alerts, (1, 'co_threshold'): re_.replace(row, acknowledged_ts=1)})      # the operator acknowledged it
    r, fx = p.send(200, co=2500, flags=0x02)
    ch = [x for x in fx if isinstance(x, ChangeAlertLevel)]; assert r.seq_class == SUSPECT and len(ch) == 1 and ch[0].level == 'DANGER' and ch[0].acknowledged_reset
    assert p.e.state.alerts[(1, 'co_threshold')].acknowledged_ts is None and p.e.state.alerts[(1, 'co_threshold')].event_seq == row.event_seq and baseline(p.cs) == (7, 1000)
    r, fx = p.send(201, co=250); assert r.seq_class == SUSPECT and p.e.state.alerts[(1, 'co_threshold')].level == 'DANGER' and p.e.state.nodes[1].level == 'DANGER'
    assert p.e.state.nodes[1].co_clear_since_mono is None and p.e.state.nodes[1].co_lower_since_mono is None and not [x for x in fx if isinstance(x, (ClearAlert, ChangeAlertLevel))]
def test_GV14_c_a_suspect_man_down_opens_the_episode_and_raises_the_notice():
    p = Pipe((7, 1000)); r, fx = p.send(200, flags=0x06)
    assert r.seq_class == SUSPECT and baseline(p.cs) == (7, 1000) and len(p.e.state.episodes) == 1 and (1, 'man_down') in p.e.state.alerts
    assert [t for t in kinds(fx) if t[1] in ('man_down', 'suspect_frame')] == [('RaiseAlert', 'suspect_frame', 'NONE'), ('RaiseAlert', 'man_down', 'DANGER')]

# ---- suspect_frame notice (14.1b) ----
def test_a_verified_suspect_frame_gives_one_notice_and_30_more_add_none():
    p = Pipe((7, 1000)); r, fx = p.send(900); n = notices(fx); assert len(n) == 1 and n[0].level == 'NONE' and n[0].one_shot and n[0].reasons.startswith('seq=900 boot_ctr=7')
    assert not p.e.state.alerts and p.e.state.nodes[1].level == 'NORMAL' and p.e.state.episodes == {}              # one-shot: never held open, no level, no episode
    total = 0
    for i in range(30): r, fx = p.send(800 - 10 * i); assert r.seq_class == SUSPECT; total += len(notices(fx))      # descending: never three continuous
    assert total == 0 and p.e.state.event_seq == 1
def test_a_fresh_frame_ends_the_run_so_the_next_suspect_run_raises_again_and_a_suspect_frame_never_ends_it():
    p = Pipe((7, 1000)); p.send(900); r, fx = p.send(800); assert not notices(fx) and p.e.state.nodes[1].suspect_prev
    r, fx = p.send(1001); assert r.seq_class == FRESH and not p.e.state.nodes[1].suspect_prev and not notices(fx)
    r, fx = p.send(700); assert len(notices(fx)) == 1
def test_the_accepted_third_frame_counts_as_fresh_and_ends_the_run():
    p = Pipe((7, 1000)); [p.send(s) for s in (200, 201, 202)]; assert not p.e.state.nodes[1].suspect_prev and len(notices(p.send(100)[1])) == 1
def test_a_reserved_status_bit_raises_the_notice_with_its_reason():
    p = Pipe((7, 1000)); r, fx = p.send(1001, status4=RESERVED); n = notices(fx); assert r.seq_class == SUSPECT and len(n) == 1 and n[0].reasons.startswith('reserved_bit ')
    e = Eng(); d = dec(1, status4=RESERVED); fx = e.step(FrameEvent(1, 'OK', 'fresh', d), 2000); assert len(notices(fx)) == 1       # 14.1b: the condition is the bit itself
def test_no_notice_for_a_frame_the_gate_drops_or_one_that_failed_verification():
    p = Pipe((7, 1000)); r, fx = p.send(200, flags=0x03); assert r.seq_class == SUSPECT and fx == []             # flags level 3 is never evaluated (14.1)
    e = Eng(); assert notices(e.step(FrameEvent(1, 'BAD_MAC', 'suspect', dec(200)), 2000)) == [] and notices(e.step(FrameEvent(1, 'BAD_CRC', 'suspect', dec(200)), 2000)) == []
    assert notices(e.step(FrameEvent(1, 'OK', 'duplicate', dec(200)), 2000)) == []
def test_a_suspect_frame_never_clears_anything_the_property_over_many_orders():
    import itertools
    for seqs in itertools.permutations((50, 900, 1001, 1002), 3):
        p = _co_warning_node(); p.e.state, _ = raise_alert(p.e.state, 1, 'battery_low', 'WARNING', 'setup', p.e.clock.now())
        for s in seqs:
            r, fx = p.send(s)
            if r.seq_class == SUSPECT: assert not [x for x in fx if isinstance(x, (ClearAlert, ChangeAlertLevel))]
