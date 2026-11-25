"""P7-2: battery_low (GV-06), signal_lost and link_lost (GV-08, GV-12 link half) and unauth_alert (GV-04, GV-10) (design 14.1 and 14.1b).
All rules are registered here. GV-04 and GV-06 a, d also run in the harness table; GV-08 and GV-12 live in this file because a silent node
also gets a co_timeout sensor_fault from P6c (see the OPEN QUESTION test), so these tests look at link effects only."""
import pytest
from test_co_state import co_frame
from test_co_threshold import Eng
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import FrameEvent, TickEvent, clear_alert

WARN, DNG, MD = 0x01, 0x02, 0x04
def fr(flags=0, bat=80, status2=0, seq_class='fresh', node=1):
    d = dict(co_frame(node=node).decoded); d.update(flags=flags, bat=bat, status2=status2)
    return FrameEvent(node, 'OK', seq_class, d)
def bad(flags=0x06, node=2, verify='BAD_MAC'):
    d = dict(co_frame(node=node).decoded); d['flags'] = flags
    return FrameEvent(node, verify, 'suspect', d)
def tys(fx, types): return [(type(x).__name__, x.type, getattr(x, 'level', None)) for x in fx if x.type in types]
LINK = ('signal_lost', 'link_lost')
def lk(fx): return tys(fx, LINK)
def al(e, t, n=1): return e.state.alerts.get((n, t))

def test_order_new_rules_sit_before_man_down_and_node_danger_stays_last():
    r = re_.RULES; assert r[-1] is re_.node_danger_rule and r[-2] is re_.man_down_rule and r.index(re_.battery_low_rule) < r.index(re_.link_rule) < len(r) - 2

# ---- battery_low (GV-06) ----
def test_GV06_a_b_c_latch_and_recharge_clear():
    e = Eng(); assert tys(e.step(fr(bat=10, status2=0x04), 0), ('battery_low',)) == [('RaiseAlert', 'battery_low', 'WARNING')] and e.state.nodes[1].level == 'WARNING'
    for bat in (12, 18, 24): assert e.step(fr(bat=bat)) == [] and al(e, 'battery_low') is not None      # (b) stays open although bat rose
    assert tys(e.step(fr(bat=25)), ('battery_low',)) == [('ClearAlert', 'battery_low', None)] and al(e, 'battery_low') is None and e.state.nodes[1].level == 'NORMAL'

def test_GV06_d_reboot_clears_the_latch():
    e = Eng(); e.step(fr(bat=10), 0); fx = e.step(fr(bat=18, seq_class='reboot'))
    assert tys(fx, ('battery_low',)) == [('ClearAlert', 'battery_low', None)] and al(e, 'battery_low') is None

def test_reboot_that_still_shows_low_battery_clears_and_reopens():
    e = Eng(); e.step(fr(bat=10), 0); old = al(e, 'battery_low').event_seq
    assert tys(e.step(fr(bat=9, seq_class='reboot')), ('battery_low',)) == [('ClearAlert', 'battery_low', None), ('RaiseAlert', 'battery_low', 'WARNING')] and al(e, 'battery_low').event_seq != old

@pytest.mark.parametrize('bat,status2,opens', [(10, 0, True), (11, 0, False), (11, 0x04, False), (0, 0, True), (80, 0x04, False)])
def test_trigger_is_percent_at_or_below_bat_warn_pct(bat, status2, opens):
    e = Eng(); e.step(fr(bat=bat, status2=status2), 0); assert (al(e, 'battery_low') is not None) == opens

def test_suspect_frame_can_open_but_never_clears_and_duplicates_are_ignored():
    e = Eng(); assert tys(e.step(fr(bat=5, seq_class='suspect'), 0), ('battery_low',)) == [('RaiseAlert', 'battery_low', 'WARNING')]
    assert e.step(fr(bat=90, seq_class='suspect')) == [] and al(e, 'battery_low') is not None
    assert e.step(fr(bat=90, seq_class='duplicate')) == [] and al(e, 'battery_low') is not None

# ---- signal_lost and link_lost (GV-08, GV-12 link half) ----
def test_GV08_a_b_c_non_adverse_node():
    e = Eng(); e.step(fr(), 0)
    assert lk(e.step(TickEvent(), 14_999)) == [] and lk(e.step(TickEvent(), 1)) == [('RaiseAlert', 'signal_lost', 'WARNING')]            # (a) T0+15 s
    assert lk(e.step(TickEvent(), 1000)) == [] and al(e, 'link_lost') is None                                                             # no repeat
    assert lk(e.step(TickEvent(), 44_000)) == [('RaiseAlert', 'link_lost', 'DANGER'), ('ClearAlert', 'signal_lost', None)]               # (b) T0+60 s
    assert al(e, 'signal_lost') is None and e.state.nodes[1].level == 'DANGER'
    assert lk(e.step(fr(), 10_000)) == [('ClearAlert', 'link_lost', None)] and al(e, 'link_lost') is None and e.state.nodes[1].level == 'NORMAL'   # (c) first fresh frame
    assert lk(e.step(fr())) == [] and lk(e.step(fr())) == []

