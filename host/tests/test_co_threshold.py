"""P6b: co_threshold (design 14.1 row, 14.2 (3), GV-01, GV-09, GV-18 a to g). Uses the frame helper of test_co_state.py.
Frames here carry flags=0 unless a test says otherwise, so NodeState.level comes from the alerts alone."""
import json
from dataclasses import replace
from pathlib import Path
import pytest
from test_co_state import CO_FAULT, SHT_FAULT, WARMUP, Sim, co_frame, vector_event
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import ChangeAlertLevel, ClearAlert, FrameEvent, RaiseAlert, TickEvent, step

ROOT = Path(__file__).resolve().parents[2]
TYPE = 'co_threshold'

def frame(flags=0, **kw):
    ev = co_frame(**kw); d = dict(ev.decoded); d['flags'] = flags
    return FrameEvent(ev.node_id, ev.verify, ev.seq_class, d)

class Eng(Sim):
    def step(self, event, dt_ms=2000):
        self.clock.advance(dt_ms); self.state, fx = step(self.state, event, self.clock.now()); return list(fx)
    def run(self, n, **kw):
        out = []
        for _ in range(n): out += self.step(frame(**kw))
        return out
    @property
    def row(self): return self.state.alerts.get((1, TYPE))
    @property
    def node(self): return self.state.nodes[1]
    def ack(self): self.state = replace(self.state, alerts={**self.state.alerts, (1, TYPE): replace(self.row, acknowledged_ts=self.clock.wall_ms())})

def kinds(fx): return [(type(e).__name__, getattr(e, 'level', None)) for e in fx]
def open_at(level, **kw):
    e = Eng(); e.step(frame(co_x10={'WARNING': 520, 'DANGER': 2500}[level], **kw), 0); assert e.row.level == level; return e

def test_rule_registered_after_co_state():
    assert re_.RULES[:2] == (re_.co_state_rule, re_.co_threshold_rule)

# ---- raise: boundaries, SCBA, usable reading ----
@pytest.mark.parametrize('co_x10,level', [(349, None), (350, 'WARNING'), (1999, 'WARNING'), (2000, 'DANGER'), (4949, 'DANGER'), (4950, 'DANGER'), (5000, 'DANGER'), (5200, 'DANGER')])
def test_thresholds_and_saturation(co_x10, level):
    e = Eng(); fx = e.step(frame(co_x10=co_x10), 0)
    assert (e.row.level if e.row else None) == level and len(fx) == (1 if level else 0)
    if level: assert fx[0].node_id == 1 and fx[0].type == TYPE and fx[0].level == level

def test_over_range_still_raises_and_keeps_p6a_clamp():
    e = Eng(); e.step(frame(co_x10=5200), 0); assert e.row.level == 'DANGER' and e.node.co_over_range and e.node.co_ppm == 500.0

def test_co_sat_flag_gives_danger():
    e = Eng(); e.step(frame(co_x10=300, flags=0x10), 0); assert e.row.level == 'DANGER'

def test_scba_on_raises_nothing():
    e = Eng(); assert e.step(frame(co_x10=2500, scba=1), 0) == [] and e.row is None

def test_warmup_keeps_thresholds_active():
    e = Eng(); e.step(frame(co_x10=520, status3=WARMUP), 0); assert e.node.co_validity == 'DERATED' and e.row.level == 'WARNING'

def test_co_fault_and_timeout_open_nothing():
    e = Eng(); assert e.step(frame(co_x10=2500, status2=CO_FAULT), 0) == [] and e.row is None          # GV-07 a: the fault frame has no reading
    e = Eng(); e.step(frame(co_x10=100), 0); e.step(TickEvent(), 6000); assert e.node.co_reason == 'co_timeout' and e.row is None

def test_one_open_alert_and_levels_follow_it():
    e = Eng(); fx = e.run(20, co_x10=520)
    assert kinds(fx) == [('RaiseAlert', 'WARNING')] and len(e.state.alerts) == 1 and e.node.level == 'WARNING'

