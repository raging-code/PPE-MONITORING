"""P6c: sensor_fault (design 14.1 row; GV-07, GV-15 a to d, GV-19, GV-16b). Condition (ii) needs a heat alert, which P7c builds, so the
heat cases are seeded here and named GV-16a-seeded and GV-16c-seeded; the real GV-16 a and c run in P7c. Boundary times are test values only."""
from dataclasses import replace
import pytest
from test_co_state import CO_FAULT, SHT_FAULT
from test_co_threshold import Eng, TYPE, frame
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import FrameEvent, TickEvent, raise_alert

IMU_FAULT = 1 << 5
SF = 'sensor_fault'

@pytest.fixture(autouse=True)
def _no_shadow(monkeypatch):
    monkeypatch.setattr(re_, 'RULES', tuple(r for r in re_.RULES if r is not re_.shadow_rule))   # P7c-3: 30 s of stillness raises a shadow_notice badge; these tests are about sensor_fault (test_heat_shadow.py covers the estimator)

def sf(e): return e.state.alerts.get((1, SF))
def heat_open(e, stamp=True):
    e.state, _ = raise_alert(e.state, 1, 'heat', 'WARNING', 'seeded', e.clock.now())
    if stamp: e.state = replace(e.state, nodes={**e.state.nodes, 1: replace(e.node, last_heat_alert_mono=e.clock.now().mono_ms)})
def types(fx): return [(type(x).__name__, x.type, getattr(x, 'level', None)) for x in fx]

def test_rule_registered_after_co_threshold_and_stamp_is_unset_in_production():
    assert re_.RULES[:3] == (re_.co_state_rule, re_.co_threshold_rule, re_.sensor_fault_rule)
    e = Eng(); e.run(30, co_x10=520, temp_x100=6500); assert e.node.last_heat_alert_mono is None      # only P7c sets it

# ---- GV-07 ----
def test_GV07_a_b_c():
    e = Eng(); fx = e.step(frame(co_x10=520, status2=CO_FAULT, flags=0x08), 0)                            # (a)
    assert types(fx) == [('RaiseAlert', SF, 'WARNING')] and e.row is None and (e.node.co_validity, e.node.co_reason) == ('UNRELIABLE', 'co_fault')
    fx = e.step(frame(co_x10=520, flags=0x01))                                                             # (b)
    assert types(fx) == [('ClearAlert', SF, None)] and e.row is None and e.node.co_ppm == 52.0 and e.node.level == 'WARNING'
    fx = e.step(frame(co_x10=520, flags=0x01))                                                             # (c)
    assert types(fx) == [('RaiseAlert', TYPE, 'WARNING')]

# ---- GV-15 ----
def test_GV15_a_b_danger_within_window_and_co_alert_held():
    e = Eng(); assert types(e.step(frame(co_x10=400, flags=0x01), 0)) == [('RaiseAlert', TYPE, 'WARNING')]
    fx = e.step(frame(co_x10=400, status2=CO_FAULT, flags=0x0A), 20000)
    assert types(fx) == [('RaiseAlert', SF, 'DANGER')] and e.row.level == 'WARNING' and e.node.level == 'DANGER' and (1, 'node_danger') not in e.state.alerts
    assert e.run(30, co_x10=400, status2=CO_FAULT, flags=0x0A) == [] and sf(e).level == 'DANGER' and e.row.level == 'WARNING'   # held; DANGER never lowered

def test_GV15_c_no_recent_co_gives_warning():
    e = Eng(); e.step(frame(co_x10=100), 0); fx = e.step(frame(co_x10=100, status2=CO_FAULT, flags=0x09), 20000)
    assert types(fx) == [('RaiseAlert', SF, 'WARNING')] and e.node.level == 'WARNING'

def test_GV15_d_window_passed_gives_warning():
    e = Eng(); e.step(frame(co_x10=400, flags=0x01), 0); e.run(35, co_x10=100)                              # 70 s of 10 ppm: the co alert clears on the way
    assert e.row is None
    fx = e.step(frame(co_x10=100, status2=CO_FAULT, flags=0x09)); assert types(fx) == [('RaiseAlert', SF, 'WARNING')]

