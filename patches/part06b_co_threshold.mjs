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
  put('host/tests/test_co_threshold.py', String.raw`"""P6b: co_threshold (design 14.1 row, 14.2 (3); GV-01, GV-09, GV-18 a to g, F-15, F-23). Boundary values below are test values only,
never code. Later stages import Run from this file (it is Sim from test_co_state plus the effects of every step)."""
from dataclasses import replace
import pytest
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import ChangeAlertLevel, ClearAlert, FrameEvent, RaiseAlert, TickEvent, step
from test_co_state import CO_FAULT, SHT_FAULT, Sim, co_frame, vector_event

KEY = (1, 'co_threshold')

class Run(Sim):
    """Sim that keeps the effects of the last step in .fx and of every step in .log."""
    def __init__(self): super().__init__(); self.fx, self.log = (), []
    def go(self, event, dt_ms=2000):
        self.clock.advance(dt_ms); self.state, self.fx = step(self.state, event, self.clock.now()); self.log += list(self.fx)
        return self.state.nodes.get(1)
    def row(self): return self.state.alerts.get(KEY)
    def lvl(self): r = self.row(); return r.level if r else None
    def ack(self, ts=5): self.state = replace(self.state, alerts={**self.state.alerts, KEY: replace(self.row(), acknowledged_ts=ts)})
    def run(self, n, **kw):
        """n frames 2 s apart; returns the 1-based numbers of the frames that produced effects."""
        hits = []
        for i in range(1, n + 1):
            self.go(co_frame(**kw))
            if self.fx: hits.append(i)
        return hits

def test_rules_are_registered_in_order():
    assert re_.RULES[:2] == (re_.co_state_rule, re_.co_threshold_rule)

# ---- GV-01 ----
def test_GV01_warning_raised_and_node_level():
    s = Run(); n = s.go(vector_event('F-01'), dt_ms=0)
    assert [(type(e), e.type, e.level) for e in s.fx] == [(RaiseAlert, 'co_threshold', 'WARNING')]
    assert n.level == 'WARNING' and s.row().level == 'WARNING' and s.state.episodes == {}

# ---- GV-09 ----
def danger_acked_then_lowered():
    s = Run(); s.go(co_frame(co_x10=2500), dt_ms=0); assert s.lvl() == 'DANGER'; s.ack()   # (a)
    assert s.run(5, co_x10=1500) == []                                                       # (b) 8 s below 180: still DANGER
    assert s.run(1, co_x10=1500) == [1]                                                      # the frame 10 s after the first sub-180 frame
    return s

def test_GV09_b_lowers_in_place_and_keeps_acknowledgement():
    s = Run(); s.go(co_frame(co_x10=2500), dt_ms=0); raised = s.row().event_seq; s.ack(); s.run(5, co_x10=1500); s.run(1, co_x10=1500)
    fx = s.fx[0]
    assert isinstance(fx, ChangeAlertLevel) and (fx.from_level, fx.to_level, fx.ack_reset, fx.raised_event_seq) == ('DANGER', 'WARNING', False, raised)
    assert s.row().event_seq == raised and s.row().acknowledged_ts == 5 and len(s.state.alerts) == 1 and s.state.nodes[1].level == 'WARNING'

def test_GV09_c_clears_after_10_s_below_clear_level():
    s = danger_acked_then_lowered()
    assert s.run(5, co_x10=250) == [] and s.lvl() == 'WARNING'
    assert s.run(1, co_x10=250) == [1] and isinstance(s.fx[0], ClearAlert) and s.row() is None and s.state.nodes[1].level == 'NORMAL'

def test_GV09_separate_run_210_ppm_returns_to_danger_unacknowledged():
    s = danger_acked_then_lowered(); raised = s.row().event_seq
    s.go(co_frame(co_x10=2100)); fx = s.fx[0]
    assert isinstance(fx, ChangeAlertLevel) and (fx.to_level, fx.ack_reset) == ('DANGER', True)
    assert s.row().level == 'DANGER' and s.row().acknowledged_ts is None and s.row().event_seq == raised and len(s.state.alerts) == 1

def test_both_timers_expired_clears_directly_from_danger():
    s = Run(); s.go(co_frame(co_x10=2500), dt_ms=0)
    assert s.run(5, co_x10=100) == [] and s.lvl() == 'DANGER'      # lowering timer running; reading falls below 31.5 on the next frames
    hits = s.run(6, co_x10=250)
    assert hits and isinstance(s.log[-1], ClearAlert) and s.row() is None

def test_event_seq_strictly_increases_over_every_effect():
    s = danger_acked_then_lowered(); s.run(6, co_x10=250); s.go(co_frame(co_x10=520)); seqs = [e.event_seq for e in s.log]
    assert len(seqs) == 4 and seqs == sorted(set(seqs)) and s.state.event_seq == seqs[-1]

# ---- GV-18 a to g, F-15, F-23 ----
def test_GV18_a_to_d_held_then_clears_10_s_after_co_range_clears():
    s = Run(); s.go(co_frame(co_x10=520), dt_ms=0); assert s.lvl() == 'WARNING'                  # (a)
    assert s.run(15, co_x10=200, temp_x100=5600) == [] and s.state.nodes[1].co_reason == 'co_range' and s.lvl() == 'WARNING'   # (b) 30 s
    assert s.run(30, co_x10=200) == [] and s.state.nodes[1].co_range_active and s.lvl() == 'WARNING'  # (c) 58 s inside the range, still active
    s.go(co_frame(co_x10=200))                                                                   # (d) 60 s: co_range clears, no timer yet
    assert not s.state.nodes[1].co_range_active and s.fx == () and s.lvl() == 'WARNING'
    assert s.run(5, co_x10=200) == []                                                            # timer starts on the next frame
    assert s.run(1, co_x10=200) == [1] and isinstance(s.fx[0], ClearAlert) and s.row() is None

def test_GV18_e_escalates_in_place_during_co_range():
    s = Run(); s.go(co_frame(co_x10=520), dt_ms=0); raised = s.row().event_seq; s.ack(); s.run(15, co_x10=200, temp_x100=5600)
    s.go(vector_event('F-23')); fx = s.fx[0]
    assert s.state.nodes[1].co_reason == 'co_range' and isinstance(fx, ChangeAlertLevel) and fx.ack_reset
    assert s.row().level == 'DANGER' and s.row().acknowledged_ts is None and s.row().event_seq == raised

def test_GV18_f_52C_restarts_the_60_s_count():
    s = Run(); s.go(co_frame(co_x10=520), dt_ms=0); s.run(15, co_x10=200, temp_x100=5600); s.run(20, co_x10=200)   # 40 s inside the range
    s.go(co_frame(co_x10=200, temp_x100=5200)); assert s.state.nodes[1].co_range_clear_since_mono is None
    s.run(30, co_x10=200); assert s.state.nodes[1].co_range_active                                # 58 s after the first 25 C frame
    s.go(co_frame(co_x10=200)); assert not s.state.nodes[1].co_range_active                       # 60 s

def test_GV18_g_raises_danger_during_co_range_then_holds():
    s = Run(); n = s.go(vector_event('F-23'), dt_ms=0)
    assert [(type(e), e.level) for e in s.fx] == [(RaiseAlert, 'DANGER')] and (n.co_reason, n.co_ppm, n.level) == ('co_range', 250.0, 'DANGER')
    assert s.run(40, co_x10=200, temp_x100=5600) == [] and s.lvl() == 'DANGER'                    # 80 s: neither lowered nor cleared

def test_F15_20_ppm_outside_range_raises_nothing():
    s = Run(); s.go(vector_event('F-15'), dt_ms=0); assert s.fx == () and s.row() is None and s.state.nodes[1].co_reason == 'co_range'

# ---- thresholds and saturation ----
@pytest.mark.parametrize('x10, level', [(349, None), (350, 'WARNING'), (1999, 'WARNING'), (2000, 'DANGER'), (4949, 'DANGER'), (4950, 'DANGER'), (5000, 'DANGER'), (5200, 'DANGER')])
def test_thresholds(x10, level):
    s = Run(); n = s.go(co_frame(co_x10=x10), dt_ms=0); assert s.lvl() == level
    assert n.co_over_range == (x10 > 5000) and n.co_ppm == min(x10 / 10, 500.0)               # P6a clamp still holds

def test_co_sat_flag_is_danger_at_any_reading():
    ev = co_frame(co_x10=100); s = Run(); s.go(FrameEvent(1, 'OK', 'fresh', {**ev.decoded, 'flags': 1 << 4}), dt_ms=0); assert s.lvl() == 'DANGER'

@pytest.mark.parametrize('lo, hi', [(340, 360), (1980, 2020)])
def test_boundary_oscillation_for_10_min_never_clears_or_lowers(lo, hi):
    s = Run()
    for i in range(300): s.go(co_frame(co_x10=lo if i % 2 == 0 else hi))
    ups = [e for e in s.log if isinstance(e, ChangeAlertLevel)]
    assert not any(isinstance(e, ClearAlert) for e in s.log) and len(ups) <= 1 and all(e.ack_reset for e in ups) and len(s.state.alerts) == 1

# ---- hold rule (14.2 (3)) ----
def test_sht40_hold_resets_the_running_timer_and_held_time_does_not_count():
    s = Run(); s.go(co_frame(co_x10=520), dt_ms=0)
    assert s.run(3, co_x10=200) == []                                    # timer running for 4 s
    assert s.run(15, co_x10=200, status2=SHT_FAULT) == [] and s.lvl() == 'WARNING' and s.state.nodes[1].co_reason == 'sht40_fault'
    s.go(co_frame(co_x10=200)); assert s.state.nodes[1].co_hold_ended and s.fx == ()   # the frame that ends the hold starts nothing
    assert s.run(5, co_x10=200) == [] and s.run(1, co_x10=200) == [1] and s.row() is None

def test_co_fault_has_no_reading_opens_nothing_and_holds():
    s = Run(); s.go(co_frame(co_x10=520, status2=CO_FAULT), dt_ms=0); assert s.row() is None and s.fx == ()
    s.go(co_frame(co_x10=520)); assert s.lvl() == 'WARNING'
    assert s.run(20, co_x10=100, status2=CO_FAULT) == [] and s.lvl() == 'WARNING'

def test_co_timeout_holds_through_ticks_and_the_return_frame_starts_no_timer():
    s = Run(); s.go(co_frame(co_x10=520), dt_ms=0); s.go(co_frame(co_x10=200))
    for _ in range(10): s.go(TickEvent())
    assert s.state.nodes[1].co_reason == 'co_timeout' and s.lvl() == 'WARNING' and s.log[-1].type == 'co_threshold' and len(s.log) == 1
    s.go(co_frame(co_x10=200)); assert s.fx == () and s.state.nodes[1].co_hold_ended
    assert s.run(5, co_x10=200) == [] and s.run(1, co_x10=200) == [1] and s.row() is None

# ---- suspect frames, SCBA, co_rising ----
def test_suspect_frame_raises_and_escalates_but_never_lowers_clears_or_moves_a_timer():
    s = Run(); s.go(co_frame(co_x10=520, seq_class='suspect'), dt_ms=0); assert s.lvl() == 'WARNING' and s.state.nodes[1].level == 'WARNING'
    s.go(co_frame(co_x10=2500, seq_class='suspect')); assert s.lvl() == 'DANGER' and s.fx[0].ack_reset
    for _ in range(10): s.go(co_frame(co_x10=200, seq_class='suspect')); assert s.fx == ()
    n = s.state.nodes[1]; assert s.lvl() == 'DANGER' and n.level == 'DANGER' and n.co_below_clear_since_mono is None and n.co_below_danger_since_mono is None

def test_scba_on_suppresses_without_clearing_or_escalating():
    s = Run(); s.go(co_frame(co_x10=520, scba=1), dt_ms=0); assert s.row() is None
    s.go(co_frame(co_x10=520)); assert s.lvl() == 'WARNING'
    assert s.run(10, co_x10=200, scba=1) == [] and s.lvl() == 'WARNING' and s.state.nodes[1].level == 'NORMAL'   # open but not shown
    s.go(co_frame(co_x10=2500, scba=1)); assert s.lvl() == 'WARNING' and s.fx == ()
    s.go(co_frame(co_x10=520)); assert s.state.nodes[1].level == 'WARNING'

def test_co_rising_is_disabled_and_never_raised():
    s = Run(); assert s.state.co_rising_enabled is False
    for x10 in range(0, 3000, 100): s.go(co_frame(co_x10=x10))
    assert {e.type for e in s.log} == {'co_threshold'}
`);
  replace("host/ppe_host/core/rule_engine.py", String.raw`    reasons: str

# P6a: per-frame CO mode`, String.raw`    reasons: str
    acknowledged_ts: Optional[int] = None  # P6b: set by the Acknowledge action (P7c, P19); cleared when the level escalates in place

@dataclass(frozen=True)
class ChangeAlertLevel(Effect):    # in-place level change of an open row (14.1); event_seq is a new allocation, the row is found by raised_event_seq
    node_id: int
    type: str
    from_level: str
    to_level: str
    ack_reset: bool               # True when escalating (acknowledged_ts becomes NULL), False when lowering (kept)
    raised_event_seq: int
    reasons: str
    changed_ts: int

# P6a: per-frame CO mode`);
  replace("host/ppe_host/core/rule_engine.py", String.raw`(read by P6c)

@dataclass(frozen=True)
class EngineState:`, String.raw`(read by P6c)
    co_suppressed: bool = False   # P6b: SCBA ON on the last fresh frame; an open co_threshold is kept but not shown or counted in the level
    co_below_clear_since_mono: Optional[int] = None   # P6b: first fresh frame of the current run below co_warn_clear_ppm
    co_below_danger_since_mono: Optional[int] = None  # P6b: first fresh frame of the current run below co_danger_clear_ppm (DANGER alert only)

@dataclass(frozen=True)
class EngineState:`);
  replace("host/ppe_host/core/rule_engine.py", String.raw`at most one per key
    episodes: dict`, String.raw`at most one per key
    co_rising_enabled: bool = False                          # P6b: settings co_rising_enabled, set by the shell; no trigger values exist (OPEN), so nothing is raised
    episodes: dict`);
  replace("host/ppe_host/core/rule_engine.py", String.raw`RULES = (co_state_rule,)  # rule functions in evaluation order; later Parts add theirs after this one (node_danger stays last, 14.1)`, String.raw`# ---- P6b: co_threshold, design 14.1 row and 14.2 (3). Level changes happen in place on the open row (14.1). ----
RANK = {'NONE': 0, 'NORMAL': 0, 'WARNING': 1, 'DANGER': 2}
CO_TIMER_MS = K.CO_HYSTERESIS_S * 1000

def set_alert_level(state, node_id, type, level, now, reasons):
    """Change the level of the open alert of that node and type in place (same row, same raise event_seq). Escalating clears
    acknowledged_ts (the siren sounds again); lowering keeps it. No effects if none is open or the level is unchanged."""
    _check_alert(node_id, type, level)
    row = state.alerts.get((node_id, type))
    if row is None or row.level == level: return state, ()
    up = RANK[level] > RANK[row.level]
    state, seq = next_seq(state)
    new = replace(row, level=level, reasons=reasons, acknowledged_ts=None if up else row.acknowledged_ts)
    return (replace(state, alerts={**state.alerts, (node_id, type): new}),
            (ChangeAlertLevel(seq, node_id, type, row.level, level, up, row.event_seq, reasons, now.wall_ms),))

def _node_set(state, nid, **kw):
    n = state.nodes.get(nid, NodeState()); new = replace(n, **kw)
    return state if nid in state.nodes and new == n else replace(state, nodes={**state.nodes, nid: new})

def _refresh_level(state, nid, raise_only):
    """Displayed node level = highest open alert level of the node (a suppressed co_threshold does not count). A suspect frame
    can only raise it (14.1)."""
    n = state.nodes.get(nid, NodeState()); best = n.level if raise_only else 'NORMAL'
    for (a_nid, typ), a in state.alerts.items():
        if a_nid == nid and not (typ == 'co_threshold' and n.co_suppressed) and RANK[a.level] > RANK[best]: best = a.level
    return _node_set(state, nid, level=best)

def _co_target(d):
    """Level the frame's own CO reading asks for: DANGER, WARNING, NONE (a reading below co_warn_ppm), or None (no usable reading
    because of a CO fault, or SCBA ON). Raw value, never the clamped display value."""
    if _bit(d, 'status2', 'co_fault') or _bit(d, 'id_mode', 'scba_on'): return None
    ppm = d['co_x10'] / 10
    if ppm >= K.CO_DANGER_PPM or ppm >= K.CO_SAT_PPM or _bit(d, 'flags', 'co_sat'): return 'DANGER'
    return 'WARNING' if ppm >= K.CO_WARN_PPM else 'NONE'

def _co_timers(state, nid, ppm, scba, now):
    """The two 10 s hysteresis timers of a fresh frame. Held (P6a co_mode not usable, or the frame in which the hold ended), SCBA ON
    or no open alert: both timers are reset and nothing is lowered or cleared. Otherwise clear (below co_warn_clear_ppm, from
    WARNING or DANGER) wins over lowering (DANGER below co_danger_clear_ppm while CO is still at or above co_warn_clear_ppm)."""
    n, mono, row = state.nodes.get(nid, NodeState()), now.mono_ms, state.alerts.get((nid, 'co_threshold'))
    if row is None or scba or n.co_mode != CO_USABLE or n.co_hold_ended:
        return _node_set(state, nid, co_below_clear_since_mono=None, co_below_danger_since_mono=None), ()
    low = ppm < K.CO_WARN_CLEAR_PPM
    clear_since = (mono if n.co_below_clear_since_mono is None else n.co_below_clear_since_mono) if low else None
    dng_since = ((mono if n.co_below_danger_since_mono is None else n.co_below_danger_since_mono)
                 if row.level == 'DANGER' and ppm < K.CO_DANGER_CLEAR_PPM else None)
    fx = ()
    if clear_since is not None and mono - clear_since >= CO_TIMER_MS:
        state, fx = clear_alert(state, nid, 'co_threshold', now, 'CO below the clear level for the hysteresis time'); clear_since = dng_since = None
    elif dng_since is not None and not low and mono - dng_since >= CO_TIMER_MS:
        state, fx = set_alert_level(state, nid, 'co_threshold', 'WARNING', now, f'CO {ppm:.1f} ppm'); dng_since = None
    return _node_set(state, nid, co_below_clear_since_mono=clear_since, co_below_danger_since_mono=dng_since), fx

def co_threshold_rule(state, event, now, mode):
    """Rule 2 of RULES. A fresh frame raises, escalates, lowers or clears; a suspect frame (RAISE_ONLY) may only raise or escalate
    and moves no timer. A high raw reading still raises during a co_range or sht40_fault hold (GV-18 g); a CO fault or CO timeout
    has no reading, so it opens nothing (sensor_fault is P6c). co_rising (14.1b) is present but disabled: EngineState.co_rising_enabled
    is False and the design gives no trigger values (OPEN), so it is never raised."""
    if isinstance(event, TickEvent):               # co_timeout may have begun on this tick: a hold resets running timers (14.2 (3))
        for nid, n in list(state.nodes.items()):
            if n.co_mode != CO_USABLE: state = _node_set(state, nid, co_below_clear_since_mono=None, co_below_danger_since_mono=None)
        return state, ()
    if mode == NONE or event.node_id is None: return state, ()
    nid, d, full = event.node_id, event.decoded, mode == FULL
    n, ppm, scba = state.nodes.get(nid, NodeState()), event.decoded['co_x10'] / 10, bool(_bit(d, 'id_mode', 'scba_on'))
    if full: state = _node_set(state, nid, co_suppressed=scba)
    target, fx, row = _co_target(d), (), state.alerts.get((nid, 'co_threshold'))
    if target in ('WARNING', 'DANGER'):
        why = f'CO {ppm:.1f} ppm' + (f' ({n.co_reason})' if n.co_reason else '')
        if row is None: state, fx = raise_alert(state, nid, 'co_threshold', target, why, now)
        elif RANK[target] > RANK[row.level]: state, fx = set_alert_level(state, nid, 'co_threshold', target, now, why)
    if full:
        state, more = _co_timers(state, nid, ppm, scba, now); fx += more
    return _refresh_level(state, nid, not full), fx

RULES = (co_state_rule, co_threshold_rule)  # rule functions in evaluation order; later Parts add theirs after these (node_danger stays last, 14.1)`);
  replace("host/tests/test_golden_vectors.py", String.raw`from ppe_host.core.rule_engine import (ClearAlert, EngineState, FrameEvent, RaiseAlert, TickEvent, node_level, raise_alert, step)`, String.raw`from ppe_host.core.rule_engine import (ChangeAlertLevel, ClearAlert, EngineState, FrameEvent, RaiseAlert, TickEvent, node_level, raise_alert, step)`);
  replace("host/tests/test_golden_vectors.py", String.raw`    return [('raise', e.node_id, e.type, e.level) if isinstance(e, RaiseAlert) else ('clear', e.node_id, e.type, None) for e in fx]`, String.raw`    return [('raise', e.node_id, e.type, e.level) if isinstance(e, RaiseAlert) else ('level', e.node_id, e.type, e.to_level) if isinstance(e, ChangeAlertLevel)
            else ('clear', e.node_id, e.type, None) for e in fx]`);
  replace("host/tests/test_golden_vectors.py", String.raw`    {'id': 'PH-03', 'gv': 'GV-01 (partial)', 'desc': 'PLACEHOLDER, replaced in P6 by GV-01 (it will raise co_threshold): until a rule exists a fresh F-01 and a timer tick produce no effects and use no event_seq',
     'steps': [{'frame': 'F-01', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [], 'open': [], 'episodes': 0, 'seq_delta': 0, 'levels': {1: 'NORMAL'}}},
               {'tick': True, 'dt_ms': 20000, 'expect': {'effects': [], 'open': [], 'seq_delta': 0}}]},
`, String.raw`    {'id': 'GV-01', 'gv': 'GV-01', 'desc': 'F-01 (node 1, 52.0 ppm, SCBA OFF): a fresh frame raises co_threshold WARNING, node level WARNING, 0 episodes; a later timer tick clears and raises nothing',
     'steps': [{'frame': 'F-01', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'co_threshold', 'WARNING')], 'open': [(1, 'co_threshold', 'WARNING')], 'episodes': 0, 'seq_delta': 1, 'levels': {1: 'WARNING'}}},
               {'tick': True, 'dt_ms': 20000, 'expect': {'effects': [], 'open': [(1, 'co_threshold', 'WARNING')], 'seq_delta': 0}}]},
`);
  replace("host/tests/test_co_state.py", String.raw`def test_rule_does_not_touch_level_alerts_or_event_seq():
    s = Sim()`, String.raw`def test_rule_does_not_touch_level_alerts_or_event_seq(monkeypatch):
    monkeypatch.setattr(re_, 'RULES', (re_.co_state_rule,))   # P6b registers co_threshold after it; this test is about the state rule alone
    s = Sim()`);
  replace("host/tests/test_golden_vectors.py", String.raw`'expect': {'effects': [('raise', 1, 'co_threshold', 'WARNING')], 'open': [(1, 'heat', 'WARNING')]`, String.raw`'expect': {'effects': [('raise', 1, 'heat', 'WARNING')], 'open': [(1, 'heat', 'WARNING')]`);
  append('docs/PROGRESS.md', '- Part 6b done: co_threshold in core/rule_engine.py (WARNING 35, DANGER 200 or co_sat, in-place escalation and de-escalation with ChangeAlertLevel, 10 s clear and lowering timers, hold rule, SCBA suppression, node level), GV-01 case in the harness replaces PH-03, host/tests/test_co_threshold.py');
}
