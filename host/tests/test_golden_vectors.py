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
SUSPECT_NOTICE_ON = True   # P8: conftest.py keeps suspect_frame_rule in RULES for this module
from ppe_host.clock import FakeClock
from ppe_host.core import crypto_abi as ca
from ppe_host.core.rule_engine import (ChangeAlertLevel, ClearAlert, EngineState, FrameEvent, RaiseAlert, TickEvent, node_level, raise_alert, step)

ROOT = Path(__file__).resolve().parents[2]
VEC = json.loads((ROOT / 'shared' / 'vectors' / 'frames.json').read_text(encoding='utf8'))
KEY, SYS = bytes.fromhex(VEC['key_hex']), VEC['sys_id']
HEX = {f['id']: f['hex'] for f in VEC['frames']}

def frame_event(fid, seq_class):
    r = ca.classify_frame(bytes.fromhex(HEX[fid]), KEY, SYS)
    return FrameEvent(r.node_id, r.result, seq_class, r.decoded)

def project(fx):
    return [('clear', e.node_id, e.type, None) if isinstance(e, ClearAlert) else ('raise', e.node_id, e.type, e.level) if isinstance(e, RaiseAlert)
            else ('escalate' if e.acknowledged_reset else 'lower', e.node_id, e.type, e.level) if isinstance(e, ChangeAlertLevel) else (type(e).__name__, e.node_id, None, None) for e in fx]   # P7c-1: episode effects project as (class name, node, None, None)

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
    {'id': 'GV-04', 'gv': 'GV-04', 'desc': 'F-16: node 2, BAD_MAC, flags 0x06 (claims man-down): raises unauth_alert NONE and nothing else; no episode, the level stays NORMAL (the diagnostic frames row and the 20 per minute limit are the writer and shell)',
     'steps': [{'frame': 'F-16', 'seq_class': 'suspect', 'expect': {'effects': [('raise', 2, 'unauth_alert', 'NONE')], 'open': [(2, 'unauth_alert', 'NONE')], 'episodes': 0, 'seq_delta': 1, 'levels': {2: 'NORMAL'}}}]},
    {'id': 'PH-02', 'gv': 'GV-13/GV-14 (partial)', 'desc': 'A suspect frame never clears or lowers an alert: open co_threshold WARNING on node 1, suspect frame with CO 0 and no flags leaves it open',
     'open': [(1, 'co_threshold', 'WARNING')],
     'steps': [{'frame': 'F-08', 'seq_class': 'suspect', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'suspect_frame', 'NONE')], 'open': [(1, 'co_threshold', 'WARNING')], 'episodes': 0, 'seq_delta': 1}}]},   # P8: the one-shot suspect_frame notice is the only effect
    {'id': 'GV-01', 'gv': 'GV-01', 'desc': 'Node 1, fresh F-01 (52.0 ppm, SCBA OFF, node_level WARNING): raises co_threshold WARNING, final level WARNING, 0 episodes; the same reading again adds nothing; a timer tick adds nothing',
     'steps': [{'frame': 'F-01', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'co_threshold', 'WARNING')], 'open': [(1, 'co_threshold', 'WARNING')], 'episodes': 0, 'seq_delta': 1, 'levels': {1: 'WARNING'}}},
               {'frame': 'F-01', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [(1, 'co_threshold', 'WARNING')], 'seq_delta': 0}},
               {'tick': True, 'dt_ms': 4000, 'expect': {'effects': [], 'open': [(1, 'co_threshold', 'WARNING')], 'seq_delta': 0}}]},   # 4 s: before co_timeout (5 s), which P6c turns into a sensor_fault
    {'id': 'PH-04', 'gv': 'D1 (partial)', 'desc': 'A duplicate frame and a frame with a bad CRC are never evaluated: the open man_down alert stays open and nothing is raised',
     'open': [(1, 'man_down', 'DANGER')],
     'steps': [{'frame': 'F-01', 'seq_class': 'duplicate', 'expect': {'effects': [], 'open': [(1, 'man_down', 'DANGER')], 'seq_delta': 0}},
               {'frame': 'F-17', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [(1, 'man_down', 'DANGER')], 'seq_delta': 0}}]},
    {'id': 'GV-02', 'gv': 'GV-02', 'desc': 'F-02: node 1, flags 0x06 (mandown, DANGER): raises man_down DANGER and no node_danger; the episode opens before the alert row (P7c-1)',
     'steps': [{'frame': 'F-02', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('EpisodeOpened', 1, None, None), ('raise', 1, 'man_down', 'DANGER')], 'open': [(1, 'man_down', 'DANGER')], 'episodes': 1, 'seq_delta': 2, 'levels': {1: 'DANGER'}}}]},
    {'id': 'GV-03', 'gv': 'GV-03', 'desc': 'F-02 then F-03 (status4 MAYDAY, latch still set): the open MAN_DOWN episode is upgraded in place to MAYDAY (EpisodeEscalated, one episode) and mayday is raised DANGER',
     'steps': [{'frame': 'F-02', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('EpisodeOpened', 1, None, None), ('raise', 1, 'man_down', 'DANGER')], 'episodes': 1}},
               {'frame': 'F-03', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('EpisodeEscalated', 1, None, None), ('raise', 1, 'mayday', 'DANGER')], 'open': [(1, 'man_down', 'DANGER'), (1, 'mayday', 'DANGER')], 'episodes': 1, 'seq_delta': 2, 'levels': {1: 'DANGER'}}}]},
    {'id': 'GV-17ab', 'gv': 'GV-17 a, b', 'desc': 'F-14 (flags 0x02 only) twice: the first frame raises nothing, the second raises node_danger; a normal frame (F-08) clears it',
     'steps': [{'frame': 'F-14', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [], 'seq_delta': 0, 'levels': {1: 'DANGER'}}},
               {'frame': 'F-14', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'node_danger', 'DANGER')], 'open': [(1, 'node_danger', 'DANGER')], 'seq_delta': 1, 'levels': {1: 'DANGER'}}},
               {'frame': 'F-08', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('clear', 1, 'node_danger', None)], 'open': [], 'seq_delta': 1, 'levels': {1: 'NORMAL'}}}]},
    {'id': 'GV-17c', 'gv': 'GV-17 c', 'desc': 'F-07 (250 ppm, flags 0x02) twice: co_threshold is at DANGER, so no node_danger',
     'steps': [{'frame': 'F-07', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'co_threshold', 'DANGER')], 'open': [(1, 'co_threshold', 'DANGER')], 'seq_delta': 1, 'levels': {1: 'DANGER'}}},
               {'frame': 'F-07', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [(1, 'co_threshold', 'DANGER')], 'seq_delta': 0, 'levels': {1: 'DANGER'}}}]},
    {'id': 'GV-17d', 'gv': 'GV-17 d', 'desc': 'F-14 then F-08: the second frame resets the streak, so node_danger is never raised',
     'steps': [{'frame': 'F-14', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [], 'seq_delta': 0, 'levels': {1: 'DANGER'}}},
               {'frame': 'F-08', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [], 'seq_delta': 0, 'levels': {1: 'NORMAL'}}}]},
    {'id': 'GV-06a', 'gv': 'GV-06 a', 'desc': 'F-05: bat 10 %, bat_low bit: raises battery_low WARNING (latched), node level WARNING',
     'steps': [{'frame': 'F-05', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'battery_low', 'WARNING')], 'open': [(1, 'battery_low', 'WARNING')], 'episodes': 0, 'seq_delta': 1, 'levels': {1: 'WARNING'}}}]},
    {'id': 'GV-06d', 'gv': 'GV-06 d', 'desc': 'F-05 then F-10 (reboot, boot_ctr 8, bat 80): the reboot clears battery_low',
     'steps': [{'frame': 'F-05', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'battery_low', 'WARNING')]}},
               {'frame': 'F-10', 'seq_class': 'reboot', 'dt_ms': 2000, 'expect': {'effects': [('clear', 1, 'battery_low', None), ('raise', 1, 'node_reboot', 'NONE')], 'open': [], 'seq_delta': 2, 'levels': {1: 'NORMAL'}}}]},   # P7b: the reboot frame also logs the one-shot node_reboot notice (14.1b)
    {'id': 'GV-05a', 'gv': 'GV-05 a, b', 'desc': 'F-04: check-in bit 7 + WARNING raises checkin WARNING (0 episodes, level WARNING); the next frame with bit 7 at 0 clears it (level NORMAL)',
     'steps': [{'frame': 'F-04', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'checkin', 'WARNING')], 'open': [(1, 'checkin', 'WARNING')], 'episodes': 0, 'seq_delta': 1, 'levels': {1: 'WARNING'}}},
               {'frame': 'F-08', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('clear', 1, 'checkin', None)], 'open': [], 'episodes': 0, 'seq_delta': 1, 'levels': {1: 'NORMAL'}}}]},
    {'id': 'GV-05d', 'gv': 'GV-05 d', 'desc': 'F-02 (man-down) with an open checkin: opens the MAN_DOWN episode, raises man_down DANGER and clears the checkin row',
     'open': [(1, 'checkin', 'WARNING')],
     'steps': [{'frame': 'F-02', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('clear', 1, 'checkin', None), ('EpisodeOpened', 1, None, None), ('raise', 1, 'man_down', 'DANGER')], 'open': [(1, 'man_down', 'DANGER')], 'episodes': 1, 'seq_delta': 3, 'levels': {1: 'DANGER'}}}]},
    {'id': 'GV-14c', 'gv': 'GV-14 c', 'desc': 'F-02 (mandown) as a suspect frame, no open alert or episode: raise-only opens the MAN_DOWN episode and man_down DANGER, and the one-shot suspect_frame notice is raised first (GV-14 a, b, GV-11, GV-12 c and GV-13 run through the real classifier in test_seq_classifier.py)',
     'steps': [{'frame': 'F-02', 'seq_class': 'suspect', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'suspect_frame', 'NONE'), ('EpisodeOpened', 1, None, None), ('raise', 1, 'man_down', 'DANGER')], 'open': [(1, 'man_down', 'DANGER')], 'episodes': 1, 'seq_delta': 3, 'levels': {1: 'DANGER'}}}]},
    # ---- GV cases above this line (each later Part adds its own here; P8 added GV-14c (GV-11 to GV-14 also run through the real classifier in test_seq_classifier.py); P7c-2 added GV-05 a, b and d (GV-05 c and GV-24 are field-level, in test_checkin_scba.py); P7-1 added GV-02, GV-03, GV-17; P7-2 added GV-04, GV-06 a and d (GV-08, GV-10 and GV-12 are in test_link_battery.py)) ----
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
    wrong = {'id': 'X-1', 'steps': [{'frame': 'F-01', 'seq_class': 'fresh', 'expect': {'effects': [('raise', 1, 'heat', 'WARNING')], 'open': [(1, 'heat', 'WARNING')], 'episodes': 1, 'seq_delta': 3, 'levels': {1: 'DANGER'}}}]}
    msgs = run_case(wrong); assert len(msgs) == 5 and all(m.startswith('X-1 step 1') for m in msgs)

def test_frames_reach_the_engine_through_the_real_codec():
    assert frame_event('F-16', 'suspect').verify == 'BAD_MAC' and frame_event('F-16', 'suspect').node_id == 2
    assert frame_event('F-17', 'fresh').verify == 'BAD_CRC' and frame_event('F-01', 'fresh').verify == 'OK'
    assert frame_event('F-24', 'fresh').decoded['temp_x100'] == -500
