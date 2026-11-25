// patches/part07b_notices.mjs  (run from repo root: node patches/part07_2_battery_link_unauth.mjs [--dry] [--force])
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
  const RE = 'host/ppe_host/core/rule_engine.py';
  put('host/tests/test_notices.py', String.raw`"""P7b: notice and badge types of design 14.1b (all level NONE): wrist_open / wrist_close (GV-21), button_stuck (GV-22), missed_event and
watchdog_recovery (GV-23), latch_restored and watchdog_recovery (GV-26), co_warmup (GV-27), node_reboot; weak_signal and estimate disabled.
The GV-21 to GV-27 vectors are field-level (no frames.json entry), so they run here, not in the harness table. Frames are built from F-01."""
import pytest
from test_co_state import co_frame
from test_co_threshold import Eng
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import ClearAlert, EngineState, FrameEvent, RaiseAlert, TickEvent

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
`);
  replace(RE, '    raised_ts: int\n\n@dataclass(frozen=True)\nclass ClearAlert(Effect):', '    raised_ts: int\n    one_shot: bool = False        # P7b: a one-shot notice is stored already closed (cleared_ts = raised_ts) and never held in EngineState.alerts (14.1b)\n\n@dataclass(frozen=True)\nclass ClearAlert(Effect):');
  replace(RE, '# P7-2: wall ms of the last such frame\n\n@dataclass(frozen=True)\nclass EngineState:', '# P7-2: wall ms of the last such frame\n' +
    '    wrist_open_since_mono: Optional[int] = None      # P7b: first fresh frame of the current run with status4 bit 0 (wrist connector open)\n' +
    '    wrist_last_open_mono: Optional[int] = None       # P7b: last fresh frame with that bit set (wrist_close_confirm_s counts from it)\n' +
    '    latch_restored_prev: Optional[bool] = None       # P7b: status4 bit 1 of the last fresh frame (None = never seen: a first-seen 1 is an edge)\n' +
    '    restored_prev: Optional[bool] = None             # P7b: status3 bit 4 of the last fresh frame\n' +
    '    evt_unsent_prev: Optional[bool] = None           # P7b: id_mode bit 7 of the last fresh frame\n' +
    '\n@dataclass(frozen=True)\nclass EngineState:');
  replace(RE, 'RULES = (co_state_rule, co_threshold_rule, sensor_fault_rule, battery_low_rule, link_rule, man_down_rule, node_danger_rule)', String.raw`# ---- P7b: notice and badge types, design 14.1b. All level NONE: they never change a node level or open an episode. Evaluated on FRESH verified
# frames only (a suspect frame neither raises nor ends one). Persistent: wrist_open, button_stuck, missed_event, co_warmup (one open row per node,
# cleared when the condition ends). One-shot: wrist_close, node_reboot, latch_restored, watchdog_recovery (RaiseAlert.one_shot, never held in state.alerts,
# so the writer inserts the row with cleared_ts = raised_ts and no open-alert query returns it). weak_signal and estimate stay disabled. ----
WEAK_SIGNAL_ENABLED = False  # settings.json weak_signal_enabled is false too: needs the range-test floors (Section 9, item 10)
ESTIMATE_ENABLED = False     # Tier 2 only (forecast_5min_ppm); nothing in the Tier 1 engine raises it

def raise_notice(state, node_id, type, reasons, now):
    """One-shot notice: allocate an event_seq and emit a RaiseAlert flagged one_shot. Nothing is stored in state.alerts."""
    _check_alert(node_id, type, 'NONE')
    state, seq = next_seq(state)
    return state, (RaiseAlert(seq, node_id, type, 'NONE', reasons, now.wall_ms, one_shot=True),)

def notice_rule(state, event, now, mode):
    if not isinstance(event, FrameEvent) or event.node_id is None or mode != FULL: return state, ()
    nid, d, mono, fx = event.node_id, event.decoded, now.mono_ms, ()
    n = state.nodes.get(nid, NodeState())
    on = lambda f, b: bool(_bit(d, f, b))
    for typ, cond in (('button_stuck', on('status3', 'btn_stuck')), ('missed_event', on('id_mode', 'evt_unsent')), ('co_warmup', on('status3', 'co_warmup'))):
        state, more = raise_alert(state, nid, typ, 'NONE', _why(d), now) if cond else clear_alert(state, nid, typ, now, 'condition_ended'); fx += more
    # wrist: bit held for wrist_open_ms across frames raises wrist_open; back to 0 within wrist_close_confirm_s of the last open frame logs wrist_close
    since, last = n.wrist_open_since_mono, n.wrist_last_open_mono
    if on('status4', 'wrist_conn_open'):
        since, last = (mono if since is None else since), mono
        if mono - since >= K.WRIST_OPEN_MS: state, more = raise_alert(state, nid, 'wrist_open', 'NONE', _why(d), now); fx += more
    else:
        if open_alert(state, nid, 'wrist_open') is not None:
            state, more = clear_alert(state, nid, 'wrist_open', now, 'wrist_closed'); fx += more
            if last is not None and mono - last <= K.WRIST_CLOSE_CONFIRM_S * 1000: state, more = raise_notice(state, nid, 'wrist_close', _why(d), now); fx += more
        since = last = None
    md_open = open_alert(state, nid, 'man_down') is not None
    if event.seq_class == 'reboot':
        state, more = raise_notice(state, nid, 'node_reboot', f"boot_ctr={d['boot_ctr']}" + (' while_man_down' if md_open else ''), now); fx += more
    latch, restored, evt = on('status4', 'latch_restored'), on('status3', 'restored'), on('id_mode', 'evt_unsent')
    if latch and not n.latch_restored_prev: state, more = raise_notice(state, nid, 'latch_restored', _why(d), now); fx += more
    why = 'restored_after_reset' if restored and not n.restored_prev else 'uplink_recovered' if n.evt_unsent_prev and not evt else None   # bit 4 0->1, or evt_unsent 1->0
    if why: state, more = raise_notice(state, nid, 'watchdog_recovery', why + f" cause={_bit(d, 'status3', 'reset_cause')}", now); fx += more
    cur = state.nodes.get(nid, n)
    n2 = replace(cur, wrist_open_since_mono=since, wrist_last_open_mono=last, latch_restored_prev=latch, restored_prev=restored, evt_unsent_prev=evt)
    return (state if cur == n2 and nid in state.nodes else replace(state, nodes={**state.nodes, nid: n2})), fx

RULES = (co_state_rule, co_threshold_rule, sensor_fault_rule, battery_low_rule, link_rule, notice_rule, man_down_rule, node_danger_rule)`);
  replace('host/tests/test_golden_vectors.py', "{'frame': 'F-10', 'seq_class': 'reboot', 'dt_ms': 2000, 'expect': {'effects': [('clear', 1, 'battery_low', None)], 'open': [], 'seq_delta': 1, 'levels': {1: 'NORMAL'}}}]},", "{'frame': 'F-10', 'seq_class': 'reboot', 'dt_ms': 2000, 'expect': {'effects': [('clear', 1, 'battery_low', None), ('raise', 1, 'node_reboot', 'NONE')], 'open': [], 'seq_delta': 2, 'levels': {1: 'NORMAL'}}}]},   # P7b: the reboot frame also logs the one-shot node_reboot notice (14.1b)");
  append('docs/PROGRESS.md', '- Part 7b done: notice and badge types of 14.1b in core/rule_engine.py (notice_rule: wrist_open/wrist_close, button_stuck, missed_event, co_warmup persistent; node_reboot, latch_restored, watchdog_recovery, wrist_close one-shot via RaiseAlert.one_shot; weak_signal and estimate disabled flags), host/tests/test_notices.py (GV-21, GV-22, GV-23, GV-26, GV-27 field-level); harness GV-06d now also expects the node_reboot notice');;
}
