"""P7b: notice and badge types of design 14.1b (all level NONE): wrist_open / wrist_close (GV-21), button_stuck (GV-22), missed_event and
watchdog_recovery (GV-23), latch_restored and watchdog_recovery (GV-26), co_warmup (GV-27), node_reboot; weak_signal and estimate disabled.
The GV-21 to GV-27 vectors are field-level (no frames.json entry), so they run here, not in the harness table. Frames are built from F-01. Requirements: REQ-RUL-007, REQ-RUL-008, REQ-RUL-011, REQ-RUL-012."""
import pytest
from test_co_state import co_frame
from test_co_threshold import Eng
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import EngineState, FrameEvent, RaiseAlert, TickEvent

PERSISTENT = ('wrist_open', 'button_stuck', 'missed_event', 'co_warmup')
ONE_SHOT = ('wrist_close', 'node_reboot', 'latch_restored', 'watchdog_recovery')
NOTICES = PERSISTENT + ONE_SHOT

def nf(status3=0, status4=0, evt=0, flags=0, seq_class='fresh', co_x10=0, boot=7, node=1):
    d = dict(co_frame(co_x10=co_x10, node=node).decoded); d.update(status3=status3, status4=status4, flags=flags, boot_ctr=boot, id_mode=0x41 | (0x80 if evt else 0), evt_unsent=evt)
    return FrameEvent(node, 'OK', seq_class, d)
def nt(fx, types=NOTICES): return [(type(x).__name__, x.type, x.level if isinstance(x, RaiseAlert) else None, getattr(x, 'one_shot', None)) for x in fx if x.type in types]
def op(e, t, n=1): return e.state.alerts.get((n, t))
def only_notices_changed(e): return e.state.nodes[1].level == 'NORMAL' and e.state.episodes == {}

def test_order_notice_rule_sits_before_man_down_and_node_danger_stays_last():
    r = re_.RULES; assert r[-1] is re_.node_danger_rule and r[-2] is re_.man_down_rule and r[-3] is re_.notice_rule

# ---- wrist_open / wrist_close (GV-21) ----
def test_GV21_a_wrist_open_needs_two_consecutive_frames_and_b_close_within_2_s():
    e = Eng(); assert nt(e.step(nf(status4=0x01), 0)) == [] and op(e, 'wrist_open') is None            # one frame: the bit was seen for 0 ms
    assert nt(e.step(nf(status4=0x01))) == [('RaiseAlert', 'wrist_open', 'NONE', False)] and only_notices_changed(e)   # 2 s later: held >= wrist_open_ms (200)
    assert nt(e.step(nf(status4=0x01))) == [] and len([a for a in e.state.alerts if a[1] == 'wrist_open']) == 1
    assert nt(e.step(nf(status4=0x00), 1000)) == [('ClearAlert', 'wrist_open', None, None), ('RaiseAlert', 'wrist_close', 'NONE', True)] and op(e, 'wrist_open') is None and only_notices_changed(e)

def test_wrist_back_to_0_after_more_than_wrist_close_confirm_s_ends_wrist_open_without_wrist_close():
    e = Eng(); e.step(nf(status4=0x01), 0); e.step(nf(status4=0x01))
    assert nt(e.step(nf(status4=0x00), 2001)) == [('ClearAlert', 'wrist_open', None, None)]
    e = Eng(); e.step(nf(status4=0x01), 0); e.step(nf(status4=0x01)); assert [x[1] for x in nt(e.step(nf(status4=0x00), 2000))] == ['wrist_open', 'wrist_close']   # exactly 2 s counts

def test_a_single_open_frame_then_closed_logs_nothing_and_a_new_rising_edge_restarts_the_200_ms_clock():
    e = Eng(); e.step(nf(status4=0x01), 0); assert nt(e.step(nf(status4=0x00))) == [] and e.state.nodes[1].wrist_open_since_mono is None
    assert nt(e.step(nf(status4=0x01))) == [] and nt(e.step(nf(status4=0x01))) != []