def test_fresh_frame_clears_signal_lost():
    e = Eng(); e.step(fr(), 0); e.step(TickEvent(), 20_000); assert al(e, 'signal_lost') is not None
    assert lk(e.step(fr())) == [('ClearAlert', 'signal_lost', None)]

@pytest.mark.parametrize('flags', [WARN, DNG | 0, 0x06])
def test_adverse_last_frame_gives_link_lost_after_15_s_with_no_signal_lost(flags):
    e = Eng(); e.step(fr(flags=flags), 0)
    assert lk(e.step(TickEvent(), 14_999)) == [] and lk(e.step(TickEvent(), 1)) == [('RaiseAlert', 'link_lost', 'DANGER')] and al(e, 'signal_lost') is None

def test_GV12_a_reboot_frame_clears_link_lost():
    e = Eng(); e.step(fr(), 0); e.step(TickEvent(), 90_000); assert al(e, 'link_lost') is not None
    assert lk(e.step(fr(seq_class='reboot', status2=0x08))) == [('ClearAlert', 'link_lost', None)]

def test_GV12_c_suspect_frame_never_clears_link_lost_or_resets_the_silence_clock():
    e = Eng(); e.step(fr(), 0); e.step(TickEvent(), 90_000)
    assert e.step(fr(seq_class='suspect')) == [] and al(e, 'link_lost') is not None
    e2 = Eng(); e2.step(fr(), 0); e2.step(fr(seq_class='suspect'), 14_000)                                          # a suspect frame at 14 s does not restart the 15 s
    assert lk(e2.step(TickEvent(), 1000)) == [('RaiseAlert', 'signal_lost', 'WARNING')]

def test_node_never_heard_has_no_silence_alert_and_nodes_are_independent():
    e = Eng(); assert lk(e.step(TickEvent(), 100_000)) == []
    e.step(fr(node=2), 0); e.step(TickEvent(), 30_000); assert al(e, 'signal_lost', 2) is not None and al(e, 'signal_lost', 1) is None

def test_OPEN_QUESTION_silent_node_also_gets_co_timeout_sensor_fault():
    """Records current behaviour (P6c): a silent node passes the 5 s co_timeout on the first tick, so sensor_fault opens next to signal_lost.
    GV-08 lists only signal_lost and link_lost. If the design owner decides silence is not a CO fault, change this test with that fix."""
    e = Eng(); e.step(fr(), 0); fx = e.step(TickEvent(), 20_000)
    assert {x.type for x in fx} == {'sensor_fault', 'signal_lost'}

# ---- unauth_alert (GV-04, GV-10) ----
def test_GV04_bad_mac_claiming_man_down_raises_unauth_alert_none_and_nothing_else():
    e = Eng(); fx = e.step(bad(), 0)
    assert tys(fx, ('unauth_alert',)) == [('RaiseAlert', 'unauth_alert', 'NONE')] and len(fx) == 1 and e.state.episodes == {}
    assert e.state.nodes[2].level == 'NORMAL' and set(e.state.alerts) == {(2, 'unauth_alert')}

def test_GV10_coalesces_counts_and_a_new_card_after_acknowledge():
    e = Eng(); fx = e.step(bad(), 0) + e.step(bad(), 4000) + e.step(bad(), 4000)
    assert len(fx) == 1 and e.state.nodes[2].unauth_count == 3 and e.state.nodes[2].unauth_last_seen_ts == e.clock.wall_ms()
    e.state, _ = clear_alert(e.state, 2, 'unauth_alert', e.clock.now(), 'acknowledged')
    fx = e.step(bad(), 4000); assert tys(fx, ('unauth_alert',)) == [('RaiseAlert', 'unauth_alert', 'NONE')] and e.state.nodes[2].unauth_count == 1

@pytest.mark.parametrize('flags,raises', [(0x00, False), (0x01, True), (0x02, True), (0x04, True), (0x08, False), (0x80, False), (0x03, False)])
def test_only_a_frame_that_claims_an_alert_counts(flags, raises):
    e = Eng(); assert bool(e.step(bad(flags=flags), 0)) == raises

@pytest.mark.parametrize('ev', [bad(verify='BAD_CRC'), bad(verify='BAD_LEN'), bad(node=0), bad(node=5)])
def test_other_failures_and_non_roster_nodes_raise_nothing(ev):
    e = Eng(); assert e.step(ev, 0) == [] and e.state.alerts == {}

def test_unauth_alert_does_not_touch_a_real_node_state():
    e = Eng(); e.step(fr(flags=WARN), 0); lvl = e.state.nodes[1]; e.step(bad(node=1), 1000)
    assert e.state.nodes[1].level == lvl.level == 'WARNING' and al(e, 'unauth_alert') is not None and al(e, 'man_down') is None