@pytest.mark.parametrize('gap_ms, level', [(59000, 'DANGER'), (61000, 'WARNING')])
def test_window_boundary_for_co_fault(gap_ms, level):
    e = Eng(); e.step(frame(co_x10=400), 0); e.step(frame(co_x10=400, status2=CO_FAULT), gap_ms); assert sf(e).level == level

def test_scba_on_co_does_not_start_the_window():
    e = Eng(); e.step(frame(co_x10=400, scba=1), 0); e.step(frame(co_x10=400, status2=CO_FAULT, scba=1), 10000); assert sf(e).level == 'WARNING'

@pytest.mark.parametrize('tick_gap_ms, level', [(6000, 'DANGER'), (61000, 'WARNING')])
def test_co_timeout_raises_sensor_fault_on_a_tick(tick_gap_ms, level, monkeypatch):
    monkeypatch.setattr(re_, 'RULES', tuple(r for r in re_.RULES if r is not re_.link_rule))   # P7-2: after 60 s of silence link_lost also opens; this test is about the sensor_fault level
    e = Eng(); e.step(frame(co_x10=400), 0); fx = e.step(TickEvent(), tick_gap_ms)
    assert e.node.co_reason == 'co_timeout' and types(fx) == [('RaiseAlert', SF, level)] and e.state.nodes[1].level == level
    assert e.step(TickEvent()) == [] and sf(e).level == level                                              # one alert, no repeat

def test_co_timeout_then_healthy_frame_clears_it():
    e = Eng(); e.step(frame(co_x10=100), 0); e.step(TickEvent(), 6000); assert sf(e) is not None
    assert types(e.step(frame(co_x10=100))) == [('ClearAlert', SF, None)]

# ---- GV-16 (b real, a and c seeded) ----
def test_GV16b_temp_fault_without_heat_is_warning():
    e = Eng(); e.run(5, temp_x100=2500); fx = e.step(frame(status2=SHT_FAULT, flags=0x09))
    assert types(fx) == [('RaiseAlert', SF, 'WARNING')] and (e.node.co_validity, e.node.co_reason, e.node.level) == ('UNRELIABLE', 'sht40_fault', 'WARNING')

def test_GV16a_seeded_heat_open_gives_danger_and_heat_stays():
    e = Eng(); e.run(61, temp_x100=6500); heat_open(e); fx = e.step(frame(temp_x100=6500, status2=SHT_FAULT, flags=0x0A), 30000)
    assert types(fx) == [('RaiseAlert', SF, 'DANGER')] and (1, 'heat') in e.state.alerts and e.node.level == 'DANGER'
    assert (e.node.co_validity, e.node.co_mode) == ('UNRELIABLE', re_.CO_USABLE_HELD) and (1, 'node_danger') not in e.state.alerts

@pytest.mark.xfail(strict=True, reason='DISCREPANCY, ADR proposed: GV-16a says co_reason is sht40_fault while co_range is also active; P6a co_classify (tested by test_co_range_is_not_judged_while_the_sht40_is_faulted) reports co_range')
def test_GV16a_reason_is_sht40_fault_when_co_range_is_also_active():
    e = Eng(); e.run(61, temp_x100=6500); e.step(frame(temp_x100=6500, status2=SHT_FAULT, flags=0x0A), 30000); assert e.node.co_reason == 'sht40_fault'

def test_GV16c_seeded_heat_open_for_10_min_gives_danger():
    e = Eng(); e.run(5); heat_open(e, stamp=False); e.clock.advance(600000)
    fx = e.step(frame(status2=SHT_FAULT, flags=0x0A), 0); assert types(fx) == [('RaiseAlert', SF, 'DANGER')]

@pytest.mark.parametrize('since_ms, level', [(30000, 'DANGER'), (90000, 'WARNING')])
def test_heat_stamp_window_after_the_alert_closed(since_ms, level):
    e = Eng(); e.run(2); e.state = replace(e.state, nodes={**e.state.nodes, 1: replace(e.node, last_heat_alert_mono=e.clock.now().mono_ms)})
    e.step(frame(status2=SHT_FAULT), since_ms); assert sf(e).level == level