# ---- GV-01 ----
def test_GV_01():
    e = Eng(); fx = e.step(vector_event('F-01'), 0)
    assert kinds(fx) == [('RaiseAlert', 'WARNING')] and e.node.level == 'WARNING' and e.node.co_ppm == 52.0 and e.state.episodes == {}

# ---- GV-09 ----
def test_GV_09_a_b_c_acknowledge_lower_keep_ack_then_clear():
    e = Eng(); fx = e.step(frame(co_x10=2500, flags=0x02), 0); assert kinds(fx) == [('RaiseAlert', 'DANGER')] and e.row.acknowledged_ts is None   # (a)
    e.ack(); seq0, ack = e.row.event_seq, e.row.acknowledged_ts; assert ack is not None
    out = []
    for i in range(6): out += e.step(frame(co_x10=1500))                      # (b) first sub-180 frame, then 10 s
    assert kinds(out) == [('ChangeAlertLevel', 'WARNING')]
    ch = out[0]; assert (ch.raised_event_seq, ch.acknowledged_reset, ch.old_level) == (seq0, False, 'DANGER')
    assert e.row.level == 'WARNING' and e.row.event_seq == seq0 and e.row.acknowledged_ts == ack and len(e.state.alerts) == 1   # same alert_id, ack kept, no second card
    out = []
    for i in range(6): out += e.step(frame(co_x10=250))                        # (c) 10 s continuous below 31.5
    assert kinds(out) == [('ClearAlert', None)] and e.row is None and out[0].raised_event_seq == seq0

def test_GV_09_lowering_happens_on_the_frame_10_s_after_the_first_sub_180_frame():
    e = open_at('DANGER'); e.step(frame(co_x10=1500))                           # first sub-180 frame
    for _ in range(4): assert e.step(frame(co_x10=1500)) == []                  # 2, 4, 6, 8 s
    assert kinds(e.step(frame(co_x10=1500))) == [('ChangeAlertLevel', 'WARNING')]   # 10 s

def test_GV_09_separate_run_210_ppm_returns_to_danger_with_ack_null_and_a_new_event_seq():
    e = open_at('DANGER'); e.ack(); e.run(6, co_x10=1500); assert e.row.level == 'WARNING' and e.row.acknowledged_ts is not None
    seq = e.state.event_seq; fx = e.step(frame(co_x10=2100))
    assert kinds(fx) == [('ChangeAlertLevel', 'DANGER')] and fx[0].acknowledged_reset and e.row.acknowledged_ts is None and fx[0].event_seq == seq + 1 and len(e.state.alerts) == 1

def test_escalation_clears_ack_lowering_keeps_it():
    e = open_at('WARNING'); e.ack(); e.step(frame(co_x10=2500)); assert e.row.level == 'DANGER' and e.row.acknowledged_ts is None

def test_timers_restart_when_the_value_rises_above_the_clear_level():
    e = open_at('WARNING'); e.run(4, co_x10=100); e.step(frame(co_x10=320))     # 32.0 ppm is at or above 31.5: the clear timer restarts
    assert e.run(5, co_x10=100) == [] and e.row is not None
    assert kinds(e.step(frame(co_x10=100))) == [('ClearAlert', None)]

def test_both_timers_expired_clears_from_danger():
    e = open_at('DANGER'); out = e.run(6, co_x10=100); assert kinds(out) == [('ClearAlert', None)] and e.row is None

def test_between_the_levels_nothing_changes_for_10_minutes():
    e = open_at('WARNING'); fx = []
    for i in range(300): fx += e.step(frame(co_x10=340 if i % 2 else 360))       # 34 to 36 ppm
    assert [k for k, _ in kinds(fx)] == [] and e.row.level == 'WARNING'
    e = Eng(); fx = []
    for i in range(300): fx += e.step(frame(co_x10=1980 if i % 2 else 2020), 2000 if i else 0)   # 198 to 202 ppm
    assert not any(isinstance(x, ClearAlert) for x in fx) and sum(isinstance(x, RaiseAlert) for x in fx) == 1 and sum(isinstance(x, ChangeAlertLevel) for x in fx) <= 1
    assert e.row.level == 'DANGER'

