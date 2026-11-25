// patches/part07c2_checkin_scba.mjs  (run from repo root: node patches/part07c2_checkin_scba.mjs [--dry] [--force])
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
  const RE = 'host/ppe_host/core/rule_engine.py', GV = 'host/tests/test_golden_vectors.py', MD_T = 'host/tests/test_man_down.py';
  put('host/tests/test_checkin_scba.py', String.raw`"""P7c-2: checkin and scba_expired (design 14.1 rows; GV-05 a to d, GV-24 a to c). Frames are built from co_frame; flags, status2, status3 and CO are set per test."""
import pytest
from test_co_state import co_frame
from test_co_threshold import Eng
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import AckAlertEvent, ClearAlert, FrameEvent, RaiseAlert, ChangeAlertLevel, TickEvent

CI, CI_FALL, MD, CI_MD = 0x81, 0xC0, 0x06, 0x86         # flags: check-in + WARNING, check-in + fall suspected (level NORMAL), man-down + DANGER, both (0x87 would be node_level 3 = INVALID, never evaluated)
EXP, CO_FAULT = 0x08, 0x10                   # status3 bit 3, status2 bit 4
def cf(flags=0, status3=0, co=0, status2=0, seq_class='fresh', temp=2500, node=1):
    d = dict(co_frame(co_x10=co, temp_x100=temp, status2=status2, status3=status3, node=node).decoded); d.update(flags=flags)
    return FrameEvent(node, 'OK', seq_class, d)
def nm(fx): return [(type(x).__name__, getattr(x, 'type', None), getattr(x, 'level', None)) for x in fx]
def sc(fx): return [t for t in nm(fx) if t[1] == 'scba_expired']      # co_threshold runs on the same frames and has its own effects
def al(e, t, n=1): return e.state.alerts.get((n, t))
def lvl(e): return e.state.nodes[1].level

def test_rule_order_checkin_and_scba_run_before_the_notices_and_man_down_and_node_danger_stays_last():
    r = re_.RULES
    assert r.index(re_.link_rule) < r.index(re_.checkin_rule) < r.index(re_.scba_expired_rule) < r.index(re_.notice_rule) < r.index(re_.man_down_rule) and r[-1] is re_.node_danger_rule

# ---- checkin (GV-05) ----
def test_GV05a_a_check_in_bit_raises_checkin_at_warning_with_no_episode():
    e = Eng(); fx = e.step(cf(CI)); assert nm(fx) == [('RaiseAlert', 'checkin', 'WARNING')] and lvl(e) == 'WARNING' and e.state.episodes == {}
    assert e.step(cf(CI)) == [] and e.step(cf(CI)) == []                       # held: no second row

def test_GV05b_the_next_frame_with_bit_7_at_0_clears_the_row():
    e = Eng(); e.step(cf(CI)); fx = e.step(cf(0)); assert nm(fx) == [('ClearAlert', 'checkin', None)] and fx[0].reason == 'jacket_cancel' and al(e, 'checkin') is None and lvl(e) == 'NORMAL'

def test_GV05c_a_fall_only_prompt_is_a_notice_at_level_none_and_never_a_node_level():
    e = Eng(); fx = e.step(cf(CI_FALL)); assert nm(fx) == [('RaiseAlert', 'checkin', 'NONE')] and 'fall_prompt' in fx[0].reasons
    assert lvl(e) == 'NORMAL' and e.state.episodes == {} and e.step(cf(0))[0].reason == 'jacket_cancel'

def test_GV05d_man_down_opens_its_episode_and_the_check_in_row_clears():
    e = Eng(); e.step(cf(CI)); fx = e.step(cf(MD))
    assert nm(fx) == [('ClearAlert', 'checkin', None), ('EpisodeOpened', None, None), ('RaiseAlert', 'man_down', 'DANGER')] and len(e.state.episodes) == 1 and al(e, 'checkin') is None

def test_a_frame_with_check_in_and_mandown_together_opens_no_checkin_and_clears_an_open_one():
    e = Eng(); assert [t for t, *_ in nm(e.step(cf(CI_MD)))] == ['EpisodeOpened', 'RaiseAlert'] and al(e, 'checkin') is None
    e = Eng(); e.step(cf(CI)); fx = e.step(cf(CI_MD)); assert fx[0].reason == 'man_down_opened' and al(e, 'checkin') is None
    assert e.step(cf(CI_MD)) == []                                            # the bit stays set: no edge, nothing reopens

def test_a_new_rising_edge_after_the_clear_opens_a_new_row():
    e = Eng(); e.step(cf(CI)); first = al(e, 'checkin').event_seq; e.step(cf(0)); e.step(cf(CI)); assert al(e, 'checkin').event_seq > first

def test_acknowledge_never_closes_a_checkin():
    e = Eng(); e.step(cf(CI)); fx = e.step(AckAlertEvent(1, 'checkin', 7), 0); assert [type(x).__name__ for x in fx] == ['AlertAcknowledged'] and al(e, 'checkin').acknowledged_ts is not None

def test_a_suspect_frame_may_open_a_checkin_but_never_clears_it_or_moves_the_edge_memory():
    e = Eng(); assert nm(e.step(cf(CI, seq_class='suspect'))) == [('RaiseAlert', 'checkin', 'WARNING')]
    assert e.step(cf(0, seq_class='suspect')) == [] and al(e, 'checkin') is not None   # raise-only: no clear
    assert e.step(cf(CI)) == [] and len([1 for _ in e.state.alerts]) == 1               # the fresh frame finds the row open: no duplicate
    assert e.step(cf(0))[0].reason == 'jacket_cancel'

def test_a_duplicate_or_failed_frame_changes_nothing():
    e = Eng(); assert e.step(cf(CI, seq_class='duplicate')) == [] and al(e, 'checkin') is None
    d = cf(CI).decoded; assert e.step(FrameEvent(1, 'BAD_CRC', 'fresh', d)) == []

def test_after_a_restart_with_the_row_open_a_held_bit_adds_nothing():
    e = Eng(); e.step(cf(CI)); e.state = re_.EngineState(event_seq=e.state.event_seq, alerts=dict(e.state.alerts))   # node memory gone, open rows rebuilt
    assert e.step(cf(CI)) == [] and len(e.state.alerts) == 1

# ---- scba_expired (GV-24) ----
def test_GV24_a_b_c_warning_then_dangers_in_place_then_clears_and_no_episode():
    e = Eng(); fx = e.step(cf(0x01, EXP, co=200)); assert nm(fx) == [('RaiseAlert', 'scba_expired', 'WARNING')] and lvl(e) == 'WARNING'
    seq = al(e, 'scba_expired').event_seq; e.step(AckAlertEvent(1, 'scba_expired', 7), 0)
    fx = e.step(cf(0x02, EXP, co=400)); assert nm(fx) == [('RaiseAlert', 'co_threshold', 'WARNING'), ('ChangeAlertLevel', 'scba_expired', 'DANGER')]
    r = al(e, 'scba_expired'); assert r.event_seq == seq and r.level == 'DANGER' and r.acknowledged_ts is None and al(e, 'node_danger') is None and lvl(e) == 'DANGER'
    fx = e.step(cf(0x02, 0, co=400)); assert ('ClearAlert', 'scba_expired', None) in nm(fx) and al(e, 'scba_expired') is None and e.state.episodes == {}

def test_it_opens_straight_at_danger_when_a_usable_reading_is_at_35_ppm_or_more():
    e = Eng(); assert nm(e.step(cf(0x02, EXP, co=350)))[-1] == ('RaiseAlert', 'scba_expired', 'DANGER')
    e = Eng(); assert nm(e.step(cf(0x01, EXP, co=349)))[-1] == ('RaiseAlert', 'scba_expired', 'WARNING')

def test_a_co_fault_frame_has_no_reading_so_it_never_escalates_or_opens_at_danger():
    e = Eng(); assert nm(e.step(cf(0x09, EXP, co=400, status2=CO_FAULT)))[-1] == ('RaiseAlert', 'scba_expired', 'WARNING')

def test_danger_lowers_to_warning_in_place_after_10_s_below_31_5_and_keeps_the_acknowledgement():
    e = Eng(); e.step(cf(0x02, EXP, co=400)); e.step(AckAlertEvent(1, 'scba_expired', 7), 0); ack = al(e, 'scba_expired').acknowledged_ts
    e.step(cf(0x01, EXP, co=300), 0)                                            # 30.0 ppm: the 10 s run starts here
    assert sc(e.step(cf(0x01, EXP, co=300), 9999)) == [] and al(e, 'scba_expired').level == 'DANGER'
    fx = e.step(cf(0x01, EXP, co=300), 1); assert sc(fx) == [('ChangeAlertLevel', 'scba_expired', 'WARNING')] and [x for x in fx if isinstance(x, ChangeAlertLevel)][0].acknowledged_reset is False
    assert al(e, 'scba_expired').acknowledged_ts == ack and e.state.nodes[1].scba_lower_since_mono is None

def test_a_reading_at_or_above_31_5_resets_the_lowering_run():
    e = Eng(); e.step(cf(0x02, EXP, co=400)); e.step(cf(0x01, EXP, co=300), 0); e.step(cf(0x01, EXP, co=315), 9000)
    assert sc(e.step(cf(0x01, EXP, co=300), 1000)) == [] and sc(e.step(cf(0x01, EXP, co=300), 9999)) == [] and al(e, 'scba_expired').level == 'DANGER'
    assert sc(e.step(cf(0x01, EXP, co=300), 1)) == [('ChangeAlertLevel', 'scba_expired', 'WARNING')]

def test_the_lowering_timer_does_not_run_while_co_is_held_by_the_range_limit():
    e = Eng(); e.step(cf(0x02, EXP, co=400))
    for _ in range(8): e.step(cf(0x01, EXP, co=200, temp=5600))                 # 56 C: co_range active, readings held for the 14.2 rules
    assert al(e, 'scba_expired').level == 'DANGER' and e.state.nodes[1].scba_lower_since_mono is None

def test_the_row_clears_only_on_a_fresh_frame_with_the_bit_at_0():
    e = Eng(); e.step(cf(0x01, EXP, co=100)); assert e.step(cf(0x00, 0, co=100, seq_class='suspect')) == [] and al(e, 'scba_expired') is not None
    assert e.step(cf(0x00, EXP, co=100)) == []                                  # bit still set
    assert nm(e.step(cf(0x00, 0, co=100))) == [('ClearAlert', 'scba_expired', None)]

def test_a_suspect_frame_may_open_and_escalate_but_never_lowers_or_moves_the_timer():
    e = Eng(); assert sc(e.step(cf(0x01, EXP, co=100, seq_class='suspect'))) == [('RaiseAlert', 'scba_expired', 'WARNING')]
    assert sc(e.step(cf(0x02, EXP, co=400, seq_class='suspect'))) == [('ChangeAlertLevel', 'scba_expired', 'DANGER')]
    for _ in range(8): e.step(cf(0x01, EXP, co=100, seq_class='suspect'), 2000)
    assert al(e, 'scba_expired').level == 'DANGER' and e.state.nodes[1].scba_lower_since_mono is None

def test_a_warning_row_never_escalates_on_a_held_or_missing_reading_and_acknowledge_never_closes_it():
    e = Eng(); e.step(cf(0x01, EXP, co=100)); e.step(cf(0x01, EXP, co=400, status2=CO_FAULT))
    assert al(e, 'scba_expired').level == 'WARNING'
    fx = e.step(AckAlertEvent(1, 'scba_expired', 7), 0); assert [type(x).__name__ for x in fx] == ['AlertAcknowledged'] and al(e, 'scba_expired') is not None

def test_scba_expired_is_per_node_and_opens_no_episode_at_any_step():
    e = Eng(); e.step(cf(0x01, EXP, co=100, node=2)); assert (2, 'scba_expired') in e.state.alerts and (1, 'scba_expired') not in e.state.alerts and e.state.episodes == {}
`);
  replace(RE, String.raw`last fresh frame

@dataclass(frozen=True)
class EngineState:`, String.raw`last fresh frame
    checkin_prev: Optional[bool] = None              # P7c-2: flags bit 7 (check-in) of the last fresh frame (None = never seen: a first-seen 1 is an edge)
    scba_lower_since_mono: Optional[int] = None      # P7c-2: first fresh frame of the current run below co_warn_clear_ppm on a DANGER scba_expired (10 s lowering timer)

@dataclass(frozen=True)
class EngineState:`);
  replace(RE, String.raw`RULES = (co_state_rule, co_threshold_rule, sensor_fault_rule, battery_low_rule, link_rule, notice_rule, man_down_rule, node_danger_rule)`, String.raw`# ---- P7c-2: checkin and scba_expired, design 14.1 rows. Both may open (or, for scba_expired, escalate) on a suspect frame; neither clears, lowers or moves a timer
# on one (14.1). They run before notice_rule and man_down_rule (man_down_rule opens the episode that ends a check-in) and node_danger_rule stays LAST. ----
def checkin_rule(state, event, now, mode):
    """checkin: node-originated, the host times nothing. Opens on flags bit 7 (check-in) 0->1 or a first-seen 1 (edge against the last FRESH frame, so a suspect frame
    cannot move it): WARNING for a stillness prompt, NONE (a notice, no sound) for a fall-only prompt (activity FALL_SUSPECTED). No episode. A frame that already shows
    mandown does not open one: man_down owns it. Clears on a fresh frame with bit 7 = 0 (jacket CANCEL or movement) or with mandown = 1 (man_down opened)."""
    if not isinstance(event, FrameEvent) or event.node_id is None or mode == NONE: return state, ()
    nid, d, fresh, fx = event.node_id, event.decoded, mode == FULL, ()
    n = state.nodes.get(nid, NodeState())
    ci, md = bool(_bit(d, 'flags', 'checkin')), bool(_bit(d, 'flags', 'mandown'))
    if fresh and (not ci or md): state, fx = clear_alert(state, nid, 'checkin', now, 'man_down_opened' if md else 'jacket_cancel')
    elif ci and not md and not n.checkin_prev:
        fall = _bit(d, 'flags', 'activity') == abi.ENUMS['activity']['FALL_SUSPECTED']
        state, fx = raise_alert(state, nid, 'checkin', 'NONE' if fall else 'WARNING', _why(d) + (' fall_prompt' if fall else ''), now)
    cur = state.nodes.get(nid, n)
    if fresh and (cur.checkin_prev != ci or nid not in state.nodes): state = replace(state, nodes={**state.nodes, nid: replace(cur, checkin_prev=ci)})
    return refresh_level(state, nid, _bit(d, 'flags', 'node_level'), not fresh), fx

def scba_expired_rule(state, event, now, mode):
    """scba_expired: level-driven by status3 bit 3 (node SCBA timer expired). Opens at WARNING, or at DANGER when a usable CO reading is at co_warn_ppm or more; a
    WARNING escalates to DANGER in place (acknowledged_ts = NULL); DANGER returns to WARNING in place (acknowledged_ts kept) after co_hysteresis_s of continuous
    readings below co_warn_clear_ppm. The reading counts as in co_threshold: a CO fault or timeout has none, and the lowering timer runs only while CO is not held.
    The CO reading counts whatever the SCBA ON bit says: the timer has expired. Clears on a FRESH frame with the bit at 0. No episode."""
    if not isinstance(event, FrameEvent) or event.node_id is None or mode == NONE: return state, ()
    nid, d, mono, fresh, fx = event.node_id, event.decoded, now.mono_ms, mode == FULL, ()
    n = state.nodes.get(nid, NodeState())
    ppm = d['co_x10'] / 10
    usable = n.co_mode != CO_NO_READING_HELD if fresh else not _bit(d, 'status2', 'co_fault')
    why, lower = f'status3 bit 3 set co_ppm={min(ppm, K.CO_CLAMP_MAX_PPM):.1f}', n.scba_lower_since_mono
    if _bit(d, 'status3', 'scba_expired'):
        want = 'DANGER' if usable and ppm >= K.CO_WARN_PPM else 'WARNING'
        row = open_alert(state, nid, 'scba_expired')
        if row is None: state, fx = raise_alert(state, nid, 'scba_expired', want, why, now)
        elif want == 'DANGER' and row.level == 'WARNING': state, fx = set_alert_level(state, nid, 'scba_expired', 'DANGER', why, now)
        if fresh:                    # a suspect frame never lowers or moves the timer (14.1)
            row = open_alert(state, nid, 'scba_expired')
            if row is None or not usable or n.co_mode != CO_USABLE or n.co_hold_ended: lower = None
            else:
                lower = (mono if lower is None else lower) if row.level == 'DANGER' and ppm < K.CO_WARN_CLEAR_PPM else None
                if lower is not None and mono - lower >= K.CO_HYSTERESIS_S * 1000:
                    state, more = set_alert_level(state, nid, 'scba_expired', 'WARNING', why, now); fx += more; lower = None
    elif fresh:
        state, fx = clear_alert(state, nid, 'scba_expired', now, 'bit_cleared'); lower = None
    cur = state.nodes.get(nid, n)
    if cur.scba_lower_since_mono != lower or nid not in state.nodes: state = replace(state, nodes={**state.nodes, nid: replace(cur, scba_lower_since_mono=lower)})
    return refresh_level(state, nid, _bit(d, 'flags', 'node_level'), not fresh), fx

RULES = (co_state_rule, co_threshold_rule, sensor_fault_rule, battery_low_rule, link_rule, checkin_rule, scba_expired_rule, notice_rule, man_down_rule, node_danger_rule)`);
  replace(GV, String.raw`    # ---- GV cases above this line (each later Part adds its own here; P7-1 added`, String.raw`    {'id': 'GV-05a', 'gv': 'GV-05 a, b', 'desc': 'F-04: check-in bit 7 + WARNING raises checkin WARNING (0 episodes, level WARNING); the next frame with bit 7 at 0 clears it (level NORMAL)',
     'steps': [{'frame': 'F-04', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'checkin', 'WARNING')], 'open': [(1, 'checkin', 'WARNING')], 'episodes': 0, 'seq_delta': 1, 'levels': {1: 'WARNING'}}},
               {'frame': 'F-08', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('clear', 1, 'checkin', None)], 'open': [], 'episodes': 0, 'seq_delta': 1, 'levels': {1: 'NORMAL'}}}]},
    {'id': 'GV-05d', 'gv': 'GV-05 d', 'desc': 'F-02 (man-down) with an open checkin: opens the MAN_DOWN episode, raises man_down DANGER and clears the checkin row',
     'open': [(1, 'checkin', 'WARNING')],
     'steps': [{'frame': 'F-02', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('clear', 1, 'checkin', None), ('EpisodeOpened', 1, None, None), ('raise', 1, 'man_down', 'DANGER')], 'open': [(1, 'man_down', 'DANGER')], 'episodes': 1, 'seq_delta': 3, 'levels': {1: 'DANGER'}}}]},
    # ---- GV cases above this line (each later Part adds its own here; P7c-2 added GV-05 a, b and d (GV-05 c and GV-24 are field-level, in test_checkin_scba.py); P7-1 added`);
  replace(MD_T, String.raw`if r is not re_.link_rule))   # P7-2: a fresh frame clears a seeded link_lost; this test is`, String.raw`if r not in (re_.link_rule, re_.scba_expired_rule)))   # P7-2: a fresh frame clears a seeded link_lost; P7c-2: one without status3 bit 3 clears a seeded scba_expired; this test is`);
  append('docs/PROGRESS.md', "- Part 7c-2 done: checkin (node-originated, flags bit 7 edge, WARNING for a stillness prompt and NONE for a fall-only prompt, clears on bit 0 or when man_down opens) and scba_expired (status3 bit 3, WARNING or DANGER by CO, in-place escalation and 10 s lowering) in core/rule_engine.py, GV-05 a, b, d in the harness, host/tests/test_checkin_scba.py (GV-05 c, GV-24 a to c)");
}