# ---- GV-19 ----
def test_GV19_a_b_c_held_then_clears_and_co_clock_starts_one_frame_later():
    e = Eng(); assert types(e.step(frame(co_x10=520, flags=0x01), 0)) == [('RaiseAlert', TYPE, 'WARNING')]            # (a)
    fx = e.step(frame(co_x10=200, status2=SHT_FAULT, flags=0x09)); assert types(fx) == [('RaiseAlert', SF, 'WARNING')]  # (b): no heat, so no DANGER
    assert e.run(14, co_x10=200, status2=SHT_FAULT, flags=0x09) == [] and e.row.level == 'WARNING' and e.node.co_ppm == 20.0
    fx = e.step(frame(co_x10=200)); assert types(fx) == [('ClearAlert', SF, None)] and e.row is not None                # (c) first healthy frame
    assert e.run(5, co_x10=200) == [] and e.row is not None                                                              # clock starts on the next frame
    fx = e.step(frame(co_x10=200)); assert types(fx) == [('ClearAlert', TYPE, None)]

# ---- escalation, other kinds, suspect frames ----
def test_warning_escalates_in_place_when_a_later_fault_of_another_kind_meets_the_window():
    e = Eng(); e.step(frame(co_x10=400), 0); e.step(frame(co_x10=400, status2=IMU_FAULT), 2000); row = sf(e)
    assert row.level == 'WARNING'; e = replace_ack(e)
    fx = e.step(frame(co_x10=400, status2=IMU_FAULT | CO_FAULT))
    assert types(fx) == [('ChangeAlertLevel', SF, 'DANGER')] and sf(e).event_seq == row.event_seq and sf(e).acknowledged_ts is None and fx[0].acknowledged_reset

def replace_ack(e): e.state = replace(e.state, alerts={**e.state.alerts, (1, SF): replace(sf(e), acknowledged_ts=7)}); return e

def test_same_kind_does_not_escalate_a_warning():
    e = Eng(); e.step(frame(co_x10=400), 0); e.step(frame(co_x10=400, status2=IMU_FAULT), 2000)
    assert e.run(5, co_x10=400, status2=IMU_FAULT) == [] and sf(e).level == 'WARNING'

def test_imu_fault_is_a_warning_and_does_not_stop_co_threshold():
    e = Eng(); fx = e.step(frame(co_x10=2500, status2=IMU_FAULT, flags=0x0A), 0)
    assert types(fx) == [('RaiseAlert', TYPE, 'DANGER'), ('RaiseAlert', SF, 'WARNING')]

def test_clear_needs_all_fault_bits_zero():
    e = Eng(); e.step(frame(status2=IMU_FAULT | SHT_FAULT), 0)
    assert e.run(3, status2=IMU_FAULT) == [] and sf(e) is not None
    assert types(e.step(frame())) == [('ClearAlert', SF, None)] and sf(e) is None

def test_suspect_frame_opens_and_escalates_but_never_clears():
    e = Eng(); e.step(frame(co_x10=400), 0); e.step(FrameEvent(1, 'OK', 'suspect', {**frame(co_x10=400, status2=IMU_FAULT).decoded}), 2000)
    assert sf(e).level == 'WARNING'
    e.step(FrameEvent(1, 'OK', 'suspect', {**frame(co_x10=400, status2=CO_FAULT).decoded}), 2000); assert sf(e).level == 'DANGER'
    assert e.step(FrameEvent(1, 'OK', 'suspect', {**frame(co_x10=400).decoded})) == [] and sf(e).level == 'DANGER' and e.node.fault_kinds == {'imu', 'co'}
    assert types(e.step(frame(co_x10=400))) == [('ClearAlert', SF, None)]

def test_never_shows_zero_ppm_during_a_co_fault():
    e = Eng(); e.step(frame(co_x10=120), 0); e.step(frame(co_x10=0, status2=CO_FAULT)); assert e.node.co_ppm == 12.0

def test_fault_kinds_live_in_the_node_state():
    e = Eng(); e.step(frame(status2=IMU_FAULT), 0); assert e.node.fault_kinds == {'imu'}; assert e.state.nodes[1] == e.node