# ---- GV-18 a to g (alert halves) ----
def test_GV_18_a_raises_warning():
    e = Eng(); fx = e.step(frame(co_x10=520), 0); assert kinds(fx) == [('RaiseAlert', 'WARNING')]

def test_GV_18_b_c_d_held_until_co_range_clears_then_the_10_s_timer_starts_on_the_next_frame():
    e = open_at('WARNING'); assert e.run(15, temp_x100=5600, co_x10=200) == [] and e.row is not None       # (b) 30 s, 20 ppm
    assert e.run(30, co_x10=200) == [] and e.row is not None and e.node.co_range_active                    # (c) 58 s: still held (first inside-margin frame + 29 more)
    assert e.step(frame(co_x10=200)) == [] and not e.node.co_range_active and e.node.co_hold_ended          # (d) the frame that clears co_range: no clear
    for _ in range(5): assert e.step(frame(co_x10=200)) == []                                               # timer starts on the next frame
    assert kinds(e.step(frame(co_x10=200))) == [('ClearAlert', None)]                                       # 10 s after it

def test_GV_18_e_f23_escalates_in_place_although_co_range_is_active():
    e = open_at('WARNING'); e.run(3, temp_x100=5600, co_x10=200); e.ack(); seq = e.row.event_seq
    fx = e.step(vector_event('F-23'))
    assert kinds(fx) == [('ChangeAlertLevel', 'DANGER')] and e.row.event_seq == seq and e.row.acknowledged_ts is None and e.node.co_range_active

def test_GV_18_f_the_60_s_count_restarts_and_the_alert_clears_10_s_after_co_range():
    e = open_at('WARNING'); e.run(2, temp_x100=5600, co_x10=200); e.run(21, co_x10=200)                     # 40 s inside the margins
    e.step(frame(temp_x100=5200, co_x10=200)); assert e.node.co_range_active and e.row is not None          # 52 C: restart
    for _ in range(30): assert e.step(frame(co_x10=200)) == [] and e.node.co_range_active                  # 25 C again: 30 frames, 58 s after the first
    assert e.step(frame(co_x10=200)) == [] and not e.node.co_range_active                                  # 60 s after temperature returned
    for _ in range(5): assert e.step(frame(co_x10=200)) == []
    assert kinds(e.step(frame(co_x10=200))) == [('ClearAlert', None)]

def test_GV_18_g_raises_danger_during_co_range_with_no_alert_then_is_held():
    e = Eng(); fx = e.step(frame(co_x10=2500, temp_x100=5600, flags=0x02), 0)
    assert kinds(fx) == [('RaiseAlert', 'DANGER')] and e.node.co_validity == 'UNRELIABLE' and e.node.co_reason == 'co_range' and e.node.co_ppm == 250.0 and e.node.level == 'DANGER'
    assert e.run(60, temp_x100=5600, co_x10=200) == [] and e.row.level == 'DANGER'                         # 2 min of 20 ppm: not lowered, not cleared
    assert e.run(31, co_x10=200) == [] and e.row is not None                                                # co_range clears on the 31st frame; still no clear on it
    out = e.run(6, co_x10=200); assert kinds(out) == [('ClearAlert', None)]

def test_F_15_raises_nothing_and_F_23_raises_danger_with_no_alert_open():
    e = Eng(); assert e.step(vector_event('F-15'), 0) == [] and e.row is None
    e = Eng(); assert kinds(e.step(vector_event('F-23'), 0)) == [('RaiseAlert', 'DANGER')] and e.node.co_reason == 'co_range'

# ---- hold rule ----
def test_sht40_fault_holds_and_a_high_reading_still_opens():
    e = open_at('WARNING'); assert e.run(30, status2=SHT_FAULT, co_x10=100) == [] and e.row is not None and e.node.co_reason == 'sht40_fault'
    e = Eng(); assert kinds(e.step(frame(co_x10=520, status2=SHT_FAULT), 0)) == [('RaiseAlert', 'WARNING')]

