"""P9: the Hypothesis property tests of design 14.6, run over the real engine and the advisory step. Each property is a plain check_* function over a trace so it
also runs without Hypothesis. Events are built from small spec tuples; the strategy draws specs. Operator events are not generated here (P7c-1 tests them)."""
from dataclasses import replace
import pytest
from hypothesis import HealthCheck, given, settings, strategies as st
from ppe_host.clock import FakeClock
from ppe_host.core.advisory import AdvisoryConfig, AdvisoryRow, AdvisoryState, RISKS, advise, advisory_step
from ppe_host.core.rule_engine import (ALERT_TYPES, RANK, ChangeAlertLevel, ClearAlert, EngineState, FrameEvent, RaiseAlert, TickEvent, step)
from test_advisory import BEAT_MS, CFG
from test_co_state import BASE

DTS = (0, 1000, 2000, 2000, 2000, 5000, 16000, 61000)
FLAGS = (0, 1, 2, 6, 0x81, 0x09, 0x03)                      # 0x03 = node_level INVALID (the gate drops it)
# spec: ('frame', node, seq_class, verify, flags, co_x10, status2, status4, bat, dt) or ('tick', dt)
frame_spec = st.tuples(st.just('frame'), st.sampled_from((1, 2, 3)), st.sampled_from(('fresh', 'fresh', 'fresh', 'suspect', 'duplicate', 'reboot')),
                       st.sampled_from(('OK', 'OK', 'OK', 'BAD_MAC', 'BAD_CRC')), st.sampled_from(FLAGS), st.sampled_from((0, 300, 400, 2500, 5200)),
                       st.sampled_from((0, 0, 0x10, 0x20, 0x40, 0x04)), st.sampled_from((0, 0, 0x10)), st.sampled_from((80, 10)), st.sampled_from(DTS))
specs = st.lists(st.one_of(frame_spec, st.tuples(st.just('tick'), st.sampled_from(DTS))), max_size=60)
PROP = settings(max_examples=150, deadline=None, suppress_health_check=[HealthCheck.too_slow])

def make_event(spec):
    if spec[0] == 'tick': return TickEvent(), spec[1]
    _, node, sc, vf, flags, co, s2, s4, bat, dt = spec
    d = dict(BASE); d.update(flags=flags, co_x10=co, status2=s2, status4=s4, bat=bat, id_mode=0x40 | node)
    return FrameEvent(node, vf, sc, d), dt

def run(spec_list, rebuild=False, advisory=False):
    """Trace: list of (event, state_before, state_after, effects). With advisory=True the advisory rows follow each step's effects."""
    clock, s, a, trace = FakeClock(1_700_000_000_000, 10_000), EngineState(), AdvisoryState(), []
    for spec in spec_list:
        e, dt = make_event(spec); clock.advance(dt); now = clock.now()
        before = s; s, fx = step(s, e, now, rebuild=rebuild)
        if advisory: s, a, afx = advisory_step(s, a, e, now, CFG, rebuild=rebuild); fx = tuple(fx) + tuple(afx)
        trace.append((e, before, s, tuple(fx)))
    return trace

# ---- the checks ----
def check_suspect_never_clears_or_lowers(trace):
    for e, before, after, fx in trace:
        if not isinstance(e, FrameEvent) or e.seq_class != 'suspect': continue
        assert not any(isinstance(x, ClearAlert) for x in fx)
        assert not any(isinstance(x, ChangeAlertLevel) and RANK[x.level] < RANK[x.old_level] for x in fx)
        assert set(before.alerts) <= set(after.alerts)
        assert all(RANK[after.alerts[k].level] >= RANK[v.level] for k, v in before.alerts.items())

def check_one_open_alert_per_node_and_type(trace):
    open_rows = {}
    for _, _, after, fx in trace:
        for x in fx:
            if isinstance(x, RaiseAlert) and not x.one_shot:
                assert (x.node_id, x.type) not in open_rows; open_rows[(x.node_id, x.type)] = x.event_seq
            elif isinstance(x, ClearAlert):
                assert open_rows.pop((x.node_id, x.type)) == x.raised_event_seq
        assert set(open_rows) == set(after.alerts) and all(t in ALERT_TYPES for _, t in after.alerts)

def check_event_seq_strictly_increasing(trace):
    seqs = [x.event_seq for _, _, _, fx in trace for x in fx if hasattr(x, 'event_seq')]
    assert all(b > a for a, b in zip(seqs, seqs[1:]))
    if trace: assert trace[-1][2].event_seq >= (seqs[-1] if seqs else 0)

def check_advisory_rows(trace):
    last, beat = {}, {}
    for _, _, _, fx in trace:
        for x in fx:
            if not isinstance(x, AdvisoryRow): continue
            assert x.risk in RISKS and x.quality in ('high', 'medium', 'low') and x.window_s == 60 and x.source == 'table'
            if x.node_id in last and not x.heartbeat: assert x.risk != last[x.node_id]       # a change row changes the risk
            if x.heartbeat: assert x.risk == last[x.node_id]
            last[x.node_id] = x.risk; beat[x.node_id] = x.ts

# ---- the properties of 14.6 ----
@PROP
@given(specs)
def test_a_suspect_frame_never_clears_or_lowers_an_alert(sp): check_suspect_never_clears_or_lowers(run(sp))

@PROP
@given(specs)
def test_at_most_one_open_alert_per_node_and_type(sp): check_one_open_alert_per_node_and_type(run(sp))

@PROP
@given(specs)
def test_event_seq_is_strictly_increasing_across_engine_and_advisory(sp):
    t = run(sp, advisory=True); check_event_seq_strictly_increasing(t); check_advisory_rows(t)

@PROP
@given(specs)
def test_replaying_the_same_frame_list_gives_the_same_effects(sp):
    a, b = run(sp, advisory=True), run(sp, advisory=True)
    assert [(t[2], t[3]) for t in a] == [(t[2], t[3]) for t in b]

@PROP
@given(specs)
def test_rebuild_returns_no_effects_and_the_same_state_as_live(sp):
    live, rb = run(sp, advisory=True), run(sp, rebuild=True, advisory=True)
    assert all(t[3] == () for t in rb) and [t[2] for t in rb] == [t[2] for t in live]

@PROP
@given(st.sets(st.sampled_from(sorted(ALERT_TYPES))), st.sampled_from(('WARNING', 'DANGER')))
def test_every_level_other_than_normal_gets_a_non_nominal_row(reasons, level):
    risk, action = advise(level, reasons)
    assert risk != 'NOMINAL' and risk in RISKS and action
    assert (risk == 'CRITICAL_LIFE_SAFETY') == (level == 'DANGER' and bool(reasons & {'mayday', 'man_down'}))
