"""P7-1: man_down and mayday alerts, node_danger (design 14.1; GV-02, GV-03, GV-17 alert halves, GV-20 a). The episode half of GV-02 and GV-03
(OPEN, EPISODE_ESCALATED, Resolve) is P7c. Frames carry flags and status4 as given; boundary counts here are test values only."""
from dataclasses import replace
import pytest
from test_co_state import co_frame, vector_event
from test_co_threshold import Eng
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import FrameEvent, clear_alert, raise_alert

MD, WARN, DNG, MAYDAY = 0x04, 0x01, 0x02, 0x10

def mk(flags=0, status4=0, seq_class='fresh', **kw):
    d = dict(co_frame(**kw).decoded); d.update(flags=flags, status4=status4)
    return FrameEvent(1, 'OK', seq_class, d)
def tys(fx): return [(type(x).__name__, x.type, getattr(x, 'level', None)) for x in fx if hasattr(x, 'type')]   # P7c-1: alert effects only; the episode effects are checked in test_episodes.py
def al(e, t): return e.state.alerts.get((1, t))
def lvl(e): return e.state.nodes[1].level

def test_order_node_danger_is_last_and_man_down_before_it():
    assert re_.RULES[-1] is re_.node_danger_rule and re_.RULES[-2] is re_.man_down_rule

# ---- man_down and mayday ----
def test_GV02_man_down_latch_raises_man_down_danger():
    e = Eng(); fx = e.step(vector_event('F-02'), 0)
    assert tys(fx) == [('RaiseAlert', 'man_down', 'DANGER')] and lvl(e) == 'DANGER' and al(e, 'node_danger') is None and len(e.state.episodes) == 1   # P7c-1: the latch now opens the episode (details in test_episodes.py)

def test_GV03_mayday_on_top_of_an_open_man_down_raises_only_mayday():
    e = Eng(); e.step(mk(flags=DNG | MD), 0)
    assert tys(e.step(mk(flags=DNG | MD, status4=MAYDAY))) == [('RaiseAlert', 'mayday', 'DANGER')] and {t for _, t in e.state.alerts} == {'man_down', 'mayday'}

def test_mayday_first_seen_in_one_frame_with_mandown_raises_both():
    e = Eng(); assert tys(e.step(vector_event('F-03'), 0)) == [('RaiseAlert', 'man_down', 'DANGER'), ('RaiseAlert', 'mayday', 'DANGER')]

def test_mayday_alone_raises_mayday_and_no_node_danger():
    e = Eng(); assert tys(e.step(mk(flags=DNG, status4=MAYDAY), 0)) == [('RaiseAlert', 'mayday', 'DANGER')]
    assert e.run(3) is not None and al(e, 'node_danger') is None

def test_rising_edge_only_a_latch_that_stays_set_adds_nothing():
    e = Eng(); e.step(mk(flags=DNG | MD), 0)
    for _ in range(10): assert e.step(mk(flags=DNG | MD)) == []
    assert len(e.state.alerts) == 1

def test_GV20_a_after_resolve_a_latch_still_set_raises_nothing_then_a_new_edge_does():
    e = Eng(); e.step(mk(flags=DNG | MD), 0)
    e.state, _ = clear_alert(e.state, 1, 'man_down', e.clock.now(), 'resolved')                 # stands in for the P7c Resolve
    for _ in range(3): assert e.step(mk(flags=DNG | MD)) == []                                   # no new alert, no node_danger
    assert e.state.alerts == {}
    assert e.step(mk(flags=0)) == [] and lvl(e) == 'NORMAL'                                      # jacket CANCEL
    assert tys(e.step(mk(flags=DNG | MD))) == [('RaiseAlert', 'man_down', 'DANGER')]             # a new 0->1 edge

def test_man_down_never_clears_on_its_own():
    e = Eng(); e.step(mk(flags=DNG | MD), 0); e.step(mk(flags=0)); e.step(mk(flags=0)); assert al(e, 'man_down') is not None

def test_suspect_frame_raises_but_does_not_move_the_baseline_or_clear():
    e = Eng(); fx = e.step(mk(flags=DNG | MD, status4=MAYDAY, seq_class='suspect'), 0)
    assert tys(fx) == [('RaiseAlert', 'man_down', 'DANGER'), ('RaiseAlert', 'mayday', 'DANGER')] and e.state.nodes[1].mandown_prev is None and lvl(e) == 'DANGER'
    assert e.step(mk(flags=0, seq_class='suspect')) == [] and len(e.state.alerts) == 2 and lvl(e) == 'DANGER'

def test_baseline_follows_fresh_frames():
    e = Eng(); e.step(mk(flags=0), 0); assert (e.state.nodes[1].mandown_prev, e.state.nodes[1].mayday_prev) == (False, False)
    e.step(mk(flags=DNG | MD, status4=MAYDAY)); assert (e.state.nodes[1].mandown_prev, e.state.nodes[1].mayday_prev) == (True, True)

