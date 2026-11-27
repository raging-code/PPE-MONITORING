"""P7c-1: episode lifecycle (design 14.1 man_down / mayday rows, 2.3 episodes, 3.3 cards): GV-02 and GV-03 episode halves, GV-10 Acknowledge, GV-20,
the MAN_DOWN label rule (5 s and 15 s), Acknowledge and Resolve. Frames are built from F-01; operator actions go through step() as events. Requirements: REQ-RUL-002, REQ-RUL-003, REQ-RUL-006."""
import pytest
from test_co_state import co_frame
from test_co_threshold import Eng
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import (AckAlertEvent, AckEpisodeEvent, EngineState, EpisodeAcknowledged, EpisodeEscalated, EpisodeLabelChanged, EpisodeOpened,
                                       EpisodeResolved, AlertAcknowledged, FrameEvent, ResolveEpisodeEvent, TickEvent, raise_alert)

MD, MAYDAY = 0x06, 0x10
def mf(flags=0, status4=0, motion=0, seq_class='fresh', node=1):
    d = dict(co_frame(co_x10=0, node=node).decoded); d.update(flags=flags, status4=status4, motion_x100=motion, id_mode=0x40 | node)
    return FrameEvent(node, 'OK', seq_class, d)
def nm(fx): return [(type(x).__name__, getattr(x, 'type', None) or getattr(x, 'kind', None) or getattr(x, 'motion_state', None)) for x in fx]
def ep(e, n=1): return e.state.episodes.get(n)
def al(e, t, n=1): return e.state.alerts.get((n, t))
def resolve(e, reason='rescued', n=1): return e.step(ResolveEpisodeEvent(n, reason, 7), 0)

# ---- opening and upgrading (GV-02, GV-03) ----
def test_GV02_man_down_opens_one_episode_before_the_alert_row_and_adds_nothing_while_the_latch_stays_set():
    e = Eng(); fx = e.step(mf(MD, motion=1), 0)
    assert nm(fx) == [('EpisodeOpened', 'MAN_DOWN'), ('RaiseAlert', 'man_down')] and ep(e).state == 'OPEN' and ep(e).kind == 'MAN_DOWN' and al(e, 'man_down').level == 'DANGER' and e.state.nodes[1].level == 'DANGER'
    assert fx[0].event_seq < fx[1].event_seq and len(e.state.episodes) == 1
    assert sum(len(e.step(mf(MD))) for _ in range(5)) == 0 and len(e.state.episodes) == 1 and not al(e, 'node_danger')

def test_GV03_mayday_upgrades_the_open_episode_in_place_and_logs_the_escalation():
    e = Eng(); e.step(mf(MD), 0); first = ep(e).opened_event_seq; fx = e.step(mf(MD, MAYDAY))
    assert nm(fx) == [('EpisodeEscalated', 'MAYDAY'), ('RaiseAlert', 'mayday')] and (fx[0].old_kind, fx[0].kind) == ('MAN_DOWN', 'MAYDAY')
    assert len(e.state.episodes) == 1 and ep(e).kind == 'MAYDAY' and ep(e).opened_event_seq == first and ep(e).motion_state is None
    assert e.step(mf(MD, MAYDAY)) == []                                          # held: no second upgrade

def test_first_seen_mandown_and_first_seen_mayday_open_exactly_one_episode():
    e = Eng(); assert nm(e.step(mf(MD, MAYDAY), 0)) == [('EpisodeOpened', 'MAYDAY'), ('RaiseAlert', 'man_down'), ('RaiseAlert', 'mayday')] and len(e.state.episodes) == 1
    e = Eng(); e.step(mf(MD), 0); assert ep(e).kind == 'MAN_DOWN'

def test_a_restart_with_the_latch_still_set_opens_no_second_episode_or_alert():
    e = Eng(); e.step(mf(MD), 0)
    e.state = EngineState(event_seq=e.state.event_seq, alerts=dict(e.state.alerts), episodes=dict(e.state.episodes))   # rebuilt from open rows; node memory gone
    assert e.step(mf(MD)) == [] and len(e.state.episodes) == 1 and len(e.state.alerts) == 1

def test_mandown_0_to_1_while_an_episode_is_open_or_acknowledged_adds_no_episode_and_no_alert():
    for ack in (False, True):
        e = Eng(); e.step(mf(MD), 0)
        if ack: e.step(AckEpisodeEvent(1, 7), 0)
        e.step(mf(0)); assert e.step(mf(MD)) == [] and len(e.state.episodes) == 1 and len(e.state.alerts) == 1

def test_a_suspect_frame_opens_an_episode_but_never_moves_a_label_timer():
    e = Eng(); assert nm(e.step(mf(MD, motion=50, seq_class='suspect'), 0)) == [('EpisodeOpened', 'MAN_DOWN'), ('RaiseAlert', 'man_down')]
    e.step(mf(MD, motion=50, seq_class='suspect')); e.step(mf(MD, motion=50, seq_class='suspect'), 9000)
    assert ep(e).motion_state == 'no_response' and ep(e).move_since_mono is None

