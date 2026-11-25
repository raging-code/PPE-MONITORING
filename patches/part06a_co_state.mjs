// patches/part06a_co_state.mjs  (run from repo root: node patches/part06a_co_state.mjs [--dry] [--force])
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
  replace(RE, 'from .. import abi\n\nLEVELS', 'from .. import abi\nfrom .. import constants as K\n\nLEVELS');
  replace(RE, String.raw`@dataclass(frozen=True)
class NodeState:
    level: str = 'NORMAL'         # displayed node level; P6 onward maintain it
`, String.raw`# P6a: per-frame CO mode (NodeState.co_mode), set by co_state_rule and read by P6b and P6c (design 14.2 (1) and (3))
CO_USABLE = 'usable'                    # VALID or DERATED: the reading is usable and nothing is held
CO_USABLE_HELD = 'usable_held'          # UNRELIABLE for co_range or sht40_fault: the raw reading still counts (GV-18 g), open alerts are held
CO_NO_READING_HELD = 'no_reading_held'  # co_fault or co_timeout: no usable reading, open alerts are held

@dataclass(frozen=True)
class NodeState:
    level: str = 'NORMAL'         # displayed node level (P6b and later Parts maintain it)
    co_validity: str = 'VALID'    # VALID | DERATED | UNRELIABLE (14.2 (1))
    co_reason: Optional[str] = None        # None | co_fault | co_timeout | co_range | sht40_fault
    co_mode: str = CO_USABLE
    co_hold_ended: bool = False   # True only on the step in which a hold ended: P6b and P6c start their 10 s timers on the NEXT fresh frame
    co_ppm: Optional[float] = None         # last usable reading, display value (clamped); None until one arrives, never 0 for "no reading"
    co_over_range: bool = False   # last usable frame had a reading above co_clamp_max_ppm (raw co_x10 is stored by the writer, not here)
    co_range_active: bool = False
    co_range_clear_since_mono: Optional[int] = None  # first fresh frame inside the narrowed band of the current run
    co_fault: bool = False        # status2 bit 4 of the last fresh frame
    sht40_fault: bool = False     # status2 bit 6 of the last fresh frame
    co_warmup: bool = False       # status3 bit 2 of the last fresh frame
    last_valid_co_mono: Optional[int] = None         # last fresh frame without a CO fault (co_timeout clock)
    last_co_ge_warn_mono: Optional[int] = None       # last fresh frame with a usable CO of co_warn_ppm or more and SCBA OFF (read by P6c)
`);
  replace(RE, 'RULES = ()  # rule functions in evaluation order; P6 onward replace this line', String.raw`# ---- P6a: CO state, design 14.2 (1) and (2). This rule raises and clears no alert and never changes event_seq. ----
def _bit(decoded, field, name):
    shift, width = abi.BITS[field][name]
    return (decoded[field] >> shift) & ((1 << width) - 1)

def co_classify(n, now_mono):
    """(co_validity, co_reason, co_mode) of a NodeState at now_mono. Reasons are checked in the order 14.2 (1) lists them."""
    if n.co_fault: return 'UNRELIABLE', 'co_fault', CO_NO_READING_HELD
    if n.last_valid_co_mono is not None and now_mono - n.last_valid_co_mono > K.CO_FAULT_TIMEOUT_S * 1000:
        return 'UNRELIABLE', 'co_timeout', CO_NO_READING_HELD
    if n.co_range_active: return 'UNRELIABLE', 'co_range', CO_USABLE_HELD
    if n.sht40_fault: return 'UNRELIABLE', 'sht40_fault', CO_USABLE_HELD
    return ('DERATED' if n.co_warmup else 'VALID'), None, CO_USABLE

def _co_range(n, d, mono, sht40_fault):
    """14.2 (2): (active, clear_since). Judged from the SHT40 of the same frame and only while it is healthy."""
    if sht40_fault: return n.co_range_active, None            # not judged; the clear count restarts when the SHT40 is healthy again
    t, h = d['temp_x100'], d['hum']
    if t > K.CO_RANGE_TEMP_MAX_C * 100 or t < K.CO_RANGE_TEMP_MIN_C * 100 or h < K.CO_RANGE_RH_MIN_PCT or h > K.CO_RANGE_RH_MAX_PCT:
        return True, None                                     # limits themselves are inside the range
    if not n.co_range_active: return False, None
    in_band = ((K.CO_RANGE_TEMP_MIN_C + K.CO_RANGE_MARGIN_C) * 100 <= t <= (K.CO_RANGE_TEMP_MAX_C - K.CO_RANGE_MARGIN_C) * 100
               and K.CO_RANGE_RH_MIN_PCT + K.CO_RANGE_MARGIN_RH_PCT <= h <= K.CO_RANGE_RH_MAX_PCT - K.CO_RANGE_MARGIN_RH_PCT)
    if not in_band: return True, None                         # inside the range but outside the margins restarts the count
    since = mono if n.co_range_clear_since_mono is None else n.co_range_clear_since_mono
    return (False, None) if mono - since >= K.CO_RANGE_CLEAR_S * 1000 else (True, since)

def _co_frame(n, d, now):
    """New NodeState after one fresh (FULL) frame."""
    mono = now.mono_ms
    co_fault, sht40 = bool(_bit(d, 'status2', 'co_fault')), bool(_bit(d, 'status2', 'temp_fault'))
    active, since = _co_range(n, d, mono, sht40)
    ppm, over, last_valid, warn = n.co_ppm, n.co_over_range, n.last_valid_co_mono, n.last_co_ge_warn_mono
    if not co_fault:                                          # a CO fault frame carries no usable reading: keep the last one, never 0
        raw = d['co_x10'] / 10
        ppm, over, last_valid = min(raw, K.CO_CLAMP_MAX_PPM), raw > K.CO_CLAMP_MAX_PPM, mono
        if raw >= K.CO_WARN_PPM and not _bit(d, 'id_mode', 'scba_on'): warn = mono
    cand = replace(n, co_fault=co_fault, sht40_fault=sht40, co_warmup=bool(_bit(d, 'status3', 'co_warmup')), co_range_active=active,
                   co_range_clear_since_mono=since, co_ppm=ppm, co_over_range=over, last_valid_co_mono=last_valid, last_co_ge_warn_mono=warn)
    validity, reason, mode = co_classify(cand, mono)
    return replace(cand, co_validity=validity, co_reason=reason, co_mode=mode, co_hold_ended=(n.co_mode != CO_USABLE and mode == CO_USABLE))

def co_state_rule(state, event, now, mode):
    """Rule 1 of RULES. Fresh frames (mode FULL) update the node's CO state; a TickEvent only lets co_timeout begin. Suspect frames
    (RAISE_ONLY) change nothing here: they neither count towards nor restart the co_range clear time (14.2 (2))."""
    if isinstance(event, FrameEvent):
        if mode != FULL or event.node_id is None: return state, ()
        changes = {event.node_id: _co_frame(state.nodes.get(event.node_id, NodeState()), event.decoded, now)}
    else:
        changes = {}
        for nid, n in state.nodes.items():
            validity, reason, cmode = co_classify(n, now.mono_ms)
            changes[nid] = replace(n, co_validity=validity, co_reason=reason, co_mode=cmode, co_hold_ended=False)
    nodes = {**state.nodes, **{k: v for k, v in changes.items() if state.nodes.get(k) != v}}
    return (state, ()) if nodes == state.nodes else (replace(state, nodes=nodes), ())

RULES = (co_state_rule,)  # rule functions in evaluation order; later Parts add theirs after this one (node_danger stays last, 14.1)`);
  // P5 test: 'no rules' is now set up explicitly, because the first rule is registered (the only edit to an earlier test)
  replace('host/tests/test_rule_engine_core.py', 'def test_step_without_rules_changes_nothing():\n    s = EngineState()',
    "def test_step_without_rules_changes_nothing(monkeypatch):\n    monkeypatch.setattr(re_, 'RULES', ())   # P6a registers the first rule, so 'no rules' is set up here\n    s = EngineState()");
  put('host/tests/test_co_state.py', String.raw`"""P6a: CO state only (design 14.2 (1) and (2), GV-18 state halves). The rule raises and clears no alert, so these tests assert
state fields only, never effects: they stay true after P6b and P6c. Later stages import co_frame and Sim from this file.
Frames are built from the decoded F-01 with the fields a case needs; F-15, F-23 and F-24 come from shared/vectors/frames.json."""
import copy, json
from pathlib import Path
import pytest
from ppe_host import abi
from ppe_host.clock import FakeClock
from ppe_host.core import crypto_abi as ca
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import (CO_NO_READING_HELD, CO_USABLE, CO_USABLE_HELD, EngineState, FrameEvent, NodeState, TickEvent, step)

ROOT = Path(__file__).resolve().parents[2]
VEC = json.loads((ROOT / 'shared' / 'vectors' / 'frames.json').read_text(encoding='utf8'))
KEY, SYS = bytes.fromhex(VEC['key_hex']), VEC['sys_id']
HEX = {f['id']: f['hex'] for f in VEC['frames']}
BASE = ca.decode_frame(bytes.fromhex(HEX['F-01']))
CO_FAULT = 1 << abi.BITS['status2']['co_fault'][0]
SHT_FAULT = 1 << abi.BITS['status2']['temp_fault'][0]
WARMUP = 1 << abi.BITS['status3']['co_warmup'][0]

def co_frame(co_x10=200, temp_x100=2500, hum=50, status2=0, status3=0, scba=0, seq_class='fresh', node=1):
    """A verified frame for the CO tests. Defaults: node 1, 20.0 ppm, 25 C, 50 %RH, SCBA OFF."""
    d = dict(BASE); id_mode = 0x40 | node | (0x08 if scba else 0)
    d.update(co_x10=co_x10, temp_x100=temp_x100, hum=hum, status2=status2, status3=status3, id_mode=id_mode, scba_on=scba)
    return FrameEvent(node, 'OK', seq_class, d)

def vector_event(fid, seq_class='fresh'):
    r = ca.classify_frame(bytes.fromhex(HEX[fid]), KEY, SYS)
    return FrameEvent(r.node_id, r.result, seq_class, r.decoded)

class Sim:
    """Runs events through step() with a FakeClock. go() advances the clock first (default 2 s, the routine period) and returns node 1."""
    def __init__(self): self.clock, self.state = FakeClock(1_700_000_000_000, 10_000), EngineState()
    def go(self, event, dt_ms=2000):
        self.clock.advance(dt_ms); self.state, _ = step(self.state, event, self.clock.now()); return self.state.nodes.get(1)
    def frames(self, n, **kw):
        for _ in range(n): node = self.go(co_frame(**kw))
        return node

def test_rule_is_registered_first():
    assert re_.RULES[0] is re_.co_state_rule

# ---- 14.2 (1) validity ----
def test_valid_reading_defaults():
    n = Sim().go(co_frame(co_x10=520), dt_ms=0)
    assert (n.co_validity, n.co_reason, n.co_mode, n.co_ppm, n.co_over_range, n.co_range_active) == ('VALID', None, CO_USABLE, 52.0, False, False)

def test_warmup_is_derated_and_keeps_the_reading():
    n = Sim().go(co_frame(co_x10=400, status3=WARMUP), dt_ms=0)
    assert (n.co_validity, n.co_reason, n.co_mode, n.co_ppm) == ('DERATED', None, CO_USABLE, 40.0)

def test_warmup_does_not_hide_a_reason():
    n = Sim().go(co_frame(temp_x100=5600, status3=WARMUP), dt_ms=0)
    assert (n.co_validity, n.co_reason) == ('UNRELIABLE', 'co_range')

def test_co_fault_is_unreliable_keeps_last_valid_reading_and_has_no_reading():
    s = Sim(); s.go(co_frame(co_x10=120), dt_ms=0)
    n = s.go(co_frame(co_x10=520, status2=CO_FAULT))          # the faulty frame's 52.0 is not a reading
    assert (n.co_validity, n.co_reason, n.co_mode, n.co_ppm) == ('UNRELIABLE', 'co_fault', CO_NO_READING_HELD, 12.0)
    n = Sim().go(co_frame(co_x10=0, status2=CO_FAULT), dt_ms=0)
    assert n.co_ppm is None and n.co_ppm != 0                  # never 0 ppm

def test_co_fault_frame_is_not_a_valid_co_frame_and_never_sets_the_warn_stamp():
    n = Sim().go(co_frame(co_x10=520, status2=CO_FAULT), dt_ms=0)
    assert n.last_valid_co_mono is None and n.last_co_ge_warn_mono is None

def test_co_timeout_after_more_than_5_s():
    s = Sim(); s.go(co_frame(co_x10=300), dt_ms=0)
    assert s.go(TickEvent(), 5000).co_reason is None            # exactly co_fault_timeout_s is not "more than"
    n = s.go(TickEvent(), 1)
    assert (n.co_validity, n.co_reason, n.co_mode, n.co_ppm) == ('UNRELIABLE', 'co_timeout', CO_NO_READING_HELD, 30.0)
    n = s.go(co_frame(co_x10=310))                              # a fresh valid frame ends it
    assert (n.co_validity, n.co_reason, n.co_mode, n.co_hold_ended) == ('VALID', None, CO_USABLE, True)
    assert s.go(co_frame(co_x10=310)).co_hold_ended is False    # only on the step in which the hold ended

def test_tick_without_nodes_changes_nothing():
    s0 = EngineState(); s1, fx = step(s0, TickEvent(), FakeClock(0, 0).now()); assert s1 is s0 and fx == ()

def test_sht40_fault_is_unreliable_usable_held_and_ends_with_hold_ended():
    s = Sim(); n = s.go(co_frame(status2=SHT_FAULT), dt_ms=0)
    assert (n.co_validity, n.co_reason, n.co_mode) == ('UNRELIABLE', 'sht40_fault', CO_USABLE_HELD)
    n = s.go(co_frame())
    assert (n.co_validity, n.co_reason, n.co_mode, n.co_hold_ended) == ('VALID', None, CO_USABLE, True)

def test_co_fault_beats_range_and_sht40_in_the_reason_order():
    n = Sim().go(co_frame(temp_x100=5600, status2=CO_FAULT | SHT_FAULT), dt_ms=0)
    assert n.co_reason == 'co_fault'

# ---- 14.2 (2) co_range: GV-18 a to d and f, state halves ----
def test_GV_18_a_inside_the_range_nothing_active():
    n = Sim().go(co_frame(co_x10=520, temp_x100=2500), dt_ms=0)
    assert (n.co_range_active, n.co_validity) == (False, 'VALID')

@pytest.mark.parametrize('fid', ['F-15', 'F-23'])
def test_GV_18_vectors_56C_give_co_range_active(fid):
    n = Sim().go(vector_event(fid), dt_ms=0)
    assert (n.co_range_active, n.co_validity, n.co_reason, n.co_mode) == (True, 'UNRELIABLE', 'co_range', CO_USABLE_HELD)

def test_F_24_signed_minus_5_C_is_inside_the_range():
    n = Sim().go(vector_event('F-24'), dt_ms=0)                 # an unsigned decode would read 650.36 C and activate co_range
    assert (n.co_range_active, n.co_validity) == (False, 'VALID')

@pytest.mark.parametrize('temp,hum,active', [(5500, 50, False), (5501, 50, True), (-1000, 50, False), (-1001, 50, True),
                                             (2500, 15, False), (2500, 14, True), (2500, 90, False), (2500, 91, True)])
def test_co_range_boundaries_limits_are_inside(temp, hum, active):
    assert Sim().go(co_frame(temp_x100=temp, hum=hum), dt_ms=0).co_range_active is active

def test_GV_18_b_c_d_clears_on_the_frame_60_s_after_the_first_inside_margin_frame():
    s = Sim(); n = s.frames(16, temp_x100=5600, co_x10=200)    # (b) 30 s outside
    assert (n.co_range_active, n.co_reason) == (True, 'co_range')
    n = s.go(co_frame(co_x10=200)); assert n.co_range_active                   # first inside-margin frame: count starts
    for _ in range(29): n = s.go(co_frame(co_x10=200))         # (c) 58 s after it
    assert n.co_range_active and n.co_reason == 'co_range'
    n = s.go(co_frame(co_x10=200))                             # (d) 60 s after it
    assert (n.co_range_active, n.co_validity, n.co_reason, n.co_mode, n.co_hold_ended) == (False, 'VALID', None, CO_USABLE, True)
    assert s.go(co_frame(co_x10=200)).co_hold_ended is False

def test_GV_18_f_a_52_C_frame_restarts_the_count():
    s = Sim(); s.frames(2, temp_x100=5600)
    for _ in range(21): s.go(co_frame())                       # 40 s inside the margins
    n = s.go(co_frame(temp_x100=5200)); assert n.co_range_active and n.co_range_clear_since_mono is None   # 52 C: inside the range, outside the 50 C margin
    n = s.go(co_frame()); assert n.co_range_active             # temperature back to 25 C: count restarts here
    for _ in range(29): n = s.go(co_frame())
    assert n.co_range_active                                   # 58 s after it
    assert s.go(co_frame()).co_range_active is False           # 60 s after it

@pytest.mark.parametrize('temp,hum,inside', [(5000, 50, True), (5001, 50, False), (-500, 50, True), (-501, 50, False),
                                             (2500, 20, True), (2500, 19, False), (2500, 85, True), (2500, 86, False)])
def test_clear_band_edges(temp, hum, inside):
    s = Sim(); s.go(co_frame(temp_x100=5600), dt_ms=0); n = s.go(co_frame(temp_x100=temp, hum=hum))
    assert (n.co_range_clear_since_mono is not None) is inside

def test_suspect_frames_neither_count_nor_restart_nor_activate():
    s = Sim(); s.go(co_frame(temp_x100=5600), dt_ms=0); s.go(co_frame())      # count starts on the second frame
    since = s.state.nodes[1].co_range_clear_since_mono
    for _ in range(14): s.go(co_frame())
    n = s.go(co_frame(temp_x100=5800, seq_class='suspect')); assert n.co_range_clear_since_mono == since   # outside: no restart
    for _ in range(14): n = s.go(co_frame())
    n = s.go(co_frame(seq_class='suspect')); assert n.co_range_active              # inside, 60 s after the start: does not count
    assert s.go(co_frame()).co_range_active is False                               # the next fresh frame does
    s2 = Sim(); s2.go(co_frame(), dt_ms=0); assert s2.go(co_frame(temp_x100=5600, seq_class='suspect')).co_range_active is False   # no activation either

def test_co_range_is_not_judged_while_the_sht40_is_faulted():
    s = Sim(); n = s.go(co_frame(temp_x100=6000, status2=SHT_FAULT), dt_ms=0)
    assert (n.co_range_active, n.co_reason) == (False, 'sht40_fault')
    s = Sim(); s.go(co_frame(temp_x100=5600), dt_ms=0); s.go(co_frame())
    n = s.go(co_frame(status2=SHT_FAULT)); assert (n.co_range_active, n.co_range_clear_since_mono, n.co_reason) == (True, None, 'co_range')   # frozen, count restarted

# ---- over-range and the warn stamp ----
@pytest.mark.parametrize('co_x10,over,shown', [(5000, False, 500.0), (5001, True, 500.0), (5200, True, 500.0), (3000, False, 300.0)])
def test_over_range_clamps_the_display_and_leaves_the_raw_value(co_x10, over, shown):
    ev = co_frame(co_x10=co_x10); n = Sim().go(ev, dt_ms=0)
    assert (n.co_over_range, n.co_ppm) == (over, shown) and ev.decoded['co_x10'] == co_x10   # raw co_x10 is untouched (5200 is stored as 5200)

@pytest.mark.parametrize('co_x10,scba,stamped', [(350, 0, True), (349, 0, False), (350, 1, False), (5200, 0, True)])
def test_last_co_ge_warn_mono(co_x10, scba, stamped):
    s = Sim(); n = s.go(co_frame(co_x10=co_x10, scba=scba), dt_ms=0)
    assert n.last_co_ge_warn_mono == (s.clock.mono_ms() if stamped else None)

def test_warn_stamp_keeps_its_time_and_follows_a_usable_held_reading():
    s = Sim(); s.go(co_frame(co_x10=400), dt_ms=0); t = s.clock.mono_ms(); n = s.go(co_frame(co_x10=100))
    assert n.last_co_ge_warn_mono == t                                          # a lower reading leaves the stamp
    n = s.go(co_frame(co_x10=2500, temp_x100=5600)); assert n.last_co_ge_warn_mono == s.clock.mono_ms()   # GV-18 g: a held reading is still a reading

def test_suspect_frame_never_sets_the_stamp_or_the_reading():
    s = Sim(); s.go(co_frame(co_x10=100), dt_ms=0); n = s.go(co_frame(co_x10=900, seq_class='suspect'))
    assert (n.co_ppm, n.last_co_ge_warn_mono) == (10.0, None)

# ---- purity and independence from the other rules ----
def test_state_is_not_mutated_and_replay_is_deterministic():
    def run():
        s = Sim(); [s.go(co_frame(co_x10=x, temp_x100=t)) for x, t in ((100, 2500), (400, 5600), (200, 2500))]; return s.state
    assert run() == run()
    s0 = EngineState(); snap = copy.deepcopy(s0); step(s0, co_frame(), FakeClock(0, 0).now()); assert s0 == snap

def test_other_nodes_are_independent():
    s = Sim(); s.go(co_frame(temp_x100=5600, node=2), dt_ms=0); s.go(co_frame(node=1))
    assert (s.state.nodes[1].co_range_active, s.state.nodes[2].co_range_active) == (False, True)

def test_rule_does_not_touch_level_alerts_or_event_seq():
    s = Sim(); s.frames(5, co_x10=2500, temp_x100=5600)
    assert (s.state.nodes[1].level, s.state.alerts, s.state.event_seq) == ('NORMAL', {}, 0)
`);
  append('docs/PROGRESS.md', '- Part 6a done: CO state in core/rule_engine.py (co_validity, co_reason, co_range with its 60 s clear, co_over_range and clamp, last_co_ge_warn_mono, co_mode and co_hold_ended; no alerts), host/tests/test_co_state.py');
}
