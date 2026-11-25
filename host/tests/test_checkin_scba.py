"""P7c-2: checkin and scba_expired (design 14.1 rows; GV-05 a to d, GV-24 a to c). Frames are built from co_frame; flags, status2, status3 and CO are set per test."""
import pytest
from test_co_state import co_frame
from test_co_threshold import Eng
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import AckAlertEvent, ClearAlert, FrameEvent, RaiseAlert, ChangeAlertLevel, TickEvent

CI, CI_FALL, MD, CI_MD = 0x81, 0xC0, 0x06, 0x86         # flags: check-in + WARNING, check-in + fall suspected (level NORMAL), man-down + DANGER, both (0x87 would be node_level 3 = INVALID, never evaluated)
EXP, CO_FAULT = 0x08, 0x10                   # status3 bit 3, status2 bit 4
def cf(flags=0, status3=0, co=0, status2=0, seq_class='fresh', temp=2500, node=1):
    d = dict(co_frame(co_x10=co, temp_x100=temp, status2=status2, status3=status3, node=node).decoded); d.update(flags=flags)
    return FrameEvent(node, 'OK', seq_class, d)
def nm(fx): return [(type(x).__name__, getattr(x, 'type', None), getattr(x, 'level', None)) for x in fx]
def sc(fx): return [t for t in nm(fx) if t[1] == 'scba_expired']      # co_threshold runs on the same frames and has its own effects
def al(e, t, n=1): return e.state.alerts.get((n, t))
def lvl(e): return e.state.nodes[1].level

def test_rule_order_checkin_and_scba_run_before_the_notices_and_man_down_and_node_danger_stays_last():
    r = re_.RULES
    assert r.index(re_.link_rule) < r.index(re_.checkin_rule) < r.index(re_.scba_expired_rule) < r.index(re_.notice_rule) < r.index(re_.man_down_rule) and r[-1] is re_.node_danger_rule

# ---- checkin (GV-05) ----
def test_GV05a_a_check_in_bit_raises_checkin_at_warning_with_no_episode():
    e = Eng(); fx = e.step(cf(CI)); assert nm(fx) == [('RaiseAlert', 'checkin', 'WARNING')] and lvl(e) == 'WARNING' and e.state.episodes == {}
    assert e.step(cf(CI)) == [] and e.step(cf(CI)) == []                       # held: no second row

def test_GV05b_the_next_frame_with_bit_7_at_0_clears_the_row():
    e = Eng(); e.step(cf(CI)); fx = e.step(cf(0)); assert nm(fx) == [('ClearAlert', 'checkin', None)] and fx[0].reason == 'jacket_cancel' and al(e, 'checkin') is None and lvl(e) == 'NORMAL'

def test_GV05c_a_fall_only_prompt_is_a_notice_at_level_none_and_never_a_node_level():
    e = Eng(); fx = e.step(cf(CI_FALL)); assert nm(fx) == [('RaiseAlert', 'checkin', 'NONE')] and 'fall_prompt' in fx[0].reasons
    assert lvl(e) == 'NORMAL' and e.state.episodes == {} and e.step(cf(0))[0].reason == 'jacket_cancel'

def test_GV05d_man_down_opens_its_episode_and_the_check_in_row_clears():
    e = Eng(); e.step(cf(CI)); fx = e.step(cf(MD))
    assert nm(fx) == [('ClearAlert', 'checkin', None), ('EpisodeOpened', None, None), ('RaiseAlert', 'man_down', 'DANGER')] and len(e.state.episodes) == 1 and al(e, 'checkin') is None

def test_a_frame_with_check_in_and_mandown_together_opens_no_checkin_and_clears_an_open_one():
    e = Eng(); assert [t for t, *_ in nm(e.step(cf(CI_MD)))] == ['EpisodeOpened', 'RaiseAlert'] and al(e, 'checkin') is None
    e = Eng(); e.step(cf(CI)); fx = e.step(cf(CI_MD)); assert fx[0].reason == 'man_down_opened' and al(e, 'checkin') is None
    assert e.step(cf(CI_MD)) == []                                            # the bit stays set: no edge, nothing reopens