# ---- node_danger ----
def test_GV17_a_second_consecutive_frame_raises_and_the_next_normal_frame_clears():
    e = Eng(); assert e.step(mk(flags=DNG), 0) == [] and lvl(e) == 'DANGER' and al(e, 'node_danger') is None
    fx = e.step(mk(flags=DNG)); assert tys(fx) == [('RaiseAlert', 'node_danger', 'DANGER')] and 'flags=0x02' in al(e, 'node_danger').reasons
    assert tys(e.step(mk(flags=0))) == [('ClearAlert', 'node_danger', None)] and lvl(e) == 'NORMAL'

def test_GV17_d_a_normal_frame_resets_the_streak():
    e = Eng(); e.step(mk(flags=DNG), 0); e.step(mk(flags=0)); assert e.step(mk(flags=DNG)) == [] and al(e, 'node_danger') is None

def test_GV17_c_an_open_danger_alert_means_no_node_danger():
    e = Eng(); e.step(mk(flags=DNG, co_x10=2500), 0)
    for _ in range(4): assert e.step(mk(flags=DNG, co_x10=2500)) == []
    assert al(e, 'node_danger') is None and al(e, 'co_threshold').level == 'DANGER'

@pytest.mark.parametrize('typ', ['link_lost', 'scba_expired', 'mayday', 'man_down'])
def test_any_open_danger_row_blocks_it_but_a_warning_row_does_not(typ, monkeypatch):
    monkeypatch.setattr(re_, 'RULES', tuple(r for r in re_.RULES if r is not re_.link_rule))   # P7-2: a fresh frame clears a seeded link_lost; this test is about node_danger alone
    e = Eng(); e.state, _ = raise_alert(e.state, 1, typ, 'DANGER', 's', e.clock.now())
    e.step(mk(flags=DNG), 0); assert e.step(mk(flags=DNG)) == []
    e = Eng(); e.state, _ = raise_alert(e.state, 1, 'heat', 'WARNING', 's', e.clock.now())
    e.step(mk(flags=DNG), 0); assert tys(e.step(mk(flags=DNG))) == [('RaiseAlert', 'node_danger', 'DANGER')]

def test_suspect_frame_that_meets_it_counts_and_one_that_does_not_leaves_the_streak():
    e = Eng(); e.step(mk(flags=DNG), 0); assert e.step(mk(flags=0, seq_class='suspect')) == [] and e.state.nodes[1].node_danger_streak == 1
    assert tys(e.step(mk(flags=DNG, seq_class='suspect'))) == [('RaiseAlert', 'node_danger', 'DANGER')]

def test_suspect_frame_never_clears_node_danger():
    e = Eng(); e.step(mk(flags=DNG), 0); e.step(mk(flags=DNG)); assert e.step(mk(flags=0, seq_class='suspect')) == [] and al(e, 'node_danger') is not None

def test_node_level_3_frames_are_not_evaluated_at_all():
    e = Eng(); e.step(mk(flags=DNG), 0); assert e.step(mk(flags=0x03)) == [] and e.state.nodes[1].node_danger_streak == 1
    assert tys(e.step(mk(flags=DNG))) == [('RaiseAlert', 'node_danger', 'DANGER')]

def test_a_frame_with_mandown_never_raises_it_and_clears_it():
    e = Eng()
    for _ in range(5): e.step(mk(flags=DNG | MD), 2000)
    assert al(e, 'node_danger') is None
    e = Eng(); e.step(mk(flags=DNG), 0); e.step(mk(flags=DNG))
    fx = e.step(mk(flags=DNG | MD)); assert tys(fx) == [('RaiseAlert', 'man_down', 'DANGER'), ('ClearAlert', 'node_danger', None)] and fx[2].reason == 'mandown'   # fx[0] is the EpisodeOpened of P7c-1
    assert al(e, 'node_danger') is None and al(e, 'man_down') is not None

def test_it_clears_when_another_alert_reaches_danger_superseded():
    e = Eng(); e.step(mk(flags=DNG), 0); e.step(mk(flags=DNG))
    fx = e.step(mk(flags=DNG, co_x10=2500)); assert tys(fx) == [('RaiseAlert', 'co_threshold', 'DANGER'), ('ClearAlert', 'node_danger', None)] and lvl(e) == 'DANGER'
    assert fx[1].reason == 'superseded'

def test_it_clears_when_the_node_level_is_no_longer_danger():
    e = Eng(); e.step(mk(flags=DNG), 0); e.step(mk(flags=DNG)); fx = e.step(mk(flags=WARN))
    assert tys(fx) == [('ClearAlert', 'node_danger', None)] and fx[0].reason == 'node_level_not_danger' and lvl(e) == 'WARNING'

def test_acknowledged_node_danger_stays_open_while_the_node_reports_danger():
    e = Eng(); e.step(mk(flags=DNG), 0); e.step(mk(flags=DNG))
    e.state = replace(e.state, alerts={**e.state.alerts, (1, 'node_danger'): replace(al(e, 'node_danger'), acknowledged_ts=9)})
    for _ in range(5): assert e.step(mk(flags=DNG)) == []
    assert al(e, 'node_danger').acknowledged_ts == 9