def test_running_timer_is_reset_when_a_hold_starts_and_held_time_does_not_count():
    # 4 s of a running clear timer, then a hold: the timer is reset and the held time does not count
    e = open_at('WARNING'); e.run(4, co_x10=100); e.run(3, status2=SHT_FAULT, co_x10=100)
    assert e.step(frame(co_x10=100)) == [] and e.node.co_hold_ended                # hold ends: not on this frame
    for _ in range(5): assert e.step(frame(co_x10=100)) == []                      # 4 s before the hold plus held time must not count
    assert kinds(e.step(frame(co_x10=100))) == [('ClearAlert', None)]

def test_co_fault_holds_an_open_alert_and_it_clears_10_s_after_valid_readings_resume():
    e = open_at('DANGER'); assert e.run(20, status2=CO_FAULT, co_x10=0) == [] and e.row.level == 'DANGER'
    assert e.step(frame(co_x10=100)) == [] and e.node.co_hold_ended
    for _ in range(5): assert e.step(frame(co_x10=100)) == []
    assert kinds(e.step(frame(co_x10=100))) == [('ClearAlert', None)]

def test_co_timeout_holds_an_open_alert():
    e = open_at('WARNING'); e.step(TickEvent(), 6000); assert e.node.co_reason == 'co_timeout' and e.row is not None
    assert e.step(frame(co_x10=100)) == [] and e.row is not None

def test_scba_on_suppresses_without_clearing():
    e = open_at('WARNING'); assert e.run(30, scba=1, co_x10=100) == [] and e.row is not None      # 60 s low with SCBA ON: not cleared
    assert e.run(5, co_x10=100) == [] and kinds(e.step(frame(co_x10=100))) == [('ClearAlert', None)]   # timers start with SCBA OFF again

# ---- suspect frames ----
def test_suspect_frame_never_lowers_clears_or_moves_a_timer():
    e = open_at('DANGER'); assert [e.step(frame(co_x10=0, seq_class='suspect')) for _ in range(10)] == [[]] * 10 and e.row.level == 'DANGER'
    assert (e.node.co_clear_since_mono, e.node.co_lower_since_mono) == (None, None)
    e.step(frame(co_x10=100)); since = e.node.co_clear_since_mono
    e.step(frame(co_x10=0, seq_class='suspect')); assert e.node.co_clear_since_mono == since

def test_suspect_frame_raises_and_escalates_and_only_raises_the_level():
    e = Eng(); assert kinds(e.step(frame(co_x10=520, seq_class='suspect'), 0)) == [('RaiseAlert', 'WARNING')]
    assert kinds(e.step(frame(co_x10=2500, seq_class='suspect'))) == [('ChangeAlertLevel', 'DANGER')] and e.node.level == 'DANGER'
    e.step(frame(co_x10=0, seq_class='suspect')); assert e.node.level == 'DANGER' and e.row.level == 'DANGER'
    assert Eng().step(frame(co_x10=2500, status2=CO_FAULT, seq_class='suspect'), 0) == []

# ---- levels, co_rising, purity ----
def test_node_level_drops_when_the_alert_clears():
    e = open_at('DANGER'); assert e.node.level == 'DANGER'; e.run(7, co_x10=100); assert e.row is None and e.node.level == 'NORMAL'

def test_co_rising_is_disabled_and_never_raised():
    assert re_.CO_RISING_ENABLED is False and json.loads((ROOT / 'host' / 'config' / 'settings.json').read_text(encoding='utf8'))['co_rising_enabled'] is False
    e = Eng(); fx = e.run(50, co_x10=100) + e.run(50, co_x10=3000) + e.run(50, co_x10=100)     # a steep rise and fall
    assert not any(getattr(x, 'type', None) == 'co_rising' for x in fx)

def test_event_seq_strictly_increases_and_replay_is_deterministic():
    def run():
        e = Eng(); fx = e.step(frame(co_x10=520), 0) + e.run(2, co_x10=2500) + e.run(6, co_x10=1500) + e.run(7, co_x10=100); return fx, e.state
    (a, sa), (b, sb) = run(), run(); assert a == b and sa == sb
    seqs = [x.event_seq for x in a]; assert seqs == sorted(set(seqs)) and seqs == list(range(1, len(seqs) + 1))