# ---- the other persistent notices (GV-22, GV-23 a, GV-27) ----
CASES = [('button_stuck', dict(status3=0x01)), ('missed_event', dict(evt=1)), ('co_warmup', dict(status3=0x04))]
@pytest.mark.parametrize('typ,kw', CASES, ids=[c[0] for c in CASES])
def test_persistent_notice_raises_once_over_30_frames_clears_when_the_bit_returns_to_0_and_a_new_edge_opens_a_new_row(typ, kw):
    e = Eng(); raised = nt(e.step(nf(**kw), 0), (typ,)); assert raised == [('RaiseAlert', typ, 'NONE', False)] and only_notices_changed(e)   # GV-22 a / GV-23 a / GV-27 a
    first = op(e, typ).event_seq; n = sum(len(nt(e.step(nf(**kw)), (typ,))) for _ in range(30))
    assert n == 0 and op(e, typ).event_seq == first and sum(1 for k in e.state.alerts if k[1] == typ) == 1
    assert [x[:2] for x in nt(e.step(nf()), (typ,))] == [('ClearAlert', typ)] and op(e, typ) is None and only_notices_changed(e)   # (b) ends
    assert nt(e.step(nf(**kw)), (typ,)) == [('RaiseAlert', typ, 'NONE', False)] and op(e, typ).event_seq != first

@pytest.mark.parametrize('typ,kw', CASES + [('wrist_open', dict(status4=0x01))], ids=[c[0] for c in CASES] + ['wrist_open'])
def test_persistent_notice_stays_one_row_after_a_restart_in_the_middle_of_the_condition(typ, kw):
    e = Eng(); e.step(nf(**kw), 0); e.step(nf(**kw)); assert op(e, typ) is not None
    e.state = EngineState(event_seq=e.state.event_seq, alerts=dict(e.state.alerts))   # host restart or End shift: node memory gone, open rows rebuilt by cleared_ts IS NULL
    assert [x for x in nt(e.step(nf(**kw)) + e.step(nf(**kw)), (typ,)) if x[0] == 'RaiseAlert'] == [] and sum(1 for k in e.state.alerts if k[1] == typ) == 1

def test_GV23_b_missed_event_ends_and_watchdog_recovery_is_raised_once():
    e = Eng(); e.step(nf(evt=1), 0)
    assert nt(e.step(nf(evt=0))) == [('ClearAlert', 'missed_event', None, None), ('RaiseAlert', 'watchdog_recovery', 'NONE', True)] and only_notices_changed(e)
    assert nt(e.step(nf(evt=0))) == [] and op(e, 'watchdog_recovery') is None

def test_GV27_a_co_warmup_badge_while_co_threshold_still_raises_at_warning_and_b_it_stays_open():
    e = Eng(); fx = e.step(nf(status3=0x04, co_x10=520, flags=0x01), 0)
    assert [(type(x).__name__, x.type) for x in fx if isinstance(x, RaiseAlert)] == [('RaiseAlert', 'co_threshold'), ('RaiseAlert', 'co_warmup')] and op(e, 'co_threshold').level == 'WARNING'
    e.step(nf(status3=0x00, co_x10=520, flags=0x01)); assert op(e, 'co_warmup') is None and op(e, 'co_threshold') is not None

# ---- one-shot notices ----
def test_one_shot_rows_are_flagged_never_held_in_state_and_add_nothing_while_the_condition_is_held():
    e = Eng(); fx = e.step(nf(status4=0x02), 0); assert nt(fx) == [('RaiseAlert', 'latch_restored', 'NONE', True)] and op(e, 'latch_restored') is None   # GV-26 a: first-seen bit 1
    assert sum(len(nt(e.step(nf(status4=0x02)))) for _ in range(10)) == 0
    e.step(nf()); assert nt(e.step(nf(status4=0x02))) == [('RaiseAlert', 'latch_restored', 'NONE', True)]   # a new 0 -> 1 edge
    assert [x for x in re_.RaiseAlert.__dataclass_fields__] [-1] == 'one_shot'