def test_nodes_have_independent_episodes():
    e = Eng(); e.step(mf(MD, node=1), 0); e.step(mf(MD, node=2), 0); assert set(e.state.episodes) == {1, 2}
    resolve(e, n=1); assert set(e.state.episodes) == {2} and al(e, 'man_down', 2) is not None

# ---- Acknowledge never closes a safety alert (14.1b, 14.1) ----
@pytest.mark.parametrize('typ', ['man_down', 'mayday', 'co_threshold', 'node_danger', 'link_lost', 'sensor_fault', 'battery_low'])
def test_acknowledge_sets_acknowledged_ts_and_never_closes_a_safety_alert(typ):
    e = Eng(); e.state, _ = raise_alert(e.state, 1, typ, 'DANGER', 'setup', e.clock.now()); seq0 = e.state.event_seq
    fx = e.step(AckAlertEvent(1, typ, 7), 0); assert nm(fx) == [('AlertAcknowledged', typ)] and al(e, typ).acknowledged_ts is not None and e.state.event_seq == seq0 + 1
    assert e.step(AckAlertEvent(1, typ, 7), 0) == [] and al(e, typ) is not None                       # idempotent
    assert e.step(AckAlertEvent(1, 'heat', 7), 0) == []                                                # nothing open: no effect, no error

def test_GV10_acknowledge_closes_an_unauth_alert_and_the_next_claim_opens_a_new_card_with_count_1():
    from test_link_battery import bad
    e = Eng(); e.step(bad(0x06, 2), 0); e.step(bad(0x06, 2)); assert al(e, 'unauth_alert', 2) is not None and e.state.nodes[2].unauth_count == 2
    assert nm(e.step(AckAlertEvent(2, 'unauth_alert', 7), 0)) == [('AlertAcknowledged', 'unauth_alert'), ('ClearAlert', 'unauth_alert')] and al(e, 'unauth_alert', 2) is None
    assert nm(e.step(bad(0x06, 2))) == [('RaiseAlert', 'unauth_alert')] and e.state.nodes[2].unauth_count == 1

def test_acknowledge_episode_acknowledges_the_episode_and_its_open_rows_and_closes_nothing():
    e = Eng(); e.step(mf(MD, MAYDAY), 0); fx = e.step(AckEpisodeEvent(1, 7), 0)
    assert nm(fx) == [('EpisodeAcknowledged', None), ('AlertAcknowledged', 'man_down'), ('AlertAcknowledged', 'mayday')]
    assert ep(e).state == 'ACKNOWLEDGED' and ep(e).acknowledged_by == 7 and al(e, 'man_down').acknowledged_ts is not None and al(e, 'mayday').acknowledged_ts is not None
    assert e.step(AckEpisodeEvent(1, 7), 0) == [] and e.step(AckEpisodeEvent(3, 7), 0) == [] and e.state.nodes[1].level == 'DANGER'

# ---- Resolve (14.1: the only way an episode ends) ----
def test_resolve_closes_the_episode_and_its_man_down_and_mayday_rows_and_nothing_else():
    e = Eng(); e.step(mf(MD, MAYDAY), 0); e.state, _ = raise_alert(e.state, 1, 'co_threshold', 'WARNING', 'setup', e.clock.now())
    fx = resolve(e, 'false_alarm'); assert nm(fx) == [('EpisodeResolved', 'MAYDAY'), ('ClearAlert', 'man_down'), ('ClearAlert', 'mayday')] and fx[0].reason == 'false_alarm' and fx[0].operator_id == 7
    assert e.state.episodes == {} and sorted(t for _, t in e.state.alerts) == ['co_threshold']

@pytest.mark.parametrize('reason', ['rescued', 'false_alarm', 'device_removed'])
def test_resolve_accepts_the_three_reasons(reason):
    e = Eng(); e.step(mf(MD), 0); assert nm(resolve(e, reason))[0] == ('EpisodeResolved', 'MAN_DOWN') and e.state.episodes == {}

@pytest.mark.parametrize('reason,op', [('bored', 7), (None, 7), ('', 7), ('rescued', None)])
def test_resolve_refuses_a_missing_reason_or_operator_and_changes_nothing(reason, op):
    e = Eng(); e.step(mf(MD), 0); before = e.state
    with pytest.raises(ValueError): e.step(ResolveEpisodeEvent(1, reason, op), 0)
    assert e.state is before and len(e.state.episodes) == 1

def test_resolve_with_no_active_episode_is_a_no_op():
    e = Eng(); before = e.state; assert resolve(e) == [] and e.state == before

