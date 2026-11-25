// patches/part07_2_battery_link_unauth.mjs  (run from repo root: node patches/part07_2_battery_link_unauth.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
const putB64 = (p, b64) => put(p, Buffer.from(b64, 'base64').toString('utf8'));
const replace = (p, oldStr, newStr) => plan.push({ op: 'replace', p, oldStr, newStr });
const append = (p, text) => plan.push({ op: 'append', p, text });
function apply() {
  const state = new Map(), log = [];
  const get = (p) => state.has(p) ? state.get(p) : (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && cur !== s.content && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : cur === s.content ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) {
      throw new Error(`MISSING file: ${s.p}`);
    } else if (s.op === 'replace') {
      const n = cur.split(s.oldStr).length - 1;
      if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
      else if (n === 0 && cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else throw new Error(`ANCHOR found ${n} times in ${s.p}: ${s.oldStr.slice(0, 60)}`);
    } else if (s.op === 'append') {
      if (cur.includes(s.text)) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : '\n') + s.text); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : `OK: ${state.size} file(s) written`);
}
try { await run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }

// ---- write only this part below ----
async function run() {
  put('host/tests/test_link_battery.py', String.raw`"""P7-2: battery_low (GV-06), signal_lost and link_lost (GV-08, GV-12 link half) and unauth_alert (GV-04, GV-10) (design 14.1 and 14.1b).
All rules are registered here. GV-04 and GV-06 a, d also run in the harness table; GV-08 and GV-12 live in this file because a silent node
also gets a co_timeout sensor_fault from P6c (see the OPEN QUESTION test), so these tests look at link effects only."""
import pytest
from test_co_state import co_frame
from test_co_threshold import Eng
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import FrameEvent, TickEvent, clear_alert

WARN, DNG, MD = 0x01, 0x02, 0x04
def fr(flags=0, bat=80, status2=0, seq_class='fresh', node=1):
    d = dict(co_frame(node=node).decoded); d.update(flags=flags, bat=bat, status2=status2)
    return FrameEvent(node, 'OK', seq_class, d)
def bad(flags=0x06, node=2, verify='BAD_MAC'):
    d = dict(co_frame(node=node).decoded); d['flags'] = flags
    return FrameEvent(node, verify, 'suspect', d)
def tys(fx, types): return [(type(x).__name__, x.type, getattr(x, 'level', None)) for x in fx if x.type in types]
LINK = ('signal_lost', 'link_lost')
def lk(fx): return tys(fx, LINK)
def al(e, t, n=1): return e.state.alerts.get((n, t))

def test_order_new_rules_sit_before_man_down_and_node_danger_stays_last():
    r = re_.RULES; assert r[-1] is re_.node_danger_rule and r[-2] is re_.man_down_rule and r.index(re_.battery_low_rule) < r.index(re_.link_rule) < len(r) - 2

# ---- battery_low (GV-06) ----
def test_GV06_a_b_c_latch_and_recharge_clear():
    e = Eng(); assert tys(e.step(fr(bat=10, status2=0x04), 0), ('battery_low',)) == [('RaiseAlert', 'battery_low', 'WARNING')] and e.state.nodes[1].level == 'WARNING'
    for bat in (12, 18, 24): assert e.step(fr(bat=bat)) == [] and al(e, 'battery_low') is not None      # (b) stays open although bat rose
    assert tys(e.step(fr(bat=25)), ('battery_low',)) == [('ClearAlert', 'battery_low', None)] and al(e, 'battery_low') is None and e.state.nodes[1].level == 'NORMAL'

def test_GV06_d_reboot_clears_the_latch():
    e = Eng(); e.step(fr(bat=10), 0); fx = e.step(fr(bat=18, seq_class='reboot'))
    assert tys(fx, ('battery_low',)) == [('ClearAlert', 'battery_low', None)] and al(e, 'battery_low') is None

def test_reboot_that_still_shows_low_battery_clears_and_reopens():
    e = Eng(); e.step(fr(bat=10), 0); old = al(e, 'battery_low').event_seq
    assert tys(e.step(fr(bat=9, seq_class='reboot')), ('battery_low',)) == [('ClearAlert', 'battery_low', None), ('RaiseAlert', 'battery_low', 'WARNING')] and al(e, 'battery_low').event_seq != old

@pytest.mark.parametrize('bat,status2,opens', [(10, 0, True), (11, 0, False), (11, 0x04, False), (0, 0, True), (80, 0x04, False)])
def test_trigger_is_percent_at_or_below_bat_warn_pct(bat, status2, opens):
    e = Eng(); e.step(fr(bat=bat, status2=status2), 0); assert (al(e, 'battery_low') is not None) == opens

def test_suspect_frame_can_open_but_never_clears_and_duplicates_are_ignored():
    e = Eng(); assert tys(e.step(fr(bat=5, seq_class='suspect'), 0), ('battery_low',)) == [('RaiseAlert', 'battery_low', 'WARNING')]
    assert e.step(fr(bat=90, seq_class='suspect')) == [] and al(e, 'battery_low') is not None
    assert e.step(fr(bat=90, seq_class='duplicate')) == [] and al(e, 'battery_low') is not None

# ---- signal_lost and link_lost (GV-08, GV-12 link half) ----
def test_GV08_a_b_c_non_adverse_node():
    e = Eng(); e.step(fr(), 0)
    assert lk(e.step(TickEvent(), 14_999)) == [] and lk(e.step(TickEvent(), 1)) == [('RaiseAlert', 'signal_lost', 'WARNING')]            # (a) T0+15 s
    assert lk(e.step(TickEvent(), 1000)) == [] and al(e, 'link_lost') is None                                                             # no repeat
    assert lk(e.step(TickEvent(), 44_000)) == [('RaiseAlert', 'link_lost', 'DANGER'), ('ClearAlert', 'signal_lost', None)]               # (b) T0+60 s
    assert al(e, 'signal_lost') is None and e.state.nodes[1].level == 'DANGER'
    assert lk(e.step(fr(), 10_000)) == [('ClearAlert', 'link_lost', None)] and al(e, 'link_lost') is None and e.state.nodes[1].level == 'NORMAL'   # (c) first fresh frame
    assert lk(e.step(fr())) == [] and lk(e.step(fr())) == []

def test_fresh_frame_clears_signal_lost():
    e = Eng(); e.step(fr(), 0); e.step(TickEvent(), 20_000); assert al(e, 'signal_lost') is not None
    assert lk(e.step(fr())) == [('ClearAlert', 'signal_lost', None)]

@pytest.mark.parametrize('flags', [WARN, DNG | 0, 0x06])
def test_adverse_last_frame_gives_link_lost_after_15_s_with_no_signal_lost(flags):
    e = Eng(); e.step(fr(flags=flags), 0)
    assert lk(e.step(TickEvent(), 14_999)) == [] and lk(e.step(TickEvent(), 1)) == [('RaiseAlert', 'link_lost', 'DANGER')] and al(e, 'signal_lost') is None

def test_GV12_a_reboot_frame_clears_link_lost():
    e = Eng(); e.step(fr(), 0); e.step(TickEvent(), 90_000); assert al(e, 'link_lost') is not None
    assert lk(e.step(fr(seq_class='reboot', status2=0x08))) == [('ClearAlert', 'link_lost', None)]

def test_GV12_c_suspect_frame_never_clears_link_lost_or_resets_the_silence_clock():
    e = Eng(); e.step(fr(), 0); e.step(TickEvent(), 90_000)
    assert e.step(fr(seq_class='suspect')) == [] and al(e, 'link_lost') is not None
    e2 = Eng(); e2.step(fr(), 0); e2.step(fr(seq_class='suspect'), 14_000)                                          # a suspect frame at 14 s does not restart the 15 s
    assert lk(e2.step(TickEvent(), 1000)) == [('RaiseAlert', 'signal_lost', 'WARNING')]

def test_node_never_heard_has_no_silence_alert_and_nodes_are_independent():
    e = Eng(); assert lk(e.step(TickEvent(), 100_000)) == []
    e.step(fr(node=2), 0); e.step(TickEvent(), 30_000); assert al(e, 'signal_lost', 2) is not None and al(e, 'signal_lost', 1) is None

def test_OPEN_QUESTION_silent_node_also_gets_co_timeout_sensor_fault():
    """Records current behaviour (P6c): a silent node passes the 5 s co_timeout on the first tick, so sensor_fault opens next to signal_lost.
    GV-08 lists only signal_lost and link_lost. If the design owner decides silence is not a CO fault, change this test with that fix."""
    e = Eng(); e.step(fr(), 0); fx = e.step(TickEvent(), 20_000)
    assert {x.type for x in fx} == {'sensor_fault', 'signal_lost'}

# ---- unauth_alert (GV-04, GV-10) ----
def test_GV04_bad_mac_claiming_man_down_raises_unauth_alert_none_and_nothing_else():
    e = Eng(); fx = e.step(bad(), 0)
    assert tys(fx, ('unauth_alert',)) == [('RaiseAlert', 'unauth_alert', 'NONE')] and len(fx) == 1 and e.state.episodes == {}
    assert e.state.nodes[2].level == 'NORMAL' and set(e.state.alerts) == {(2, 'unauth_alert')}

def test_GV10_coalesces_counts_and_a_new_card_after_acknowledge():
    e = Eng(); fx = e.step(bad(), 0) + e.step(bad(), 4000) + e.step(bad(), 4000)
    assert len(fx) == 1 and e.state.nodes[2].unauth_count == 3 and e.state.nodes[2].unauth_last_seen_ts == e.clock.wall_ms()
    e.state, _ = clear_alert(e.state, 2, 'unauth_alert', e.clock.now(), 'acknowledged')
    fx = e.step(bad(), 4000); assert tys(fx, ('unauth_alert',)) == [('RaiseAlert', 'unauth_alert', 'NONE')] and e.state.nodes[2].unauth_count == 1

@pytest.mark.parametrize('flags,raises', [(0x00, False), (0x01, True), (0x02, True), (0x04, True), (0x08, False), (0x80, False), (0x03, False)])
def test_only_a_frame_that_claims_an_alert_counts(flags, raises):
    e = Eng(); assert bool(e.step(bad(flags=flags), 0)) == raises

@pytest.mark.parametrize('ev', [bad(verify='BAD_CRC'), bad(verify='BAD_LEN'), bad(node=0), bad(node=5)])
def test_other_failures_and_non_roster_nodes_raise_nothing(ev):
    e = Eng(); assert e.step(ev, 0) == [] and e.state.alerts == {}

def test_unauth_alert_does_not_touch_a_real_node_state():
    e = Eng(); e.step(fr(flags=WARN), 0); lvl = e.state.nodes[1]; e.step(bad(node=1), 1000)
    assert e.state.nodes[1].level == lvl.level == 'WARNING' and al(e, 'unauth_alert') is not None and al(e, 'man_down') is None
`);
  replace('host/ppe_host/core/rule_engine.py', String.raw`    node_danger_streak: int = 0                      # P7-1: consecutive evaluated frames that meet the node_danger condition
`, String.raw`    node_danger_streak: int = 0                      # P7-1: consecutive evaluated frames that meet the node_danger condition (14.1)
    last_fresh_mono: Optional[int] = None            # P7-2: mono time of the last FRESH frame (silence clock of signal_lost and link_lost); suspect frames never move it
    last_fresh_adverse: bool = False                 # P7-2: that frame reported WARNING, DANGER or mandown (link_lost after link_lost_adverse_s)
    unauth_count: int = 0                            # P7-2: BAD_MAC frames counted on the open unauth_alert (WebSocket unauth_count)
    unauth_last_seen_ts: Optional[int] = None        # P7-2: wall ms of the last such frame
`);
  replace('host/ppe_host/core/rule_engine.py', String.raw`RULES = (co_state_rule, co_threshold_rule, sensor_fault_rule, man_down_rule, node_danger_rule)  # evaluation order; P7-2 and later rules go BEFORE node_danger_rule, which stays last (14.1)`, String.raw`# ---- P7-2: battery_low, signal_lost / link_lost and unauth_alert, design 14.1 rows and 14.1b. node_danger stays LAST (14.1). ----
ROSTER_IDS = (1, 2, 3)   # migration 0001: roster.node_id CHECK (node_id BETWEEN 1 AND 3)

def battery_low_rule(state, event, now, mode):
    """battery_low: bat <= bat_warn_pct (status2 bit 2 with <= 10 % is the same case). One latched WARNING per node. A fresh or suspect frame may
    open it; only a FRESH frame clears it: a reboot (boot_ctr step, seq_class reboot) or bat >= bat_recharge_clear_pct. In between it stays open
    although bat rises (GV-06 b). A reboot frame that still shows bat <= 10 % clears the old row and opens a new one."""
    if not isinstance(event, FrameEvent) or event.node_id is None or mode == NONE: return state, ()
    nid, d, fresh, fx = event.node_id, event.decoded, mode == FULL, ()
    if fresh and (event.seq_class == 'reboot' or d['bat'] >= K.BAT_RECHARGE_CLEAR_PCT):
        state, fx = clear_alert(state, nid, 'battery_low', now, 'reboot' if event.seq_class == 'reboot' else 'recharged')
    if d['bat'] <= K.BAT_WARN_PCT:
        state, more = raise_alert(state, nid, 'battery_low', 'WARNING', f"bat={d['bat']}", now); fx += more
    return refresh_level(state, nid, _bit(d, 'flags', 'node_level'), not fresh), fx

def _adverse(d):
    """A frame is adverse when it reports WARNING or DANGER or a man-down latch (the design does not define the word; open question in the handoff)."""
    return _bit(d, 'flags', 'node_level') in (abi.ENUMS['node_level']['WARNING'], abi.ENUMS['node_level']['DANGER']) or bool(_bit(d, 'flags', 'mandown'))

def link_rule(state, event, now, mode):
    """signal_lost and link_lost. The silence clock is the last FRESH frame (a suspect frame never resets it or counts towards recovery, 14.1).
    On a tick: silent for link_lost_max_s, or for link_lost_adverse_s after an adverse frame -> link_lost (DANGER) and signal_lost clears;
    silent for signal_lost_s after a non-adverse frame -> signal_lost (WARNING). A fresh frame (fresh or reboot) clears both."""
    mono = now.mono_ms
    if isinstance(event, TickEvent):
        fx = ()
        for nid, n in list(state.nodes.items()):
            if n.last_fresh_mono is None: continue
            gap = mono - n.last_fresh_mono
            if gap >= K.LINK_LOST_MAX_S * 1000 or (n.last_fresh_adverse and gap >= K.LINK_LOST_ADVERSE_S * 1000):
                state, a = raise_alert(state, nid, 'link_lost', 'DANGER', f'silent {gap // 1000} s', now)
                state, b = clear_alert(state, nid, 'signal_lost', now, 'link_lost'); fx += a + b
            elif not n.last_fresh_adverse and gap >= K.SIGNAL_LOST_S * 1000:
                state, a = raise_alert(state, nid, 'signal_lost', 'WARNING', f'silent {gap // 1000} s', now); fx += a
            state = refresh_level(state, nid, 0, True)
        return state, fx
    if not isinstance(event, FrameEvent) or event.node_id is None or mode != FULL: return state, ()
    nid, d = event.node_id, event.decoded
    state, a = clear_alert(state, nid, 'signal_lost', now, 'fresh_frame')
    state, b = clear_alert(state, nid, 'link_lost', now, 'fresh_frame')
    cur = state.nodes.get(nid, NodeState())
    state = replace(state, nodes={**state.nodes, nid: replace(cur, last_fresh_mono=mono, last_fresh_adverse=_adverse(d))})
    return refresh_level(state, nid, _bit(d, 'flags', 'node_level'), False), a + b

def unauth_alert_rule(state, event, now):
    """unauth_alert (GV-04, GV-10): a BAD_MAC frame from a roster node whose flags claim an alert (level WARNING or DANGER, or mandown). Level NONE; never
    changes a node level. At most one open row per claimed node: later frames only count (unauth_count, unauth_last_seen_ts). Acknowledge (P7c, P19)
    closes the row, so the next claim opens a new one with count 1. The shell applies the 20 per minute limit (DIAG_RATE_LIMIT_PER_MIN) before the engine."""
    d = event.decoded
    if event.verify != 'BAD_MAC' or d is None or event.node_id not in ROSTER_IDS: return state, ()
    if not (_bit(d, 'flags', 'node_level') in (abi.ENUMS['node_level']['WARNING'], abi.ENUMS['node_level']['DANGER']) or _bit(d, 'flags', 'mandown')): return state, ()
    nid, n = event.node_id, state.nodes.get(event.node_id, NodeState())
    was_open = open_alert(state, nid, 'unauth_alert') is not None
    state, fx = raise_alert(state, nid, 'unauth_alert', 'NONE', f'bad_mac {_why(d)}', now)
    n = replace(n, unauth_count=n.unauth_count + 1 if was_open else 1, unauth_last_seen_ts=now.wall_ms)
    return replace(state, nodes={**state.nodes, nid: n}), fx

RULES = (co_state_rule, co_threshold_rule, sensor_fault_rule, battery_low_rule, link_rule, man_down_rule, node_danger_rule)  # evaluation order; new rules go before man_down_rule, node_danger_rule stays last (14.1)`);
  replace('host/ppe_host/core/rule_engine.py', String.raw`        return (state, ()) if mode == NONE else _run_rules(state, event, now, mode)`, String.raw`        return (unauth_alert_rule(state, event, now) if mode == NONE else _run_rules(state, event, now, mode))   # P7-2: a BAD_MAC frame that claims an alert is the one frame outside the gate (14.1b)`);
  replace('host/tests/test_golden_vectors.py', String.raw`    {'id': 'PH-01', 'gv': 'GV-04 (partial)', 'desc': 'PLACEHOLDER, replaced in P7 by the full GV-04 (it will also raise unauth_alert): node 2 BAD_MAC frame claiming man-down opens no alert and no episode and leaves the level alone',
     'steps': [{'frame': 'F-16', 'seq_class': 'suspect', 'expect': {'effects': [], 'open': [], 'episodes': 0, 'seq_delta': 0, 'levels': {2: 'NORMAL'}}}]},`, String.raw`    {'id': 'GV-04', 'gv': 'GV-04', 'desc': 'F-16: node 2, BAD_MAC, flags 0x06 (claims man-down): raises unauth_alert NONE and nothing else; no episode, the level stays NORMAL (the diagnostic frames row and the 20 per minute limit are the writer and shell)',
     'steps': [{'frame': 'F-16', 'seq_class': 'suspect', 'expect': {'effects': [('raise', 2, 'unauth_alert', 'NONE')], 'open': [(2, 'unauth_alert', 'NONE')], 'episodes': 0, 'seq_delta': 1, 'levels': {2: 'NORMAL'}}}]},`);
  replace('host/tests/test_golden_vectors.py', String.raw`    # ---- GV cases above this line (each later Part adds its own here; P7-1 added GV-02, GV-03, GV-17) ----`, String.raw`    {'id': 'GV-06a', 'gv': 'GV-06 a', 'desc': 'F-05: bat 10 %, bat_low bit: raises battery_low WARNING (latched), node level WARNING',
     'steps': [{'frame': 'F-05', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'battery_low', 'WARNING')], 'open': [(1, 'battery_low', 'WARNING')], 'episodes': 0, 'seq_delta': 1, 'levels': {1: 'WARNING'}}}]},
    {'id': 'GV-06d', 'gv': 'GV-06 d', 'desc': 'F-05 then F-10 (reboot, boot_ctr 8, bat 80): the reboot clears battery_low',
     'steps': [{'frame': 'F-05', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'battery_low', 'WARNING')]}},
               {'frame': 'F-10', 'seq_class': 'reboot', 'dt_ms': 2000, 'expect': {'effects': [('clear', 1, 'battery_low', None)], 'open': [], 'seq_delta': 1, 'levels': {1: 'NORMAL'}}}]},
    # ---- GV cases above this line (each later Part adds its own here; P7-1 added GV-02, GV-03, GV-17; P7-2 added GV-04, GV-06 a and d (GV-08, GV-10 and GV-12 are in test_link_battery.py)) ----`);
  replace('host/tests/test_rule_engine_core.py', String.raw`    for e in (ev(), ev('OK', 'suspect'), ev('BAD_MAC'), TickEvent()):`, String.raw`    for e in (ev(), ev('OK', 'suspect'), ev('BAD_MAC', flags=0), TickEvent()):   # P7-2: a BAD_MAC frame that claims an alert reaches unauth_alert_rule, so this one claims nothing`);
  replace('host/tests/test_rule_engine_core.py', String.raw`calls.clear(); s, fx = step(EngineState(), ev('BAD_MAC'), T0); assert calls == [] and fx == ()   # the gate runs before any rule`, String.raw`calls.clear(); s, fx = step(EngineState(), ev('BAD_MAC', flags=0), T0); assert calls == [] and fx == ()   # the gate runs before any rule (flags=0: claims nothing, see unauth_alert_rule)`);
  replace('host/tests/test_man_down.py', String.raw`def test_any_open_danger_row_blocks_it_but_a_warning_row_does_not(typ):
`, String.raw`def test_any_open_danger_row_blocks_it_but_a_warning_row_does_not(typ, monkeypatch):
    monkeypatch.setattr(re_, 'RULES', tuple(r for r in re_.RULES if r is not re_.link_rule))   # P7-2: a fresh frame clears a seeded link_lost; this test is about node_danger alone
`);
  replace('host/tests/test_sensor_fault.py', String.raw`def test_co_timeout_raises_sensor_fault_on_a_tick(tick_gap_ms, level):
`, String.raw`def test_co_timeout_raises_sensor_fault_on_a_tick(tick_gap_ms, level, monkeypatch):
    monkeypatch.setattr(re_, 'RULES', tuple(r for r in re_.RULES if r is not re_.link_rule))   # P7-2: after 60 s of silence link_lost also opens; this test is about the sensor_fault level
`);
  append('docs/PROGRESS.md', String.raw`- Part 7-2 done: battery_low (latch, clears on reboot or bat >= 25), signal_lost and link_lost (tick-driven silence rules, fresh frame clears) and unauth_alert (BAD_MAC claiming an alert, coalesced per node) in core/rule_engine.py, GV-04 and GV-06 a, d in the harness, host/tests/test_link_battery.py (GV-08, GV-10, GV-12 link half)`);
}
