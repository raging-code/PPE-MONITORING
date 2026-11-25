"""P5: golden-vector harness for the pure rule engine (design 14.4 and 14.6). One table, CASES; each case is a list of steps run
through step() with a FakeClock. Frames come from shared/vectors/frames.json through the real codec (core/crypto_abi.py).
Later Parts add their GV cases at the marker line at the end of the table. A failing case is REPORTED with the case id and every
mismatch; do not edit a vector or a rule to make it pass without an ADR (guide Section 1, last rule).
Case: id, gv (the design vector it stands for), desc, open (alerts open before the first step: (node, type, level)), steps.
Step: frame (vector id) + seq_class, or tick=True; dt_ms (clock advance before the step); expect = {effects, open, episodes, seq_delta, levels}.
effects are ('raise', node, type, level) or ('clear', node, type, None); open is the sorted (node, type, level) rows left open."""
import json
from pathlib import Path
import pytest
from ppe_host.clock import FakeClock
from ppe_host.core import crypto_abi as ca
from ppe_host.core.rule_engine import (ClearAlert, EngineState, FrameEvent, RaiseAlert, TickEvent, node_level, raise_alert, step)

ROOT = Path(__file__).resolve().parents[2]
VEC = json.loads((ROOT / 'shared' / 'vectors' / 'frames.json').read_text(encoding='utf8'))
KEY, SYS = bytes.fromhex(VEC['key_hex']), VEC['sys_id']
HEX = {f['id']: f['hex'] for f in VEC['frames']}

def frame_event(fid, seq_class):
    r = ca.classify_frame(bytes.fromhex(HEX[fid]), KEY, SYS)
    return FrameEvent(r.node_id, r.result, seq_class, r.decoded)

def project(fx):
    return [('raise', e.node_id, e.type, e.level) if isinstance(e, RaiseAlert) else ('clear', e.node_id, e.type, None) for e in fx]

def run_case(case):
    """Returns a list of mismatch strings (empty = pass)."""
    clock, state, bad = FakeClock(1_700_000_000_000, 10_000), EngineState(), []
    for node, typ, level in case.get('open', []): state, _ = raise_alert(state, node, typ, level, 'setup', clock.now())
    for i, st in enumerate(case['steps'], 1):
        clock.advance(st.get('dt_ms', 0)); before = state.event_seq
        event = TickEvent() if st.get('tick') else frame_event(st['frame'], st['seq_class'])
        state, fx = step(state, event, clock.now()); exp = st['expect']; where = f"{case['id']} step {i}"
        if 'effects' in exp and project(fx) != exp['effects']: bad.append(f"{where}: effects {project(fx)} != {exp['effects']}")
        if 'open' in exp:
            got = sorted((a.node_id, a.type, a.level) for a in state.alerts.values())
            if got != sorted(exp['open']): bad.append(f"{where}: open alerts {got} != {sorted(exp['open'])}")
        if 'episodes' in exp and len(state.episodes) != exp['episodes']: bad.append(f"{where}: episodes {len(state.episodes)} != {exp['episodes']}")
        if 'seq_delta' in exp and state.event_seq - before != exp['seq_delta']: bad.append(f"{where}: event_seq moved {state.event_seq - before} != {exp['seq_delta']}")
        for node, level in exp.get('levels', {}).items():
            if node_level(state, node) != level: bad.append(f"{where}: node {node} level {node_level(state, node)} != {level}")
        if any(isinstance(e, ClearAlert) for e in fx) and event.__class__ is FrameEvent and event.seq_class == 'suspect':
            bad.append(f"{where}: a suspect frame cleared an alert")                      # 14.1 and 14.6 invariant, checked on every case
    return bad

CASES = [
    {'id': 'PH-01', 'gv': 'GV-04 (partial)', 'desc': 'PLACEHOLDER, replaced in P7 by the full GV-04 (it will also raise unauth_alert): node 2 BAD_MAC frame claiming man-down opens no alert and no episode and leaves the level alone',
     'steps': [{'frame': 'F-16', 'seq_class': 'suspect', 'expect': {'effects': [], 'open': [], 'episodes': 0, 'seq_delta': 0, 'levels': {2: 'NORMAL'}}}]},
    {'id': 'PH-02', 'gv': 'GV-13/GV-14 (partial)', 'desc': 'A suspect frame never clears or lowers an alert: open co_threshold WARNING on node 1, suspect frame with CO 0 and no flags leaves it open',
     'open': [(1, 'co_threshold', 'WARNING')],
     'steps': [{'frame': 'F-08', 'seq_class': 'suspect', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [(1, 'co_threshold', 'WARNING')], 'episodes': 0, 'seq_delta': 0}}]},
    {'id': 'PH-03', 'gv': 'GV-01 (partial)', 'desc': 'PLACEHOLDER, replaced in P6 by GV-01 (it will raise co_threshold): until a rule exists a fresh F-01 and a timer tick produce no effects and use no event_seq',
     'steps': [{'frame': 'F-01', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [], 'episodes': 0, 'seq_delta': 0, 'levels': {1: 'NORMAL'}}},
               {'tick': True, 'dt_ms': 20000, 'expect': {'effects': [], 'open': [], 'seq_delta': 0}}]},
    {'id': 'PH-04', 'gv': 'D1 (partial)', 'desc': 'A duplicate frame and a frame with a bad CRC are never evaluated: the open man_down alert stays open and nothing is raised',
     'open': [(1, 'man_down', 'DANGER')],
     'steps': [{'frame': 'F-01', 'seq_class': 'duplicate', 'expect': {'effects': [], 'open': [(1, 'man_down', 'DANGER')], 'seq_delta': 0}},
               {'frame': 'F-17', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [(1, 'man_down', 'DANGER')], 'seq_delta': 0}}]},
    # ---- GV cases above this line (each later Part adds its own here) ----
]

@pytest.mark.parametrize('case', CASES, ids=[c['id'] for c in CASES])
def test_golden_case(case):
    bad = run_case(case); assert not bad, '\n'.join(bad)

def test_harness_itself():
    assert len(CASES) >= 2 and len({c['id'] for c in CASES}) == len(CASES)
    for c in CASES:
        assert c['id'] and c['gv'] and c['desc'] and c['steps']
        for st in c['steps']: assert st.get('tick') or st['frame'] in HEX, c['id']
    # the harness must be able to FAIL: wrong expectations are reported with the case id, one message per mismatch
    wrong = {'id': 'X-1', 'steps': [{'frame': 'F-01', 'seq_class': 'fresh', 'expect': {'effects': [('raise', 1, 'co_threshold', 'WARNING')], 'open': [(1, 'heat', 'WARNING')], 'episodes': 1, 'seq_delta': 3, 'levels': {1: 'DANGER'}}}]}
    msgs = run_case(wrong); assert len(msgs) == 5 and all(m.startswith('X-1 step 1') for m in msgs)

def test_frames_reach_the_engine_through_the_real_codec():
    assert frame_event('F-16', 'suspect').verify == 'BAD_MAC' and frame_event('F-16', 'suspect').node_id == 2
    assert frame_event('F-17', 'fresh').verify == 'BAD_CRC' and frame_event('F-01', 'fresh').verify == 'OK'
    assert frame_event('F-24', 'fresh').decoded['temp_x100'] == -500
