// patches/part07c3_heat_shadow.mjs  (run from repo root: node patches/part07c3_heat_shadow.mjs [--dry] [--force])
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
  put('host/tests/test_heat_shadow.py', String.raw`"""P7c-3: heat (design 14.1 row, 14.2 (4), Summary D5 test values) and the shadow estimator with shadow_notice (14.1b, 14.2 (5)): GV-16 a to c, GV-25.
Frames come from co_frame; temperature, motion, flags and status bytes are set per test. Frames are 2 s apart unless a test says otherwise."""
import pytest
from test_co_state import co_frame
from test_co_threshold import Eng
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import AckAlertEvent, FrameEvent, ResolveEpisodeEvent, TickEvent

TF, IMU = 0x40, 0x20                      # status2 bit 6 (temperature fault), bit 5 (IMU fault)
def hf(temp=2500, flags=0, status2=0, motion=20, seq_class='fresh', node=1):
    d = dict(co_frame(co_x10=0, temp_x100=temp, status2=status2, node=node).decoded); d.update(flags=flags, motion_x100=motion)
    return FrameEvent(node, 'OK', seq_class, d)
def al(e, t, n=1): return e.state.alerts.get((n, t))
def kinds(fx): return [(type(x).__name__, getattr(x, 'type', None), getattr(x, 'level', None)) for x in fx]
def heat(fx): return [k for k in kinds(fx) if k[1] == 'heat']
def feed(e, temp, secs, step=2, **kw):
    """Send frames at a fixed spacing for 'secs' seconds (first frame after one step); returns all effects."""
    out = []
    for _ in range(secs // step): out += e.step(hf(temp, **kw), step * 1000)
    return out
def motionless(e, secs, **kw): return feed(e, 2500, secs, **kw)

def test_rule_order_heat_and_shadow_run_before_link_rule_and_node_danger_stays_last():
    r = re_.RULES; assert r.index(re_.battery_low_rule) < r.index(re_.heat_rule) < r.index(re_.shadow_rule) < r.index(re_.link_rule) and r[-1] is re_.node_danger_rule

# ---- heat: Summary D5 test values ----
def test_60C_for_119_s_raises_nothing_and_for_121_s_raises_heat_warning():
    e = Eng(); e.step(hf(6000), 0); assert feed(e, 6000, 118) == [] and e.step(hf(6000), 1000) == [] and al(e, 'heat') is None            # 119 s
    fx = e.step(hf(6000), 2000); assert heat(fx) == [('RaiseAlert', 'heat', 'WARNING')] and e.state.nodes[1].level == 'WARNING' and e.state.episodes == {}   # 121 s

def test_a_reading_below_60C_restarts_the_120_s_run():
    e = Eng(); e.step(hf(6000), 0); feed(e, 6000, 100); e.step(hf(5999), 2000); e.step(hf(6000), 2000)
    assert feed(e, 6000, 116) == [] and al(e, 'heat') is None and heat(feed(e, 6000, 4)) == [('RaiseAlert', 'heat', 'WARNING')]

def ramp(e, secs, rise_c, start=2500, step=5):
    n = secs // step; out = []
    e.step(hf(start), 0)
    for i in range(1, n + 1): out += e.step(hf(start + round(i * rise_c * 100 / n)), step * 1000)
    return out

def test_a_20C_rise_in_25_s_raises_heat_and_in_35_s_does_not():
    e = Eng(); assert heat(ramp(e, 25, 20)) == [('RaiseAlert', 'heat', 'WARNING')] and 'rise' in al(e, 'heat').reasons
    e = Eng(); assert ramp(e, 35, 20) == [] and al(e, 'heat') is None

def test_a_rise_row_clears_10_s_after_the_30_s_rise_drops_under_15_C_and_temp_is_under_55_C():
    e = Eng(); ramp(e, 25, 20); assert al(e, 'heat') is not None; since = None; cleared_at = None
    for _ in range(60):
        e.step(hf(4500), 2000); n = e.state.nodes[1]
        if since is None and n.heat_clear_since_mono is not None: since = n.heat_clear_since_mono
        if al(e, 'heat') is None: cleared_at = e.clock.mono_ms(); break
    assert since is not None and cleared_at - since == 10000

def test_a_time_row_clears_after_10_s_below_55C_and_holds_between_55_and_60():
    e = Eng(); e.step(hf(6000), 0); feed(e, 6000, 122); assert al(e, 'heat') is not None
    feed(e, 5700, 30); assert al(e, 'heat') is not None and e.state.nodes[1].heat_clear_since_mono is None
    e.step(hf(5400), 2000); e.step(hf(5400), 7000); assert al(e, 'heat') is not None            # 7 s of the 10 s
    assert heat(e.step(hf(5400), 2999)) == [] and heat(e.step(hf(5400), 1)) == [('ClearAlert', 'heat', None)]

def test_100C_for_9_s_raises_nothing_and_for_11_s_raises_heat_warning_never_danger():
    e = Eng(); e.step(hf(10000), 0); assert feed(e, 10000, 8) == [] and e.step(hf(10000), 1000) == [] and al(e, 'heat') is None
    fx = e.step(hf(10000), 2000); assert heat(fx) == [('RaiseAlert', 'heat', 'WARNING')] and 'extreme' in al(e, 'heat').reasons
    feed(e, 10000, 300); assert al(e, 'heat').level == 'WARNING' and not any(isinstance(x, re_.ChangeAlertLevel) for x in feed(e, 10000, 20))

def test_an_extreme_row_clears_below_95C_after_10_s():
    e = Eng(); e.step(hf(10000), 0); feed(e, 10000, 12); feed(e, 9600, 20); assert al(e, 'heat') is not None
    assert heat(feed(e, 9400, 10)) == [] and heat(e.step(hf(9400), 2000)) == [('ClearAlert', 'heat', None)]

def test_a_temperature_fault_freezes_heat_holds_an_open_row_and_restarts_the_timers():
    e = Eng(); e.step(hf(6000), 0); feed(e, 6000, 122); seq = al(e, 'heat').event_seq
    assert heat(feed(e, 2000, 60, status2=TF)) == [] and al(e, 'heat').event_seq == seq        # held although the (faulted) reading is 20 C
    assert e.state.nodes[1].heat_clear_since_mono is None
    e.step(hf(2000), 2000); assert al(e, 'heat') is not None and e.state.nodes[1].heat_clear_since_mono is None   # the first frame after the fault is not evaluated
    e.step(hf(2000), 2000); assert e.state.nodes[1].heat_clear_since_mono is not None

def test_no_heat_row_is_raised_while_the_temperature_sensor_is_faulted_and_a_run_restarts_after_it():
    e = Eng(); e.step(hf(6500, status2=TF), 0); assert not [k for k in kinds(feed(e, 6500, 300, status2=TF)) if k[1] == 'heat']
    e.step(hf(6500), 2000)                                                                           # skipped frame
    e.step(hf(6500), 2000); assert feed(e, 6500, 116) == [] and heat(feed(e, 6500, 6)) == [('RaiseAlert', 'heat', 'WARNING')]

def test_a_suspect_frame_never_starts_or_advances_a_heat_timer():
    e = Eng(); e.step(hf(6000, seq_class='suspect'), 0)
    for _ in range(80): e.step(hf(6000, seq_class='suspect'))
    assert al(e, 'heat') is None and e.state.nodes[1].heat_hot_since_mono is None
    e.step(hf(6000), 0); feed(e, 6000, 100); assert e.step(hf(6000, seq_class='suspect'), 60000) == [] and al(e, 'heat') is None

def test_acknowledge_never_closes_a_heat_row_and_last_heat_alert_mono_follows_the_open_row():
    e = Eng(); e.step(hf(6000), 0); feed(e, 6000, 122); fx = e.step(AckAlertEvent(1, 'heat', 7), 0); assert [type(x).__name__ for x in fx] == ['AlertAcknowledged'] and al(e, 'heat') is not None
    e.step(hf(6000), 2000); assert e.state.nodes[1].last_heat_alert_mono == e.clock.mono_ms()

# ---- GV-16: sensor_fault condition (ii) is now live (the real heat rule sets the row and the stamp) ----
def test_GV16a_a_temp_fault_30_s_after_heat_opened_raises_sensor_fault_at_danger_and_the_heat_row_stays_open():
    e = Eng(); e.step(hf(6500, flags=0x01), 0); feed(e, 6500, 122, flags=0x01); assert al(e, 'heat') is not None; feed(e, 6500, 30, flags=0x01)
    fx = e.step(hf(6500, flags=0x0A, status2=TF), 2000); sf = al(e, 'sensor_fault')
    assert sf is not None and sf.level == 'DANGER' and 'heat' in sf.reasons and al(e, 'heat') is not None and al(e, 'node_danger') is None
    assert e.state.nodes[1].co_validity == 'UNRELIABLE' and e.state.nodes[1].level == 'DANGER' and e.state.episodes == {}

def test_GV16b_a_temp_fault_without_heat_is_a_warning_sensor_fault():
    e = Eng(); feed(e, 2500, 20); e.step(hf(2500, flags=0x09, status2=TF), 2000)
    assert al(e, 'sensor_fault').level == 'WARNING' and al(e, 'heat') is None and e.state.nodes[1].co_validity == 'UNRELIABLE'

def test_GV16c_a_heat_row_open_for_10_minutes_then_a_temp_fault_is_a_danger_sensor_fault():
    e = Eng(); e.step(hf(6500), 0); feed(e, 6500, 122); feed(e, 6500, 600); e.step(hf(6500, flags=0x0A, status2=TF), 2000)
    assert al(e, 'sensor_fault').level == 'DANGER' and al(e, 'heat') is not None

def test_a_temp_fault_within_60_s_after_the_heat_row_cleared_is_danger_and_after_61_s_warning():
    for gap, lvl in ((58, 'DANGER'), (62, 'WARNING')):
        e = Eng(); e.step(hf(6000), 0); feed(e, 6000, 122); feed(e, 5000, 12); assert al(e, 'heat') is None
        feed(e, 5000, gap); e.step(hf(5000, status2=TF), 2000); assert al(e, 'sensor_fault').level == lvl, gap

# ---- shadow estimator and shadow_notice (GV-25) ----
def test_GV25_still_for_30_s_with_mandown_0_raises_shadow_notice_and_motion_clears_it():
    e = Eng(); e.step(hf(motion=0), 0); assert motionless(e, 28, motion=0) == [] and al(e, 'shadow_notice') is None      # 28 s of stillness
    fx = e.step(hf(motion=0), 2000); assert kinds(fx) == [('RaiseAlert', 'shadow_notice', 'NONE')] and e.state.nodes[1].level == 'NORMAL' and e.state.episodes == {}    # 30 s
    assert e.step(hf(motion=0), 2000) == []                                                          # held: no second row
    fx = e.step(hf(motion=6), 2000); assert kinds(fx) == [('ClearAlert', 'shadow_notice', None)] and fx[0].reason == 'motion' and e.state.episodes == {}

def test_motion_equal_to_still_g_is_still_and_a_single_moving_frame_restarts_the_run():
    e = Eng(); e.step(hf(motion=5), 0); motionless(e, 28, motion=5); e.step(hf(motion=6), 2000); assert e.state.nodes[1].shadow_still_since_mono is None
    e.step(hf(motion=5), 2000); assert al(e, 'shadow_notice') is None and motionless(e, 28, motion=5) == [] and al(e, 'shadow_notice') is None
    assert kinds(e.step(hf(motion=5), 2000)) == [('RaiseAlert', 'shadow_notice', 'NONE')]

def test_mandown_clears_the_notice_and_is_never_raised_while_mandown_is_1():
    e = Eng(); e.step(hf(motion=0), 0); motionless(e, 30, motion=0); assert al(e, 'shadow_notice') is not None
    fx = e.step(hf(flags=0x06, motion=0), 2000); assert ('ClearAlert', 'shadow_notice', None) in kinds(fx) and fx[[k[1] for k in kinds(fx)].index('shadow_notice')].reason == 'mandown'
    assert al(e, 'shadow_notice') is None and not [k for k in kinds(feed(e, 2500, 60, flags=0x06, motion=0)) if k[1] == 'shadow_notice']

def test_a_notice_can_coexist_with_an_open_episode_and_resolve_clears_it_and_restarts_the_run():
    e = Eng(); e.step(hf(flags=0x06, motion=0), 0); feed(e, 2500, 6, flags=0x06, motion=0); feed(e, 2500, 40, flags=0, motion=0)      # latch cleared on the jacket, episode stays open
    assert len(e.state.episodes) == 1 and al(e, 'shadow_notice') is not None
    fx = e.step(ResolveEpisodeEvent(1, 'rescued', 7), 0); assert ('ClearAlert', 'shadow_notice', None) in kinds(fx) and fx[[k[1] for k in kinds(fx)].index('shadow_notice')].reason == 'resolved'
    assert e.state.nodes[1].shadow_still_since_mono is None and kinds(e.step(hf(motion=0), 2000)) == [] and al(e, 'shadow_notice') is None
    assert not [k for k in kinds(motionless(e, 28, motion=0)) if k[1] == 'shadow_notice'] and kinds(e.step(hf(motion=0), 2000)) == [('RaiseAlert', 'shadow_notice', 'NONE')]

def test_an_imu_fault_disables_the_estimator_and_raises_the_notice_until_it_ends():
    e = Eng(); fx = e.step(hf(status2=IMU, motion=0), 0); assert kinds(fx)[-1] == ('RaiseAlert', 'shadow_notice', 'NONE') or ('RaiseAlert', 'shadow_notice', 'NONE') in kinds(fx)
    assert 'imu_fault' in al(e, 'shadow_notice').reasons and e.state.nodes[1].shadow_still_since_mono is None
    feed(e, 2500, 60, status2=IMU, motion=6); assert al(e, 'shadow_notice') is not None                   # motion is not trusted while the IMU is faulted
    fx = e.step(hf(motion=0), 2000); assert fx and [x for x in fx if getattr(x, 'type', None) == 'shadow_notice'][0].reason == 'imu_fault_ended'

def test_suspect_frames_never_start_move_or_clear_the_run():
    e = Eng(); e.step(hf(motion=0, seq_class='suspect'), 0)
    for _ in range(25): e.step(hf(motion=0, seq_class='suspect'))
    assert al(e, 'shadow_notice') is None and e.state.nodes[1].shadow_still_since_mono is None
    e.step(hf(motion=0), 0); motionless(e, 30, motion=0); assert al(e, 'shadow_notice') is not None
    assert e.step(hf(motion=50, seq_class='suspect'), 2000) == [] and al(e, 'shadow_notice') is not None

def test_after_a_link_recovery_the_run_restarts_only_after_3_more_fresh_frames():
    e = Eng(); e.step(hf(motion=0), 0); motionless(e, 20, motion=0); assert e.state.nodes[1].shadow_still_since_mono is not None
    e.step(TickEvent(), 20000); assert al(e, 'signal_lost') is not None
    e.step(hf(motion=0), 0)                                                                         # the recovery frame: not tracked
    assert e.state.nodes[1].shadow_still_since_mono is None and e.state.nodes[1].shadow_rebaseline_left == 3 and al(e, 'signal_lost') is None
    for left in (2, 1, 0): e.step(hf(motion=0), 2000); assert e.state.nodes[1].shadow_rebaseline_left == left and e.state.nodes[1].shadow_still_since_mono is None
    e.step(hf(motion=0), 2000); assert e.state.nodes[1].shadow_still_since_mono == e.clock.mono_ms()
    assert motionless(e, 28, motion=0) == [] and kinds(e.step(hf(motion=0), 2000)) == [('RaiseAlert', 'shadow_notice', 'NONE')]

def test_a_long_gap_without_a_tick_also_counts_as_a_recovery():
    e = Eng(); e.step(hf(motion=0), 0); motionless(e, 20, motion=0); e.step(hf(motion=0), 16000); assert e.state.nodes[1].shadow_rebaseline_left == 3

def test_shadow_notice_is_per_node_and_changes_no_level():
    e = Eng(); e.step(hf(motion=0, node=2), 0); feed(e, 2500, 32, motion=0, node=2)
    assert (2, 'shadow_notice') in e.state.alerts and (1, 'shadow_notice') not in e.state.alerts and e.state.nodes[2].level == 'NORMAL' and e.state.episodes == {}
`);
  replace(RE, String.raw`    scba_lower_since_mono: Optional[int] = None      # P7c-2: first fresh frame of the current run below co_warn_clear_ppm on a DANGER scba_expired (10 s lowering timer)

@dataclass(frozen=True)
class EngineState:`, String.raw`    scba_lower_since_mono: Optional[int] = None      # P7c-2: first fresh frame of the current run below co_warn_clear_ppm on a DANGER scba_expired (10 s lowering timer)
    heat_hot_since_mono: Optional[int] = None        # P7c-3: first fresh frame of the current run at or above heat_warn_c (the 'time' trigger)
    heat_ext_since_mono: Optional[int] = None        # P7c-3: first fresh frame of the current run at or above heat_extreme_c
    heat_hist: tuple = ()                            # P7c-3: (mono, temp_x100) of healthy fresh frames inside heat_rise_window_s (the 'rise' trigger)
    heat_triggers: frozenset = frozenset()           # P7c-3: triggers of the open heat row (time, rise, extreme); each has its own clear condition
    heat_clear_since_mono: Optional[int] = None      # P7c-3: first fresh frame of the current run in which every trigger's clear condition holds (10 s)
    heat_skip_next: bool = False                     # P7c-3: the last frame had a temperature fault, so the next fresh frame is not evaluated (14.1)
    shadow_still_since_mono: Optional[int] = None    # P7c-3: first fresh frame of the current run with motion at or below still_g_default (shadow estimator)
    shadow_rebaseline_left: int = 0                  # P7c-3: fresh frames still to skip after a link recovery (rebaseline_clean_frames)

@dataclass(frozen=True)
class EngineState:`);
  replace(RE, String.raw`RULES = (co_state_rule, co_threshold_rule, sensor_fault_rule, battery_low_rule, link_rule, checkin_rule, scba_expired_rule, notice_rule, man_down_rule, node_danger_rule)`, String.raw`# ---- P7c-3: heat (14.1 row, 14.2 (4), Summary D5) and the 14.2 (5) shadow estimator with its shadow_notice badge. Fresh frames only: a suspect frame never starts,
# advances or resets a heat timer or the stillness run (14.1). They run BEFORE link_rule (the estimator must see the link rows a fresh frame is about to clear).
# heat never raises DANGER. shadow_notice is level NONE: badge and log only, no episode, no level change, no sound. ----
HEAT_CLEAR_S = 10   # 14.1 "The 10 s hysteresis timers"; no heat-specific constant exists in constants.json, so this is a module value (open item in the handoff)

def _heat_window(n, temp, mono):
    """(history, rise) with this frame in a window of heat_rise_window_s of healthy fresh frames; rise = temp now minus the lowest temp in the window (x100 ints)."""
    hist = tuple((t, v) for t, v in n.heat_hist + ((mono, temp),) if mono - t <= K.HEAT_RISE_WINDOW_S * 1000)
    return hist, temp - min(v for _, v in hist)

def heat_rule(state, event, now, mode):
    """heat: temp >= heat_warn_c for heat_warn_s ('time'), a rise of heat_rise_c within heat_rise_window_s ('rise') or >= heat_extreme_c for heat_extreme_s ('extreme');
    one WARNING row per node, never DANGER. Clears after HEAT_CLEAR_S of every trigger's own clear condition: temp < heat_warn_clear_c (time), < heat_extreme_clear_c
    (extreme), rise < heat_rise_clear_c (rise). A temperature fault (status2 bit 6) freezes evaluation and holds an open row; its timers and window restart, and the
    first fresh frame after the fault is not evaluated either (14.1: re-evaluate from the next fresh valid frame only). Sets last_heat_alert_mono on every frame while a row is open."""
    if not isinstance(event, FrameEvent) or event.node_id is None or mode != FULL: return state, ()
    nid, d, mono, fx = event.node_id, event.decoded, now.mono_ms, ()
    n, temp = state.nodes.get(nid, NodeState()), d['temp_x100']
    stamp = mono if open_alert(state, nid, 'heat') is not None else n.last_heat_alert_mono
    fault = bool(_bit(d, 'status2', 'temp_fault'))
    if fault or n.heat_skip_next:
        n2 = replace(n, heat_hot_since_mono=None, heat_ext_since_mono=None, heat_hist=(), heat_clear_since_mono=None, heat_skip_next=fault, last_heat_alert_mono=stamp)
    else:
        hist, rise = _heat_window(n, temp, mono)
        hot = (mono if n.heat_hot_since_mono is None else n.heat_hot_since_mono) if temp >= K.HEAT_WARN_C * 100 else None
        ext = (mono if n.heat_ext_since_mono is None else n.heat_ext_since_mono) if temp >= K.HEAT_EXTREME_C * 100 else None
        fired = frozenset(k for k, on in (('time', hot is not None and mono - hot >= K.HEAT_WARN_S * 1000), ('extreme', ext is not None and mono - ext >= K.HEAT_EXTREME_S * 1000),
                                          ('rise', rise >= K.HEAT_RISE_C * 100)) if on)
        row, trig, clear_since = open_alert(state, nid, 'heat'), n.heat_triggers | fired, n.heat_clear_since_mono
        if row is None and fired: state, fx = raise_alert(state, nid, 'heat', 'WARNING', f"temp={temp / 100:.1f}C {','.join(sorted(fired))}", now); trig = fired
        row = open_alert(state, nid, 'heat')
        if row is None: trig, clear_since = frozenset(), None
        else:
            trig = trig or frozenset(('time',))   # a row without memory of its trigger (rebuilt after a restart): the plain temperature rule
            ok = not fired and all(temp < K.HEAT_WARN_CLEAR_C * 100 if k == 'time' else temp < K.HEAT_EXTREME_CLEAR_C * 100 if k == 'extreme' else rise < K.HEAT_RISE_CLEAR_C * 100 for k in trig)
            clear_since = (mono if clear_since is None else clear_since) if ok else None
            if clear_since is not None and mono - clear_since >= HEAT_CLEAR_S * 1000:
                state, more = clear_alert(state, nid, 'heat', now, 'below_clear_level'); fx += more; trig, clear_since = frozenset(), None
        n2 = replace(n, heat_hot_since_mono=hot, heat_ext_since_mono=ext, heat_hist=hist, heat_triggers=trig, heat_clear_since_mono=clear_since, heat_skip_next=False, last_heat_alert_mono=stamp)
    cur = state.nodes.get(nid, n)
    state = replace(state, nodes={**state.nodes, nid: replace(n2, level=cur.level)}) if (n2 != n or nid not in state.nodes) else state
    return refresh_level(state, nid, _bit(d, 'flags', 'node_level'), False), fx

def shadow_rule(state, event, now, mode):
    """Shadow estimator (14.2 (5)): continuous stillness (motion <= still_g_default) across fresh frames. shadow_notice opens when it reaches mandown_still_s with mandown = 0
    (GV-25), or while an IMU fault disables the estimator. Clears on motion above still_g_default, when mandown = 1, when the IMU fault ends, or on Resolve (operator_step).
    After a link recovery the run is suspended for rebaseline_clean_frames further fresh frames. The grace and disagreement times are not applied (open item)."""
    if not isinstance(event, FrameEvent) or event.node_id is None or mode != FULL: return state, ()
    nid, d, mono, fx = event.node_id, event.decoded, now.mono_ms, ()
    n = state.nodes.get(nid, NodeState())
    imu, md = bool(_bit(d, 'status2', 'imu_fault')), bool(_bit(d, 'flags', 'mandown'))
    moving = d['motion_x100'] / 100 > K.STILL_G_DEFAULT
    since, left = n.shadow_still_since_mono, n.shadow_rebaseline_left
    recovered = (open_alert(state, nid, 'signal_lost') is not None or open_alert(state, nid, 'link_lost') is not None
                 or (n.last_fresh_mono is not None and mono - n.last_fresh_mono >= K.SIGNAL_LOST_S * 1000))
    if recovered: since, left = None, K.REBASELINE_CLEAN_FRAMES        # the recovery frame and the next rebaseline_clean_frames frames are not tracked
    elif left > 0: since, left = None, left - 1
    elif imu: since = None                                              # suspended during an IMU fault
    else: since = None if moving else (mono if since is None else since)
    row = open_alert(state, nid, 'shadow_notice')
    if row is not None:
        why = 'mandown' if md else 'imu_fault_ended' if (not imu and row.reasons.startswith('imu_fault')) else 'motion' if (moving and not imu and not row.reasons.startswith('imu_fault')) else None
        if why: state, fx = clear_alert(state, nid, 'shadow_notice', now, why)
    if imu: state, more = raise_alert(state, nid, 'shadow_notice', 'NONE', 'imu_fault shadow estimator disabled', now); fx += more
    elif not md and since is not None and mono - since >= K.MANDOWN_STILL_S * 1000:
        state, more = raise_alert(state, nid, 'shadow_notice', 'NONE', f'still_since={(mono - since) // 1000} s mandown=0', now); fx += more
    cur = state.nodes.get(nid, n); n2 = replace(cur, shadow_still_since_mono=since, shadow_rebaseline_left=left)
    return (state if n2 == cur and nid in state.nodes else replace(state, nodes={**state.nodes, nid: n2})), fx

RULES = (co_state_rule, co_threshold_rule, sensor_fault_rule, battery_low_rule, heat_rule, shadow_rule, link_rule, checkin_rule, scba_expired_rule, notice_rule, man_down_rule, node_danger_rule)`);
  replace(RE, String.raw`    for t in EPISODE_ALERT_TYPES: state, more = clear_alert(state, nid, t, now, 'resolved'); fx += more
`, String.raw`    for t in EPISODE_ALERT_TYPES + ('shadow_notice',): state, more = clear_alert(state, nid, t, now, 'resolved'); fx += more   # P7c-3: a notice has no episode of its own, Resolve reaches it through the node's episode (14.1b)
    if nid in state.nodes: state = replace(state, nodes={**state.nodes, nid: replace(state.nodes[nid], shadow_still_since_mono=None)})   # the stillness run restarts
`);
  replace('host/tests/test_sensor_fault.py', String.raw`IMU_FAULT = 1 << 5
SF = 'sensor_fault'

def sf(e)`, String.raw`IMU_FAULT = 1 << 5
SF = 'sensor_fault'

@pytest.fixture(autouse=True)
def _no_shadow(monkeypatch):
    monkeypatch.setattr(re_, 'RULES', tuple(r for r in re_.RULES if r is not re_.shadow_rule))   # P7c-3: 30 s of stillness raises a shadow_notice badge; these tests are about sensor_fault (test_heat_shadow.py covers the estimator)

def sf(e)`);
  append('docs/PROGRESS.md', "- Part 7c-3 done: heat (time, rise and extreme triggers, WARNING only, per-trigger 10 s clear, temperature fault freezes and holds, sets last_heat_alert_mono so sensor_fault condition (ii) is live) and the 14.2 shadow estimator with shadow_notice (30 s stillness with mandown 0, IMU fault, link-recovery rebaseline, cleared by motion, latch or Resolve) in core/rule_engine.py, host/tests/test_heat_shadow.py (GV-16 a to c, GV-25)");
}