def test_GV20_latch_still_set_after_resolve_is_a_level_not_an_event_and_clears_with_the_jacket_cancel():
    e = Eng(); e.step(mf(MD, motion=1), 0); resolve(e); assert e.state.nodes[1].level == 'DANGER'          # the node still reports DANGER
    out = []
    for _ in range(3): out += e.step(mf(MD))                                                                 # (a)
    assert out == [] and e.state.episodes == {} and e.state.alerts == {} and e.state.nodes[1].level == 'DANGER'
    assert e.step(mf(0)) == [] and e.state.nodes[1].level == 'NORMAL' and not al(e, 'node_danger')          # (b)

def test_after_resolve_and_a_jacket_clear_a_new_mandown_edge_opens_a_new_episode():
    e = Eng(); e.step(mf(MD), 0); first = ep(e).opened_event_seq; resolve(e); e.step(mf(0))
    assert nm(e.step(mf(MD))) == [('EpisodeOpened', 'MAN_DOWN'), ('RaiseAlert', 'man_down')] and ep(e).opened_event_seq != first

def test_a_latch_cleared_on_the_jacket_keeps_the_episode_open_until_an_operator_resolves_it():
    e = Eng(); e.step(mf(MD), 0)
    for _ in range(40): e.step(mf(0))
    assert ep(e) is not None and al(e, 'man_down') is not None
    e.step(TickEvent(), 60000); assert ep(e) is not None                                                    # no auto-resolve, ticks included

# ---- the MAN_DOWN label (3.3, 3.4): 5 s of movement, 15 s of stillness; card, siren and level never reduce ----
def labels(fx): return [x.motion_state for x in fx if isinstance(x, EpisodeLabelChanged)]
def test_label_changes_to_movement_detected_after_5_s_above_still_g_and_the_boundary_is_5_s():
    e = Eng(); e.step(mf(MD), 0); assert labels(e.step(mf(MD, motion=6), 2000)) == [] and labels(e.step(mf(MD, motion=6), 4999)) == [] and ep(e).motion_state == 'no_response'
    assert labels(e.step(mf(MD, motion=6), 1)) == ['movement_detected'] and ep(e).motion_state == 'movement_detected'   # 5000 ms after the first moving frame
    assert e.state.nodes[1].level == 'DANGER' and al(e, 'man_down').level == 'DANGER' and al(e, 'man_down').acknowledged_ts is None and ep(e).state == 'OPEN'

def test_motion_at_exactly_still_g_is_still_and_one_still_frame_restarts_the_5_s_run():
    e = Eng(); e.step(mf(MD), 0)
    for _ in range(5): e.step(mf(MD, motion=5))                                   # 0.05 g is not above STILL_G
    assert ep(e).motion_state == 'no_response'
    e.step(mf(MD, motion=6), 0); e.step(mf(MD, motion=6), 4000); e.step(mf(MD, motion=0), 500); e.step(mf(MD, motion=6), 500)
    assert labels(e.step(mf(MD, motion=6), 4000)) == [] and labels(e.step(mf(MD, motion=6), 1000)) == ['movement_detected']

def test_label_reverts_to_no_response_after_15_s_of_renewed_stillness_and_movement_restarts_that_clock():
    e = Eng(); e.step(mf(MD), 0); e.step(mf(MD, motion=9), 0); e.step(mf(MD, motion=9), 5000); assert ep(e).motion_state == 'movement_detected'
    e.step(mf(MD, motion=0), 2000); assert labels(e.step(mf(MD, motion=0), 12999)) == [] and labels(e.step(mf(MD, motion=9), 100)) == []
    e.step(mf(MD, motion=0), 100); assert labels(e.step(mf(MD, motion=0), 14999)) == [] and labels(e.step(mf(MD, motion=0), 1)) == ['no_response']
    assert e.state.nodes[1].level == 'DANGER' and al(e, 'man_down').level == 'DANGER'

def test_mayday_has_no_label_and_an_upgrade_drops_it():
    e = Eng(); e.step(mf(MD, MAYDAY), 0)
    for _ in range(6): assert labels(e.step(mf(MD, MAYDAY, motion=50))) == []
    assert ep(e).motion_state is None
    e = Eng(); e.step(mf(MD, motion=50), 0); e.step(mf(MD, MAYDAY, motion=50)); assert ep(e).motion_state is None and ep(e).move_since_mono is None

def test_label_survives_acknowledge_and_a_new_episode_starts_at_no_response():
    e = Eng(); e.step(mf(MD, motion=9), 0); e.step(mf(MD, motion=9), 5000); e.step(AckEpisodeEvent(1, 7), 0); assert ep(e).motion_state == 'movement_detected' and ep(e).state == 'ACKNOWLEDGED'
    resolve(e); e.step(mf(0)); e.step(mf(MD)); assert ep(e).motion_state == 'no_response'

def test_the_new_effects_and_events_are_exported_and_unknown_events_still_raise():
    for c in (AlertAcknowledged, EpisodeAcknowledged, EpisodeEscalated, EpisodeOpened, EpisodeResolved, EpisodeLabelChanged): assert issubclass(c, re_.Effect)
    with pytest.raises(TypeError): Eng().step(object())
