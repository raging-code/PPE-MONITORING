"""P7c-3: heat (design 14.1 row, 14.2 (4), Summary D5 test values) and the shadow estimator with shadow_notice (14.1b, 14.2 (5)): GV-16 a to c, GV-25.
Frames come from co_frame; temperature, motion, flags and status bytes are set per test. Frames are 2 s apart unless a test says otherwise."""
import pytest
from test_co_state import co_frame
from test_co_threshold import Eng
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import AckAlertEvent, FrameEvent, ResolveEpisodeEvent, TickEvent

TF, IMU = 0x40, 0x20                      # status2 bit 6 (temperature fault), bit 5 (IMU fault)
def hf(temp=2500, flags=0, status2=0, motion=20, seq_class='fresh', node=1):
    d = dict(co_frame(co_x10=0, temp_x100=temp, status2=status2, node=node).decoded); d.update(flags=flags, motion_x100=motion)
    return FrameEvent(node, 'OK', seq_class, d)
def al(e, t, n=1): return e.state.alerts.get((n, t))
def kinds(fx): return [(type(x).__name__, getattr(x, 'type', None), getattr(x, 'level', None)) for x in fx]
def heat(fx): return [k for k in kinds(fx) if k[1] == 'heat']
def feed(e, temp, secs, step=2, **kw):
    """Send frames at a fixed spacing for 'secs' seconds (first frame after one step); returns all effects."""
    out = []
    for _ in range(secs // step): out += e.step(hf(temp, **kw), step * 1000)
    return out
def motionless(e, secs, **kw): return feed(e, 2500, secs, **kw)

def test_rule_order_heat_and_shadow_run_before_link_rule_and_node_danger_stays_last():
    r = re_.RULES; assert r.index(re_.battery_low_rule) < r.index(re_.heat_rule) < r.index(re_.shadow_rule) < r.index(re_.link_rule) and r[-1] is re_.node_danger_rule

# ---- heat: Summary D5 test values ----
def test_60C_for_119_s_raises_nothing_and_for_121_s_raises_heat_warning():
    e = Eng(); e.step(hf(6000), 0); assert feed(e, 6000, 118) == [] and e.step(hf(6000), 1000) == [] and al(e, 'heat') is None            # 119 s
    fx = e.step(hf(6000), 2000); assert heat(fx) == [('RaiseAlert', 'heat', 'WARNING')] and e.state.nodes[1].level == 'WARNING' and e.state.episodes == {}   # 121 s

def test_a_reading_below_60C_restarts_the_120_s_run():
    e = Eng(); e.step(hf(6000), 0); feed(e, 6000, 100); e.step(hf(5999), 2000); e.step(hf(6000), 2000)
    assert feed(e, 6000, 116) == [] and al(e, 'heat') is None and heat(feed(e, 6000, 4)) == [('RaiseAlert', 'heat', 'WARNING')]

def ramp(e, secs, rise_c, start=2500, step=5):
    n = secs // step; out = []
    e.step(hf(start), 0)
    for i in range(1, n + 1): out += e.step(hf(start + round(i * rise_c * 100 / n)), step * 1000)
    return out

def test_a_20C_rise_in_25_s_raises_heat_and_in_35_s_does_not():
    e = Eng(); assert heat(ramp(e, 25, 20)) == [('RaiseAlert', 'heat', 'WARNING')] and 'rise' in al(e, 'heat').reasons
    e = Eng(); assert ramp(e, 35, 20) == [] and al(e, 'heat') is None

def test_a_rise_row_clears_10_s_after_the_30_s_rise_drops_under_15_C_and_temp_is_under_55_C():
    e = Eng(); ramp(e, 25, 20); assert al(e, 'heat') is not None; since = None; cleared_at = None
    for _ in range(60):
        e.step(hf(4500), 2000); n = e.state.nodes[1]
        if since is None and n.heat_clear_since_mono is not None: since = n.heat_clear_since_mono
        if al(e, 'heat') is None: cleared_at = e.clock.mono_ms(); break
    assert since is not None and cleared_at - since == 10000

def test_a_time_row_clears_after_10_s_below_55C_and_holds_between_55_and_60():
    e = Eng(); e.step(hf(6000), 0); feed(e, 6000, 122); assert al(e, 'heat') is not None
    feed(e, 5700, 30); assert al(e, 'heat') is not None and e.state.nodes[1].heat_clear_since_mono is None
    e.step(hf(5400), 2000); e.step(hf(5400), 7000); assert al(e, 'heat') is not None            # 7 s of the 10 s
    assert heat(e.step(hf(5400), 2999)) == [] and heat(e.step(hf(5400), 1)) == [('ClearAlert', 'heat', None)]

def test_100C_for_9_s_raises_nothing_and_for_11_s_raises_heat_warning_never_danger():
    e = Eng(); e.step(hf(10000), 0); assert feed(e, 10000, 8) == [] and e.step(hf(10000), 1000) == [] and al(e, 'heat') is None
    fx = e.step(hf(10000), 2000); assert heat(fx) == [('RaiseAlert', 'heat', 'WARNING')] and 'extreme' in al(e, 'heat').reasons
    feed(e, 10000, 300); assert al(e, 'heat').level == 'WARNING' and not any(isinstance(x, re_.ChangeAlertLevel) for x in feed(e, 10000, 20))

def test_an_extreme_row_clears_below_95C_after_10_s():
    e = Eng(); e.step(hf(10000), 0); feed(e, 10000, 12); feed(e, 9600, 20); assert al(e, 'heat') is not None
    assert heat(feed(e, 9400, 10)) == [] and heat(e.step(hf(9400), 2000)) == [('ClearAlert', 'heat', None)]

def test_a_temperature_fault_freezes_heat_holds_an_open_row_and_restarts_the_timers():
    e = Eng(); e.step(hf(6000), 0); feed(e, 6000, 122); seq = al(e, 'heat').event_seq
    assert heat(feed(e, 2000, 60, status2=TF)) == [] and al(e, 'heat').event_seq == seq        # held although the (faulted) reading is 20 C
    assert e.state.nodes[1].heat_clear_since_mono is None
    e.step(hf(2000), 2000); assert al(e, 'heat') is not None and e.state.nodes[1].heat_clear_since_mono is None   # the first frame after the fault is not evaluated
    e.step(hf(2000), 2000); assert e.state.nodes[1].heat_clear_since_mono is not None

def test_no_heat_row_is_raised_while_the_temperature_sensor_is_faulted_and_a_run_restarts_after_it():
    e = Eng(); e.step(hf(6500, status2=TF), 0); assert not [k for k in kinds(feed(e, 6500, 300, status2=TF)) if k[1] == 'heat']
    e.step(hf(6500), 2000)                                                                           # skipped frame
    e.step(hf(6500), 2000); assert feed(e, 6500, 116) == [] and heat(feed(e, 6500, 6)) == [('RaiseAlert', 'heat', 'WARNING')]

def test_a_suspect_frame_never_starts_or_advances_a_heat_timer():
    e = Eng(); e.step(hf(6000, seq_class='suspect'), 0)
    for _ in range(80): e.step(hf(6000, seq_class='suspect'))
    assert al(e, 'heat') is None and e.state.nodes[1].heat_hot_since_mono is None
    e.step(hf(6000), 0); feed(e, 6000, 100); assert e.step(hf(6000, seq_class='suspect'), 60000) == [] and al(e, 'heat') is None

def test_acknowledge_never_closes_a_heat_row_and_last_heat_alert_mono_follows_the_open_row():
    e = Eng(); e.step(hf(6000), 0); feed(e, 6000, 122); fx = e.step(AckAlertEvent(1, 'heat', 7), 0); assert [type(x).__name__ for x in fx] == ['AlertAcknowledged'] and al(e, 'heat') is not None
    e.step(hf(6000), 2000); assert e.state.nodes[1].last_heat_alert_mono == e.clock.mono_ms()

# ---- GV-16: sensor_fault condition (ii) is now live (the real heat rule sets the row and the stamp) ----
def test_GV16a_a_temp_fault_30_s_after_heat_opened_raises_sensor_fault_at_danger_and_the_heat_row_stays_open():
    e = Eng(); e.step(hf(6500, flags=0x01), 0); feed(e, 6500, 122, flags=0x01); assert al(e, 'heat') is not None; feed(e, 6500, 30, flags=0x01)
    fx = e.step(hf(6500, flags=0x0A, status2=TF), 2000); sf = al(e, 'sensor_fault')
    assert sf is not None and sf.level == 'DANGER' and 'heat' in sf.reasons and al(e, 'heat') is not None and al(e, 'node_danger') is None
    assert e.state.nodes[1].co_validity == 'UNRELIABLE' and e.state.nodes[1].level == 'DANGER' and e.state.episodes == {}

def test_GV16b_a_temp_fault_without_heat_is_a_warning_sensor_fault():
    e = Eng(); feed(e, 2500, 20); e.step(hf(2500, flags=0x09, status2=TF), 2000)
    assert al(e, 'sensor_fault').level == 'WARNING' and al(e, 'heat') is None and e.state.nodes[1].co_validity == 'UNRELIABLE'

def test_GV16c_a_heat_row_open_for_10_minutes_then_a_temp_fault_is_a_danger_sensor_fault():
    e = Eng(); e.step(hf(6500), 0); feed(e, 6500, 122); feed(e, 6500, 600); e.step(hf(6500, flags=0x0A, status2=TF), 2000)
    assert al(e, 'sensor_fault').level == 'DANGER' and al(e, 'heat') is not None

def test_a_temp_fault_within_60_s_after_the_heat_row_cleared_is_danger_and_after_61_s_warning():
    for gap, lvl in ((58, 'DANGER'), (62, 'WARNING')):
        e = Eng(); e.step(hf(6000), 0); feed(e, 6000, 122); feed(e, 5000, 12); assert al(e, 'heat') is None
        feed(e, 5000, gap); e.step(hf(5000, status2=TF), 2000); assert al(e, 'sensor_fault').level == lvl, gap

# ---- shadow estimator and shadow_notice (GV-25) ----
def test_GV25_still_for_30_s_with_mandown_0_raises_shadow_notice_and_motion_clears_it():
    e = Eng(); e.step(hf(motion=0), 0); assert motionless(e, 28, motion=0) == [] and al(e, 'shadow_notice') is None      # 28 s of stillness
    fx = e.step(hf(motion=0), 2000); assert kinds(fx) == [('RaiseAlert', 'shadow_notice', 'NONE')] and e.state.nodes[1].level == 'NORMAL' and e.state.episodes == {}    # 30 s
    assert e.step(hf(motion=0), 2000) == []                                                          # held: no second row
    fx = e.step(hf(motion=6), 2000); assert kinds(fx) == [('ClearAlert', 'shadow_notice', None)] and fx[0].reason == 'motion' and e.state.episodes == {}

def test_motion_equal_to_still_g_is_still_and_a_single_moving_frame_restarts_the_run():
    e = Eng(); e.step(hf(motion=5), 0); motionless(e, 28, motion=5); e.step(hf(motion=6), 2000); assert e.state.nodes[1].shadow_still_since_mono is None
    e.step(hf(motion=5), 2000); assert al(e, 'shadow_notice') is None and motionless(e, 28, motion=5) == [] and al(e, 'shadow_notice') is None
    assert kinds(e.step(hf(motion=5), 2000)) == [('RaiseAlert', 'shadow_notice', 'NONE')]

def test_mandown_clears_the_notice_and_is_never_raised_while_mandown_is_1():
    e = Eng(); e.step(hf(motion=0), 0); motionless(e, 30, motion=0); assert al(e, 'shadow_notice') is not None
    fx = e.step(hf(flags=0x06, motion=0), 2000); assert ('ClearAlert', 'shadow_notice', None) in kinds(fx) and fx[[k[1] for k in kinds(fx)].index('shadow_notice')].reason == 'mandown'
    assert al(e, 'shadow_notice') is None and not [k for k in kinds(feed(e, 2500, 60, flags=0x06, motion=0)) if k[1] == 'shadow_notice']

def test_a_notice_can_coexist_with_an_open_episode_and_resolve_clears_it_and_restarts_the_run():
    e = Eng(); e.step(hf(flags=0x06, motion=0), 0); feed(e, 2500, 6, flags=0x06, motion=0); feed(e, 2500, 40, flags=0, motion=0)      # latch cleared on the jacket, episode stays open
    assert len(e.state.episodes) == 1 and al(e, 'shadow_notice') is not None
    fx = e.step(ResolveEpisodeEvent(1, 'rescued', 7), 0); assert ('ClearAlert', 'shadow_notice', None) in kinds(fx) and fx[[k[1] for k in kinds(fx)].index('shadow_notice')].reason == 'resolved'
    assert e.state.nodes[1].shadow_still_since_mono is None and kinds(e.step(hf(motion=0), 2000)) == [] and al(e, 'shadow_notice') is None
    assert not [k for k in kinds(motionless(e, 28, motion=0)) if k[1] == 'shadow_notice'] and kinds(e.step(hf(motion=0), 2000)) == [('RaiseAlert', 'shadow_notice', 'NONE')]

def test_an_imu_fault_disables_the_estimator_and_raises_the_notice_until_it_ends():
    e = Eng(); fx = e.step(hf(status2=IMU, motion=0), 0); assert kinds(fx)[-1] == ('RaiseAlert', 'shadow_notice', 'NONE') or ('RaiseAlert', 'shadow_notice', 'NONE') in kinds(fx)
    assert 'imu_fault' in al(e, 'shadow_notice').reasons and e.state.nodes[1].shadow_still_since_mono is None
    feed(e, 2500, 60, status2=IMU, motion=6); assert al(e, 'shadow_notice') is not None                   # motion is not trusted while the IMU is faulted
    fx = e.step(hf(motion=0), 2000); assert fx and [x for x in fx if getattr(x, 'type', None) == 'shadow_notice'][0].reason == 'imu_fault_ended'

def test_suspect_frames_never_start_move_or_clear_the_run():
    e = Eng(); e.step(hf(motion=0, seq_class='suspect'), 0)
    for _ in range(25): e.step(hf(motion=0, seq_class='suspect'))
    assert al(e, 'shadow_notice') is None and e.state.nodes[1].shadow_still_since_mono is None
    e.step(hf(motion=0), 0); motionless(e, 30, motion=0); assert al(e, 'shadow_notice') is not None
    assert e.step(hf(motion=50, seq_class='suspect'), 2000) == [] and al(e, 'shadow_notice') is not None

def test_after_a_link_recovery_the_run_restarts_only_after_3_more_fresh_frames():
    e = Eng(); e.step(hf(motion=0), 0); motionless(e, 20, motion=0); assert e.state.nodes[1].shadow_still_since_mono is not None
    e.step(TickEvent(), 20000); assert al(e, 'signal_lost') is not None
    e.step(hf(motion=0), 0)                                                                         # the recovery frame: not tracked
    assert e.state.nodes[1].shadow_still_since_mono is None and e.state.nodes[1].shadow_rebaseline_left == 3 and al(e, 'signal_lost') is None
    for left in (2, 1, 0): e.step(hf(motion=0), 2000); assert e.state.nodes[1].shadow_rebaseline_left == left and e.state.nodes[1].shadow_still_since_mono is None
    e.step(hf(motion=0), 2000); assert e.state.nodes[1].shadow_still_since_mono == e.clock.mono_ms()
    assert motionless(e, 28, motion=0) == [] and kinds(e.step(hf(motion=0), 2000)) == [('RaiseAlert', 'shadow_notice', 'NONE')]

def test_a_long_gap_without_a_tick_also_counts_as_a_recovery():
    e = Eng(); e.step(hf(motion=0), 0); motionless(e, 20, motion=0); e.step(hf(motion=0), 16000); assert e.state.nodes[1].shadow_rebaseline_left == 3

def test_shadow_notice_is_per_node_and_changes_no_level():
    e = Eng(); e.step(hf(motion=0, node=2), 0); feed(e, 2500, 32, motion=0, node=2)
    assert (2, 'shadow_notice') in e.state.alerts and (1, 'shadow_notice') not in e.state.alerts and e.state.nodes[2].level == 'NORMAL' and e.state.episodes == {}
