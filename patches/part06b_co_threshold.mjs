// patches/part06b_co_threshold.mjs  (run from repo root: node patches/part06b_co_threshold.mjs [--dry] [--force])
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
  // each anchor stops matching once applied, so a second run reports 'already applied' and changes nothing
  replace(RE, String.raw`    raised_ts: int
    reasons: str

# P6a: per-frame CO mode`, String.raw`    raised_ts: int
    reasons: str
    acknowledged_ts: Optional[int] = None   # NULL until an operator acknowledges; escalating WARNING -> DANGER resets it, lowering keeps it (14.1)

@dataclass(frozen=True)
class ChangeAlertLevel(Effect):   # P6b: an open alert row changes level in place (same alert_id, no second card); event_seq is a new one
    node_id: int
    type: str
    raised_event_seq: int         # event_seq of the RaiseAlert that opened the row (identifies the row)
    old_level: str
    level: str
    acknowledged_reset: bool      # True on escalation: acknowledged_ts = NULL so the siren sounds; False on lowering: acknowledged_ts kept
    reasons: str
    changed_ts: int

# P6a: per-frame CO mode`);
  replace(RE, String.raw`    last_co_ge_warn_mono: Optional[int] = None       # last fresh frame with a usable CO of co_warn_ppm or more and SCBA OFF (read by P6c)
`, String.raw`    last_co_ge_warn_mono: Optional[int] = None       # last fresh frame with a usable CO of co_warn_ppm or more and SCBA OFF (read by P6c; set by P6a)
    co_clear_since_mono: Optional[int] = None        # P6b: first fresh frame of the current run below co_warn_clear_ppm (10 s clear timer)
    co_lower_since_mono: Optional[int] = None        # P6b: first fresh frame of the current run below co_danger_clear_ppm (10 s DANGER-to-WARNING timer)
`);
  replace(RE, 'RULES = (co_state_rule,)  # rule functions in evaluation order; later Parts add theirs after this one (node_danger stays last, 14.1)', String.raw`# ---- P6b: co_threshold, design 14.1 row and 14.2 (3). Reads the P6a state (co_mode, co_hold_ended), so it runs after co_state_rule. ----
RANK = {'NONE': 0, 'NORMAL': 0, 'WARNING': 1, 'DANGER': 2}
CO_RISING_ENABLED = False  # co_rising stays disabled until its values are signed off (guide Section 6); host/config/settings.json co_rising_enabled is false too

def set_alert_level(state, node_id, type, level, reasons, now):
    """Change the level of the open alert of that node and type in place (14.1). Escalation resets acknowledged_ts; lowering keeps it.
    No effect if none is open or the level is already that level."""
    _check_alert(node_id, type, level)
    row = state.alerts.get((node_id, type))
    if row is None or row.level == level: return state, ()
    up = RANK[level] > RANK[row.level]
    state, seq = next_seq(state)
    new = replace(row, level=level, reasons=reasons, acknowledged_ts=None if up else row.acknowledged_ts)
    return replace(state, alerts={**state.alerts, (node_id, type): new}), (ChangeAlertLevel(seq, node_id, type, row.event_seq, row.level, level, up, reasons, now.wall_ms),)

def refresh_level(state, node_id, flag_rank, keep_higher):
    """NodeState.level = the highest of the frame's node_level (flag_rank 0 to 2) and the open alerts of the node; a suspect frame
    (keep_higher) can only raise it (14.1). P7 onward reuse this."""
    n = state.nodes.get(node_id, NodeState())
    top = max([flag_rank] + [RANK[a.level] for (nid, _), a in state.alerts.items() if nid == node_id] + ([RANK[n.level]] if keep_higher else []))
    lvl = ('NORMAL', 'WARNING', 'DANGER')[top]
    return state if lvl == n.level and node_id in state.nodes else replace(state, nodes={**state.nodes, node_id: replace(n, level=lvl)})

def co_threshold_rule(state, event, now, mode):
    if not isinstance(event, FrameEvent) or event.node_id is None or mode == NONE: return state, ()
    nid, d, mono = event.node_id, event.decoded, now.mono_ms
    n, fresh = state.nodes.get(nid, NodeState()), mode == FULL
    ppm, scba = d['co_x10'] / 10, bool(_bit(d, 'id_mode', 'scba_on'))   # the raw reading: a high value is never hidden (GV-18 g)
    usable = n.co_mode != CO_NO_READING_HELD if fresh else not _bit(d, 'status2', 'co_fault')   # a CO fault or CO timeout has no reading
    want = None
    if usable and not scba:
        want = 'DANGER' if ppm >= K.CO_DANGER_PPM or _bit(d, 'flags', 'co_sat') else 'WARNING' if ppm >= K.CO_WARN_PPM else None
    why, fx = f'co_ppm={min(ppm, K.CO_CLAMP_MAX_PPM):.1f}', ()
    row = open_alert(state, nid, 'co_threshold')
    if want and row is None: state, fx = raise_alert(state, nid, 'co_threshold', want, why, now)
    elif want == 'DANGER' and row is not None and row.level == 'WARNING': state, fx = set_alert_level(state, nid, 'co_threshold', 'DANGER', why, now)
    clear_s, lower_s = n.co_clear_since_mono, n.co_lower_since_mono
    if fresh:                      # a suspect frame never lowers, clears or moves a timer (14.1)
        row, hyst = open_alert(state, nid, 'co_threshold'), K.CO_HYSTERESIS_S * 1000
        if row is None or not usable or scba or n.co_mode != CO_USABLE or n.co_hold_ended:
            clear_s = lower_s = None   # nothing open, held (14.2 (3)), suppressed (SCBA ON) or the frame that ended a hold: no timer runs, a running one is reset
        else:
            clear_s = (mono if clear_s is None else clear_s) if ppm < K.CO_WARN_CLEAR_PPM else None
            lower_s = (mono if lower_s is None else lower_s) if row.level == 'DANGER' and ppm < K.CO_DANGER_CLEAR_PPM else None
            if clear_s is not None and mono - clear_s >= hyst:        # clearing wins when both timers have expired
                state, more = clear_alert(state, nid, 'co_threshold', now, 'below_clear_level'); fx += more; clear_s = lower_s = None
            elif lower_s is not None and mono - lower_s >= hyst and ppm >= K.CO_WARN_CLEAR_PPM:
                state, more = set_alert_level(state, nid, 'co_threshold', 'WARNING', why, now); fx += more; lower_s = None
    cur = state.nodes.get(nid); n2 = replace(cur or n, co_clear_since_mono=clear_s, co_lower_since_mono=lower_s)
    if cur != n2: state = replace(state, nodes={**state.nodes, nid: n2})
    return refresh_level(state, nid, _bit(d, 'flags', 'node_level'), not fresh), fx

RULES = (co_state_rule, co_threshold_rule)  # rule functions in evaluation order; later Parts add theirs after these (node_danger stays last, 14.1)`);
  put('host/tests/test_co_threshold.py', String.raw`"""P6b: co_threshold (design 14.1 row, 14.2 (3), GV-01, GV-09, GV-18 a to g). Uses the frame helper of test_co_state.py.
Frames here carry flags=0 unless a test says otherwise, so NodeState.level comes from the alerts alone."""
import json
from dataclasses import replace
from pathlib import Path
import pytest
from test_co_state import CO_FAULT, SHT_FAULT, WARMUP, Sim, co_frame, vector_event
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import ChangeAlertLevel, ClearAlert, FrameEvent, RaiseAlert, TickEvent, step

ROOT = Path(__file__).resolve().parents[2]
TYPE = 'co_threshold'

def frame(flags=0, **kw):
    ev = co_frame(**kw); d = dict(ev.decoded); d['flags'] = flags
    return FrameEvent(ev.node_id, ev.verify, ev.seq_class, d)

class Eng(Sim):
    def step(self, event, dt_ms=2000):
        self.clock.advance(dt_ms); self.state, fx = step(self.state, event, self.clock.now()); return list(fx)
    def run(self, n, **kw):
        out = []
        for _ in range(n): out += self.step(frame(**kw))
        return out
    @property
    def row(self): return self.state.alerts.get((1, TYPE))
    @property
    def node(self): return self.state.nodes[1]
    def ack(self): self.state = replace(self.state, alerts={**self.state.alerts, (1, TYPE): replace(self.row, acknowledged_ts=self.clock.wall_ms())})

def kinds(fx): return [(type(e).__name__, getattr(e, 'level', None)) for e in fx]
def open_at(level, **kw):
    e = Eng(); e.step(frame(co_x10={'WARNING': 520, 'DANGER': 2500}[level], **kw), 0); assert e.row.level == level; return e

def test_rule_registered_after_co_state():
    assert re_.RULES[:2] == (re_.co_state_rule, re_.co_threshold_rule)

# ---- raise: boundaries, SCBA, usable reading ----
@pytest.mark.parametrize('co_x10,level', [(349, None), (350, 'WARNING'), (1999, 'WARNING'), (2000, 'DANGER'), (4949, 'DANGER'), (4950, 'DANGER'), (5000, 'DANGER'), (5200, 'DANGER')])
def test_thresholds_and_saturation(co_x10, level):
    e = Eng(); fx = e.step(frame(co_x10=co_x10), 0)
    assert (e.row.level if e.row else None) == level and len(fx) == (1 if level else 0)
    if level: assert fx[0].node_id == 1 and fx[0].type == TYPE and fx[0].level == level

def test_over_range_still_raises_and_keeps_p6a_clamp():
    e = Eng(); e.step(frame(co_x10=5200), 0); assert e.row.level == 'DANGER' and e.node.co_over_range and e.node.co_ppm == 500.0

def test_co_sat_flag_gives_danger():
    e = Eng(); e.step(frame(co_x10=300, flags=0x10), 0); assert e.row.level == 'DANGER'

def test_scba_on_raises_nothing():
    e = Eng(); assert e.step(frame(co_x10=2500, scba=1), 0) == [] and e.row is None

def test_warmup_keeps_thresholds_active():
    e = Eng(); e.step(frame(co_x10=520, status3=WARMUP), 0); assert e.node.co_validity == 'DERATED' and e.row.level == 'WARNING'

def test_co_fault_and_timeout_open_nothing():
    e = Eng(); assert e.step(frame(co_x10=2500, status2=CO_FAULT), 0) == [] and e.row is None          # GV-07 a: the fault frame has no reading
    e = Eng(); e.step(frame(co_x10=100), 0); e.step(TickEvent(), 6000); assert e.node.co_reason == 'co_timeout' and e.row is None

def test_one_open_alert_and_levels_follow_it():
    e = Eng(); fx = e.run(20, co_x10=520)
    assert kinds(fx) == [('RaiseAlert', 'WARNING')] and len(e.state.alerts) == 1 and e.node.level == 'WARNING'

# ---- GV-01 ----
def test_GV_01():
    e = Eng(); fx = e.step(vector_event('F-01'), 0)
    assert kinds(fx) == [('RaiseAlert', 'WARNING')] and e.node.level == 'WARNING' and e.node.co_ppm == 52.0 and e.state.episodes == {}

# ---- GV-09 ----
def test_GV_09_a_b_c_acknowledge_lower_keep_ack_then_clear():
    e = Eng(); fx = e.step(frame(co_x10=2500, flags=0x02), 0); assert kinds(fx) == [('RaiseAlert', 'DANGER')] and e.row.acknowledged_ts is None   # (a)
    e.ack(); seq0, ack = e.row.event_seq, e.row.acknowledged_ts; assert ack is not None
    out = []
    for i in range(6): out += e.step(frame(co_x10=1500))                      # (b) first sub-180 frame, then 10 s
    assert kinds(out) == [('ChangeAlertLevel', 'WARNING')]
    ch = out[0]; assert (ch.raised_event_seq, ch.acknowledged_reset, ch.old_level) == (seq0, False, 'DANGER')
    assert e.row.level == 'WARNING' and e.row.event_seq == seq0 and e.row.acknowledged_ts == ack and len(e.state.alerts) == 1   # same alert_id, ack kept, no second card
    out = []
    for i in range(6): out += e.step(frame(co_x10=250))                        # (c) 10 s continuous below 31.5
    assert kinds(out) == [('ClearAlert', None)] and e.row is None and out[0].raised_event_seq == seq0

def test_GV_09_lowering_happens_on_the_frame_10_s_after_the_first_sub_180_frame():
    e = open_at('DANGER'); e.step(frame(co_x10=1500))                           # first sub-180 frame
    for _ in range(4): assert e.step(frame(co_x10=1500)) == []                  # 2, 4, 6, 8 s
    assert kinds(e.step(frame(co_x10=1500))) == [('ChangeAlertLevel', 'WARNING')]   # 10 s

def test_GV_09_separate_run_210_ppm_returns_to_danger_with_ack_null_and_a_new_event_seq():
    e = open_at('DANGER'); e.ack(); e.run(6, co_x10=1500); assert e.row.level == 'WARNING' and e.row.acknowledged_ts is not None
    seq = e.state.event_seq; fx = e.step(frame(co_x10=2100))
    assert kinds(fx) == [('ChangeAlertLevel', 'DANGER')] and fx[0].acknowledged_reset and e.row.acknowledged_ts is None and fx[0].event_seq == seq + 1 and len(e.state.alerts) == 1

def test_escalation_clears_ack_lowering_keeps_it():
    e = open_at('WARNING'); e.ack(); e.step(frame(co_x10=2500)); assert e.row.level == 'DANGER' and e.row.acknowledged_ts is None

def test_timers_restart_when_the_value_rises_above_the_clear_level():
    e = open_at('WARNING'); e.run(4, co_x10=100); e.step(frame(co_x10=320))     # 32.0 ppm is at or above 31.5: the clear timer restarts
    assert e.run(5, co_x10=100) == [] and e.row is not None
    assert kinds(e.step(frame(co_x10=100))) == [('ClearAlert', None)]

def test_both_timers_expired_clears_from_danger():
    e = open_at('DANGER'); out = e.run(6, co_x10=100); assert kinds(out) == [('ClearAlert', None)] and e.row is None

def test_between_the_levels_nothing_changes_for_10_minutes():
    e = open_at('WARNING'); fx = []
    for i in range(300): fx += e.step(frame(co_x10=340 if i % 2 else 360))       # 34 to 36 ppm
    assert [k for k, _ in kinds(fx)] == [] and e.row.level == 'WARNING'
    e = Eng(); fx = []
    for i in range(300): fx += e.step(frame(co_x10=1980 if i % 2 else 2020), 2000 if i else 0)   # 198 to 202 ppm
    assert not any(isinstance(x, ClearAlert) for x in fx) and sum(isinstance(x, RaiseAlert) for x in fx) == 1 and sum(isinstance(x, ChangeAlertLevel) for x in fx) <= 1
    assert e.row.level == 'DANGER'

# ---- GV-18 a to g (alert halves) ----
def test_GV_18_a_raises_warning():
    e = Eng(); fx = e.step(frame(co_x10=520), 0); assert kinds(fx) == [('RaiseAlert', 'WARNING')]

def test_GV_18_b_c_d_held_until_co_range_clears_then_the_10_s_timer_starts_on_the_next_frame():
    e = open_at('WARNING'); assert e.run(15, temp_x100=5600, co_x10=200) == [] and e.row is not None       # (b) 30 s, 20 ppm
    assert e.run(30, co_x10=200) == [] and e.row is not None and e.node.co_range_active                    # (c) 58 s: still held (first inside-margin frame + 29 more)
    assert e.step(frame(co_x10=200)) == [] and not e.node.co_range_active and e.node.co_hold_ended          # (d) the frame that clears co_range: no clear
    for _ in range(5): assert e.step(frame(co_x10=200)) == []                                               # timer starts on the next frame
    assert kinds(e.step(frame(co_x10=200))) == [('ClearAlert', None)]                                       # 10 s after it

def test_GV_18_e_f23_escalates_in_place_although_co_range_is_active():
    e = open_at('WARNING'); e.run(3, temp_x100=5600, co_x10=200); e.ack(); seq = e.row.event_seq
    fx = e.step(vector_event('F-23'))
    assert kinds(fx) == [('ChangeAlertLevel', 'DANGER')] and e.row.event_seq == seq and e.row.acknowledged_ts is None and e.node.co_range_active

def test_GV_18_f_the_60_s_count_restarts_and_the_alert_clears_10_s_after_co_range():
    e = open_at('WARNING'); e.run(2, temp_x100=5600, co_x10=200); e.run(21, co_x10=200)                     # 40 s inside the margins
    e.step(frame(temp_x100=5200, co_x10=200)); assert e.node.co_range_active and e.row is not None          # 52 C: restart
    for _ in range(30): assert e.step(frame(co_x10=200)) == [] and e.node.co_range_active                  # 25 C again: 30 frames, 58 s after the first
    assert e.step(frame(co_x10=200)) == [] and not e.node.co_range_active                                  # 60 s after temperature returned
    for _ in range(5): assert e.step(frame(co_x10=200)) == []
    assert kinds(e.step(frame(co_x10=200))) == [('ClearAlert', None)]

def test_GV_18_g_raises_danger_during_co_range_with_no_alert_then_is_held():
    e = Eng(); fx = e.step(frame(co_x10=2500, temp_x100=5600, flags=0x02), 0)
    assert kinds(fx) == [('RaiseAlert', 'DANGER')] and e.node.co_validity == 'UNRELIABLE' and e.node.co_reason == 'co_range' and e.node.co_ppm == 250.0 and e.node.level == 'DANGER'
    assert e.run(60, temp_x100=5600, co_x10=200) == [] and e.row.level == 'DANGER'                         # 2 min of 20 ppm: not lowered, not cleared
    assert e.run(31, co_x10=200) == [] and e.row is not None                                                # co_range clears on the 31st frame; still no clear on it
    out = e.run(6, co_x10=200); assert kinds(out) == [('ClearAlert', None)]

def test_F_15_raises_nothing_and_F_23_raises_danger_with_no_alert_open():
    e = Eng(); assert e.step(vector_event('F-15'), 0) == [] and e.row is None
    e = Eng(); assert kinds(e.step(vector_event('F-23'), 0)) == [('RaiseAlert', 'DANGER')] and e.node.co_reason == 'co_range'

# ---- hold rule ----
def test_sht40_fault_holds_and_a_high_reading_still_opens():
    e = open_at('WARNING'); assert e.run(30, status2=SHT_FAULT, co_x10=100) == [] and e.row is not None and e.node.co_reason == 'sht40_fault'
    e = Eng(); assert kinds(e.step(frame(co_x10=520, status2=SHT_FAULT), 0)) == [('RaiseAlert', 'WARNING')]

def test_running_timer_is_reset_when_a_hold_starts_and_held_time_does_not_count():
    # 4 s of a running clear timer, then a hold: the timer is reset and the held time does not count
    e = open_at('WARNING'); e.run(4, co_x10=100); e.run(3, status2=SHT_FAULT, co_x10=100)
    assert e.step(frame(co_x10=100)) == [] and e.node.co_hold_ended                # hold ends: not on this frame
    for _ in range(5): assert e.step(frame(co_x10=100)) == []                      # 4 s before the hold plus held time must not count
    assert kinds(e.step(frame(co_x10=100))) == [('ClearAlert', None)]

def test_co_fault_holds_an_open_alert_and_it_clears_10_s_after_valid_readings_resume():
    e = open_at('DANGER'); assert e.run(20, status2=CO_FAULT, co_x10=0) == [] and e.row.level == 'DANGER'
    assert e.step(frame(co_x10=100)) == [] and e.node.co_hold_ended
    for _ in range(5): assert e.step(frame(co_x10=100)) == []
    assert kinds(e.step(frame(co_x10=100))) == [('ClearAlert', None)]

def test_co_timeout_holds_an_open_alert():
    e = open_at('WARNING'); e.step(TickEvent(), 6000); assert e.node.co_reason == 'co_timeout' and e.row is not None
    assert e.step(frame(co_x10=100)) == [] and e.row is not None

def test_scba_on_suppresses_without_clearing():
    e = open_at('WARNING'); assert e.run(30, scba=1, co_x10=100) == [] and e.row is not None      # 60 s low with SCBA ON: not cleared
    assert e.run(5, co_x10=100) == [] and kinds(e.step(frame(co_x10=100))) == [('ClearAlert', None)]   # timers start with SCBA OFF again

# ---- suspect frames ----
def test_suspect_frame_never_lowers_clears_or_moves_a_timer():
    e = open_at('DANGER'); assert [e.step(frame(co_x10=0, seq_class='suspect')) for _ in range(10)] == [[]] * 10 and e.row.level == 'DANGER'
    assert (e.node.co_clear_since_mono, e.node.co_lower_since_mono) == (None, None)
    e.step(frame(co_x10=100)); since = e.node.co_clear_since_mono
    e.step(frame(co_x10=0, seq_class='suspect')); assert e.node.co_clear_since_mono == since

def test_suspect_frame_raises_and_escalates_and_only_raises_the_level():
    e = Eng(); assert kinds(e.step(frame(co_x10=520, seq_class='suspect'), 0)) == [('RaiseAlert', 'WARNING')]
    assert kinds(e.step(frame(co_x10=2500, seq_class='suspect'))) == [('ChangeAlertLevel', 'DANGER')] and e.node.level == 'DANGER'
    e.step(frame(co_x10=0, seq_class='suspect')); assert e.node.level == 'DANGER' and e.row.level == 'DANGER'
    assert Eng().step(frame(co_x10=2500, status2=CO_FAULT, seq_class='suspect'), 0) == []

# ---- levels, co_rising, purity ----
def test_node_level_drops_when_the_alert_clears():
    e = open_at('DANGER'); assert e.node.level == 'DANGER'; e.run(7, co_x10=100); assert e.row is None and e.node.level == 'NORMAL'

def test_co_rising_is_disabled_and_never_raised():
    assert re_.CO_RISING_ENABLED is False and json.loads((ROOT / 'host' / 'config' / 'settings.json').read_text(encoding='utf8'))['co_rising_enabled'] is False
    e = Eng(); fx = e.run(50, co_x10=100) + e.run(50, co_x10=3000) + e.run(50, co_x10=100)     # a steep rise and fall
    assert not any(getattr(x, 'type', None) == 'co_rising' for x in fx)

def test_event_seq_strictly_increases_and_replay_is_deterministic():
    def run():
        e = Eng(); fx = e.step(frame(co_x10=520), 0) + e.run(2, co_x10=2500) + e.run(6, co_x10=1500) + e.run(7, co_x10=100); return fx, e.state
    (a, sa), (b, sb) = run(), run(); assert a == b and sa == sb
    seqs = [x.event_seq for x in a]; assert seqs == sorted(set(seqs)) and seqs == list(range(1, len(seqs) + 1))
`);
  // three earlier tests assumed that no rule raises an alert; each is edited minimally (see the HANDOFF)
  replace('host/tests/test_golden_vectors.py', String.raw`    {'id': 'PH-03', 'gv': 'GV-01 (partial)', 'desc': 'PLACEHOLDER, replaced in P6 by GV-01 (it will raise co_threshold): until a rule exists a fresh F-01 and a timer tick produce no effects and use no event_seq',
     'steps': [{'frame': 'F-01', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [], 'episodes': 0, 'seq_delta': 0, 'levels': {1: 'NORMAL'}}},
               {'tick': True, 'dt_ms': 20000, 'expect': {'effects': [], 'open': [], 'seq_delta': 0}}]},`, String.raw`    {'id': 'GV-01', 'gv': 'GV-01', 'desc': 'Node 1, fresh F-01 (52.0 ppm, SCBA OFF, node_level WARNING): raises co_threshold WARNING, final level WARNING, 0 episodes; the same reading again adds nothing; a timer tick adds nothing',
     'steps': [{'frame': 'F-01', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'co_threshold', 'WARNING')], 'open': [(1, 'co_threshold', 'WARNING')], 'episodes': 0, 'seq_delta': 1, 'levels': {1: 'WARNING'}}},
               {'frame': 'F-01', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [(1, 'co_threshold', 'WARNING')], 'seq_delta': 0}},
               {'tick': True, 'dt_ms': 20000, 'expect': {'effects': [], 'open': [(1, 'co_threshold', 'WARNING')], 'seq_delta': 0}}]},`);
  replace('host/tests/test_golden_vectors.py', String.raw`def project(fx):
    return [('raise', e.node_id, e.type, e.level) if isinstance(e, RaiseAlert) else ('clear', e.node_id, e.type, None) for e in fx]`, String.raw`def project(fx):
    return [('clear', e.node_id, e.type, None) if isinstance(e, ClearAlert) else ('raise', e.node_id, e.type, e.level) if isinstance(e, RaiseAlert)
            else ('escalate' if e.acknowledged_reset else 'lower', e.node_id, e.type, e.level) for e in fx]`);
  replace('host/tests/test_golden_vectors.py', String.raw`from ppe_host.core.rule_engine import (ClearAlert, EngineState, FrameEvent, RaiseAlert, TickEvent, node_level, raise_alert, step)`, String.raw`from ppe_host.core.rule_engine import (ChangeAlertLevel, ClearAlert, EngineState, FrameEvent, RaiseAlert, TickEvent, node_level, raise_alert, step)`);
  replace('host/tests/test_golden_vectors.py', String.raw`{'effects': [('raise', 1, 'co_threshold', 'WARNING')], 'open': [(1, 'heat', 'WARNING')]`, String.raw`{'effects': [('raise', 1, 'heat', 'WARNING')], 'open': [(1, 'heat', 'WARNING')]`);
  replace('host/tests/test_co_state.py', String.raw`def test_rule_does_not_touch_level_alerts_or_event_seq():
    s = Sim(); s.frames(5, co_x10=2500, temp_x100=5600)
    assert (s.state.nodes[1].level, s.state.alerts, s.state.event_seq) == ('NORMAL', {}, 0)`, String.raw`def test_co_state_rule_alone_touches_no_level_alert_or_event_seq():
    s, clock = EngineState(), FakeClock(0, 10_000)
    for _ in range(5):
        clock.advance(2000); s, fx = re_.co_state_rule(s, co_frame(co_x10=2500, temp_x100=5600), clock.now(), 'full'); assert fx == ()
    assert (s.nodes[1].level, s.alerts, s.event_seq) == ('NORMAL', {}, 0)`);
  append('docs/PROGRESS.md', '- Part 6b done: co_threshold in core/rule_engine.py (WARNING at 35 ppm, DANGER at 200 ppm or co_sat, in-place escalate and lower via ChangeAlertLevel and set_alert_level, 10 s timers, hold rule, SCBA suppression, NodeState.level via refresh_level; co_rising stays disabled), host/tests/test_co_threshold.py, GV-01 in the harness');
}