def test_a_new_rising_edge_after_the_clear_opens_a_new_row():
    e = Eng(); e.step(cf(CI)); first = al(e, 'checkin').event_seq; e.step(cf(0)); e.step(cf(CI)); assert al(e, 'checkin').event_seq > first

def test_acknowledge_never_closes_a_checkin():
    e = Eng(); e.step(cf(CI)); fx = e.step(AckAlertEvent(1, 'checkin', 7), 0); assert [type(x).__name__ for x in fx] == ['AlertAcknowledged'] and al(e, 'checkin').acknowledged_ts is not None

def test_a_suspect_frame_may_open_a_checkin_but_never_clears_it_or_moves_the_edge_memory():
    e = Eng(); assert nm(e.step(cf(CI, seq_class='suspect'))) == [('RaiseAlert', 'checkin', 'WARNING')]
    assert e.step(cf(0, seq_class='suspect')) == [] and al(e, 'checkin') is not None   # raise-only: no clear
    assert e.step(cf(CI)) == [] and len([1 for _ in e.state.alerts]) == 1               # the fresh frame finds the row open: no duplicate
    assert e.step(cf(0))[0].reason == 'jacket_cancel'

def test_a_duplicate_or_failed_frame_changes_nothing():
    e = Eng(); assert e.step(cf(CI, seq_class='duplicate')) == [] and al(e, 'checkin') is None
    d = cf(CI).decoded; assert e.step(FrameEvent(1, 'BAD_CRC', 'fresh', d)) == []

def test_after_a_restart_with_the_row_open_a_held_bit_adds_nothing():
    e = Eng(); e.step(cf(CI)); e.state = re_.EngineState(event_seq=e.state.event_seq, alerts=dict(e.state.alerts))   # node memory gone, open rows rebuilt
    assert e.step(cf(CI)) == [] and len(e.state.alerts) == 1

# ---- scba_expired (GV-24) ----
def test_GV24_a_b_c_warning_then_dangers_in_place_then_clears_and_no_episode():
    e = Eng(); fx = e.step(cf(0x01, EXP, co=200)); assert nm(fx) == [('RaiseAlert', 'scba_expired', 'WARNING')] and lvl(e) == 'WARNING'
    seq = al(e, 'scba_expired').event_seq; e.step(AckAlertEvent(1, 'scba_expired', 7), 0)
    fx = e.step(cf(0x02, EXP, co=400)); assert nm(fx) == [('RaiseAlert', 'co_threshold', 'WARNING'), ('ChangeAlertLevel', 'scba_expired', 'DANGER')]
    r = al(e, 'scba_expired'); assert r.event_seq == seq and r.level == 'DANGER' and r.acknowledged_ts is None and al(e, 'node_danger') is None and lvl(e) == 'DANGER'
    fx = e.step(cf(0x02, 0, co=400)); assert ('ClearAlert', 'scba_expired', None) in nm(fx) and al(e, 'scba_expired') is None and e.state.episodes == {}

def test_it_opens_straight_at_danger_when_a_usable_reading_is_at_35_ppm_or_more():
    e = Eng(); assert nm(e.step(cf(0x02, EXP, co=350)))[-1] == ('RaiseAlert', 'scba_expired', 'DANGER')
    e = Eng(); assert nm(e.step(cf(0x01, EXP, co=349)))[-1] == ('RaiseAlert', 'scba_expired', 'WARNING')

def test_a_co_fault_frame_has_no_reading_so_it_never_escalates_or_opens_at_danger():
    e = Eng(); assert nm(e.step(cf(0x09, EXP, co=400, status2=CO_FAULT)))[-1] == ('RaiseAlert', 'scba_expired', 'WARNING')