def test_GV26_a_latch_restored_with_man_down_and_no_watchdog_recovery_and_b_watchdog_only():
    e = Eng(); fx = e.step(nf(flags=0x06, status4=0x02), 0)
    assert [(x.type) for x in fx if isinstance(x, RaiseAlert)] == ['latch_restored', 'man_down'] and op(e, 'man_down').level == 'DANGER'
    fx = e.step(nf(flags=0x00, status3=0x10, status4=0x00)); assert nt(fx) == [('RaiseAlert', 'watchdog_recovery', 'NONE', True)]   # (b): no latch_restored
    assert nt(e.step(nf(status3=0x10))) == []                                                                                   # held for 60 s: no repeat

def test_watchdog_recovery_carries_the_reset_cause_and_a_second_0_to_1_raises_again():
    e = Eng(); fx = e.step(nf(status3=0x10 | (2 << 5)), 0); assert 'cause=2' in [x for x in fx if x.type == 'watchdog_recovery'][0].reasons
    e.step(nf()); assert nt(e.step(nf(status3=0x10))) != []

def test_node_reboot_is_one_shot_and_notes_an_open_man_down():
    e = Eng(); assert nt(e.step(nf(seq_class='reboot', boot=8), 0)) == [('RaiseAlert', 'node_reboot', 'NONE', True)] and nt(e.step(nf(boot=8))) == []
    e = Eng(); e.step(nf(flags=0x06), 0); fx = e.step(nf(flags=0x06, seq_class='reboot', boot=9))
    assert [x.reasons for x in fx if x.type == 'node_reboot'] == ['boot_ctr=9 while_man_down'] and op(e, 'man_down') is not None

# ---- gate and level rules ----
@pytest.mark.parametrize('kw', [dict(status3=0x01), dict(evt=1), dict(status3=0x04), dict(status4=0x03), dict(status3=0x10), dict(seq_class='reboot')])
def test_a_suspect_frame_raises_no_notice(kw):
    e = Eng(); assert nt(e.step(nf(**{**kw, 'seq_class': 'suspect'}), 0)) == []

def test_a_suspect_frame_never_ends_a_persistent_notice():
    e = Eng(); e.step(nf(status3=0x01), 0); assert e.step(nf(seq_class='suspect')) == [] and op(e, 'button_stuck') is not None

def test_duplicate_and_failed_frames_raise_no_notice():
    e = Eng(); assert nt(e.step(nf(status3=0x01, seq_class='duplicate'), 0)) == []
    d = dict(nf(status3=0x01).decoded); assert nt(e.step(FrameEvent(1, 'BAD_CRC', 'fresh', d))) == [] and nt(e.step(TickEvent())) == []

def test_notices_never_change_a_node_level_open_an_episode_or_sound_above_none():
    e = Eng()
    for kw in (dict(status3=0x01), dict(evt=1), dict(status3=0x04), dict(status4=0x03), dict(status3=0x10), dict(seq_class='reboot', boot=8)):
        for x in e.step(nf(**kw)): assert getattr(x, 'level', 'NONE') == 'NONE'
    for _ in range(3): e.step(nf(status4=0x01))
    assert only_notices_changed(e) and all(a.level == 'NONE' for a in e.state.alerts.values())

def test_catalog_marks_all_seven_notice_types_as_notice_with_level_none_only():
    import json; from pathlib import Path
    cat = {c['type']: c for c in json.loads((Path(__file__).resolve().parents[2] / 'shared' / 'alert_catalog.json').read_text(encoding='utf8'))}
    for t in NOTICES + ('weak_signal',): assert cat[t]['class'] == 'notice' and cat[t]['allowed_levels'] == ['NONE'] and t in re_.ALERT_TYPES

def test_weak_signal_and_estimate_are_present_but_disabled():
    assert re_.WEAK_SIGNAL_ENABLED is False and re_.ESTIMATE_ENABLED is False and {'weak_signal', 'estimate'} <= re_.ALERT_TYPES
    e = Eng(); seen = set()
    for kw in (dict(status3=0xFF, status4=0xFF, evt=1), dict(co_x10=1500, flags=0x03)):
        seen |= {x.type for x in e.step(nf(**kw)) if isinstance(x, RaiseAlert)}
    assert not seen & {'weak_signal', 'estimate'}