def test_danger_lowers_to_warning_in_place_after_10_s_below_31_5_and_keeps_the_acknowledgement():
    e = Eng(); e.step(cf(0x02, EXP, co=400)); e.step(AckAlertEvent(1, 'scba_expired', 7), 0); ack = al(e, 'scba_expired').acknowledged_ts
    e.step(cf(0x01, EXP, co=300), 0)                                            # 30.0 ppm: the 10 s run starts here
    assert sc(e.step(cf(0x01, EXP, co=300), 9999)) == [] and al(e, 'scba_expired').level == 'DANGER'
    fx = e.step(cf(0x01, EXP, co=300), 1); assert sc(fx) == [('ChangeAlertLevel', 'scba_expired', 'WARNING')] and [x for x in fx if isinstance(x, ChangeAlertLevel)][0].acknowledged_reset is False
    assert al(e, 'scba_expired').acknowledged_ts == ack and e.state.nodes[1].scba_lower_since_mono is None

def test_a_reading_at_or_above_31_5_resets_the_lowering_run():
    e = Eng(); e.step(cf(0x02, EXP, co=400)); e.step(cf(0x01, EXP, co=300), 0); e.step(cf(0x01, EXP, co=315), 9000)
    assert sc(e.step(cf(0x01, EXP, co=300), 1000)) == [] and sc(e.step(cf(0x01, EXP, co=300), 9999)) == [] and al(e, 'scba_expired').level == 'DANGER'
    assert sc(e.step(cf(0x01, EXP, co=300), 1)) == [('ChangeAlertLevel', 'scba_expired', 'WARNING')]

def test_the_lowering_timer_does_not_run_while_co_is_held_by_the_range_limit():
    e = Eng(); e.step(cf(0x02, EXP, co=400))
    for _ in range(8): e.step(cf(0x01, EXP, co=200, temp=5600))                 # 56 C: co_range active, readings held for the 14.2 rules
    assert al(e, 'scba_expired').level == 'DANGER' and e.state.nodes[1].scba_lower_since_mono is None

def test_the_row_clears_only_on_a_fresh_frame_with_the_bit_at_0():
    e = Eng(); e.step(cf(0x01, EXP, co=100)); assert e.step(cf(0x00, 0, co=100, seq_class='suspect')) == [] and al(e, 'scba_expired') is not None
    assert e.step(cf(0x00, EXP, co=100)) == []                                  # bit still set
    assert nm(e.step(cf(0x00, 0, co=100))) == [('ClearAlert', 'scba_expired', None)]

def test_a_suspect_frame_may_open_and_escalate_but_never_lowers_or_moves_the_timer():
    e = Eng(); assert sc(e.step(cf(0x01, EXP, co=100, seq_class='suspect'))) == [('RaiseAlert', 'scba_expired', 'WARNING')]
    assert sc(e.step(cf(0x02, EXP, co=400, seq_class='suspect'))) == [('ChangeAlertLevel', 'scba_expired', 'DANGER')]
    for _ in range(8): e.step(cf(0x01, EXP, co=100, seq_class='suspect'), 2000)
    assert al(e, 'scba_expired').level == 'DANGER' and e.state.nodes[1].scba_lower_since_mono is None

def test_a_warning_row_never_escalates_on_a_held_or_missing_reading_and_acknowledge_never_closes_it():
    e = Eng(); e.step(cf(0x01, EXP, co=100)); e.step(cf(0x01, EXP, co=400, status2=CO_FAULT))
    assert al(e, 'scba_expired').level == 'WARNING'
    fx = e.step(AckAlertEvent(1, 'scba_expired', 7), 0); assert [type(x).__name__ for x in fx] == ['AlertAcknowledged'] and al(e, 'scba_expired') is not None

def test_scba_expired_is_per_node_and_opens_no_episode_at_any_step():
    e = Eng(); e.step(cf(0x01, EXP, co=100, node=2)); assert (2, 'scba_expired') in e.state.alerts and (1, 'scba_expired') not in e.state.alerts and e.state.episodes == {}
