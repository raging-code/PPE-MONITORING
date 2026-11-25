// patches/part05a_engine_skeleton.mjs  (run from repo root: node patches/part05a_engine_skeleton.mjs [--dry] [--force])
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
  put('host/ppe_host/core/rule_engine.py', String.raw`"""core/rule_engine.py: the pure rule engine, P5 skeleton (design 14.1 and 14.6).
step(state, event, now) -> (state, effects). No database, socket, clock, file or audio access: time arrives only as 'now'
(Now(wall_ms, mono_ms), built by the shell from the injected Clock). State is never mutated; a changed copy is returned.
P5 holds the types, the 14.1 evaluation gate, event_seq allocation and the 'one open alert per node and type' helpers.
Rules are added later by Parts P6 to P7c as functions rule(state, event, now, mode) -> (state, effects) listed in RULES, in order
(node_danger is evaluated last, 14.1). In-place escalation and de-escalation of an open alert is added with the first rule that needs it (P6)."""
from dataclasses import dataclass, field, replace
from typing import Mapping, NamedTuple, Optional
from .. import abi

LEVELS = ('NONE', 'WARNING', 'DANGER')
# The 25 alerts.type values of Migration 0001 (= owner 'alerts' in shared/alert_catalog.json). A test keeps all three in step.
ALERT_TYPES = frozenset(('mayday', 'man_down', 'co_threshold', 'link_lost', 'signal_lost', 'checkin', 'scba_expired', 'sensor_fault',
    'wrist_open', 'wrist_close', 'battery_low', 'heat', 'unauth_alert', 'node_reboot', 'button_stuck', 'missed_event', 'suspect_frame',
    'estimate', 'shadow_notice', 'weak_signal', 'co_warmup', 'co_rising', 'latch_restored', 'watchdog_recovery', 'node_danger'))
VERIFY_VALUES = frozenset(('OK', 'BAD_LEN', 'BAD_CRC', 'BAD_MAC'))  # frames.verify; REJECT_ROSTER is never stored or evaluated
SEQ_CLASSES = frozenset(('fresh', 'duplicate', 'reboot', 'suspect'))
FULL, RAISE_ONLY, NONE = 'full', 'raise_only', 'none'  # evaluation modes (design 14.1)

class Now(NamedTuple):
    wall_ms: int  # UTC ms, for stored timestamps only
    mono_ms: int  # monotonic ms, for every timer

@dataclass(frozen=True)
class FrameEvent:
    node_id: Optional[int]        # id_mode bits 0 to 2 (the claimed node for a failed frame)
    verify: str                   # OK | BAD_LEN | BAD_CRC | BAD_MAC
    seq_class: str                # fresh | duplicate | reboot | suspect
    decoded: Optional[Mapping]    # crypto_abi decoded fields (None for BAD_LEN)

@dataclass(frozen=True)
class TickEvent:
    """A timer wake-up with no frame (the 15 s and 60 s silence rules, 10 s timers). The shell supplies 'now'."""

@dataclass(frozen=True)
class Effect:
    event_seq: int                # allocated by step(); strictly increasing across the database (design 2.1)

@dataclass(frozen=True)
class RaiseAlert(Effect):
    node_id: int
    type: str
    level: str
    reasons: str
    raised_ts: int

@dataclass(frozen=True)
class ClearAlert(Effect):         # event_seq here is the alert row's cleared_event_seq
    node_id: int
    type: str
    raised_event_seq: int         # event_seq of the RaiseAlert that opened the row it clears
    cleared_ts: int
    reason: str

@dataclass(frozen=True)
class OpenAlert:
    node_id: int
    type: str
    level: str
    event_seq: int
    raised_ts: int
    reasons: str

@dataclass(frozen=True)
class NodeState:
    level: str = 'NORMAL'         # displayed node level; P6 onward maintain it

@dataclass(frozen=True)
class EngineState:
    event_seq: int = 0                                       # last allocated event_seq
    nodes: dict = field(default_factory=dict)                # node_id -> NodeState
    alerts: dict = field(default_factory=dict)               # (node_id, type) -> OpenAlert; at most one per key
    episodes: dict = field(default_factory=dict)             # node_id -> active episode; filled by P7c

RULES = ()  # rule functions in evaluation order; P6 onward replace this line

def node_level(state, node_id):
    return state.nodes.get(node_id, NodeState()).level

def open_alert(state, node_id, type):
    return state.alerts.get((node_id, type))

def next_seq(state):
    """Allocate the next event_seq: (new state, seq). The only place event_seq grows."""
    return replace(state, event_seq=state.event_seq + 1), state.event_seq + 1

def _check_alert(node_id, type, level=None):
    if isinstance(node_id, bool) or not isinstance(node_id, int): raise ValueError('node_id must be an int')
    if type not in ALERT_TYPES: raise ValueError(f'unknown alert type: {type}')
    if level is not None and level not in LEVELS: raise ValueError(f'unknown level: {level}')

def raise_alert(state, node_id, type, level, reasons, now):
    """Open an alert. One open alert per node and type: if one is already open nothing changes and there are no effects."""
    _check_alert(node_id, type, level)
    if (node_id, type) in state.alerts: return state, ()
    state, seq = next_seq(state)
    row = OpenAlert(node_id, type, level, seq, now.wall_ms, reasons)
    return replace(state, alerts={**state.alerts, (node_id, type): row}), (RaiseAlert(seq, node_id, type, level, reasons, now.wall_ms),)

def clear_alert(state, node_id, type, now, reason):
    """Close the open alert of that node and type; no effects if none is open."""
    _check_alert(node_id, type)
    row = state.alerts.get((node_id, type))
    if row is None: return state, ()
    state, seq = next_seq(state)
    left = {k: v for k, v in state.alerts.items() if k != (node_id, type)}
    return replace(state, alerts=left), (ClearAlert(seq, node_id, type, row.event_seq, now.wall_ms, reason),)

def eval_mode(event):
    """Design 14.1 gate for a frame: FULL (fresh or reboot, verify OK), RAISE_ONLY (suspect, verify OK: it may only raise or
    escalate, never clear, lower or move a timer), NONE (duplicate, verify other than OK, flags node_level INVALID).
    The one frame the gate never evaluates but a later rule still handles is the BAD_MAC unauth_alert (GV-04, P7)."""
    if event.verify not in VERIFY_VALUES: raise ValueError(f'unknown verify value: {event.verify}')
    if event.seq_class not in SEQ_CLASSES: raise ValueError(f'unknown seq_class: {event.seq_class}')
    if event.verify != 'OK' or event.decoded is None: return NONE
    shift, width = abi.BITS['flags']['node_level']
    if (event.decoded['flags'] >> shift) & ((1 << width) - 1) == abi.ENUMS['node_level']['INVALID']: return NONE
    return RAISE_ONLY if event.seq_class == 'suspect' else FULL if event.seq_class in ('fresh', 'reboot') else NONE

def _run_rules(state, event, now, mode):
    effects = ()
    for rule in RULES:
        state, fx = rule(state, event, now, mode)
        effects += tuple(fx)
    return state, effects

def step(state, event, now):
    """Pure: returns (new state, tuple of effects). Same inputs always give the same outputs."""
    if not isinstance(now, Now): raise TypeError('now must be a Now(wall_ms, mono_ms)')
    if isinstance(event, FrameEvent):
        mode = eval_mode(event)
        return (state, ()) if mode == NONE else _run_rules(state, event, now, mode)
    if isinstance(event, TickEvent): return _run_rules(state, event, now, FULL)
    raise TypeError(f'unknown event: {type(event).__name__}')
`);
  put('host/ppe_host/clock.py', String.raw`"""clock.py: the injected Clock interface (design 1, Clock abstraction; 14.1). Every host timer reads wall_ms() and mono_ms() from a
Clock, never from time.*, so tests and REPLAY control time. P5 holds the interface and FakeClock; P12b adds the real clock here."""
from typing import Protocol
from .core.rule_engine import Now

class Clock(Protocol):
    def wall_ms(self) -> int: ...   # UTC milliseconds (display and stored timestamps)
    def mono_ms(self) -> int: ...   # monotonic milliseconds (all timers)

def now_of(clock):
    return Now(clock.wall_ms(), clock.mono_ms())

def _ms(v, name):
    if isinstance(v, bool) or not isinstance(v, int) or v < 0: raise ValueError(f'{name} must be a non-negative int')
    return v

class FakeClock:
    """Test clock that moves only when told to."""
    def __init__(self, wall_ms=0, mono_ms=0):
        self._wall, self._mono = _ms(wall_ms, 'wall_ms'), _ms(mono_ms, 'mono_ms')
    def wall_ms(self): return self._wall
    def mono_ms(self): return self._mono
    def advance(self, ms):
        """Time passes: both clocks move forward by ms."""
        ms = _ms(ms, 'ms'); self._wall += ms; self._mono += ms
    def set_wall(self, ms):
        """A laptop clock step (NTP): wall time jumps, monotonic time does not."""
        self._wall = _ms(ms, 'wall_ms')
    def now(self):
        return now_of(self)
`);
  put('host/tests/test_rule_engine_core.py', String.raw`"""P5: rule engine skeleton (core/rule_engine.py) and the injected clock (clock.py), design 14.1 and 14.6.
Covers the 14.1 evaluation gate, strictly increasing event_seq, one open alert per node and type, purity (no mutation, same inputs
give same outputs), the rule registry order, the core import rule and FakeClock."""
import ast, copy, json, re
from pathlib import Path
import pytest
from ppe_host import abi
from ppe_host.clock import FakeClock, now_of
from ppe_host.core import rule_engine as re_
from ppe_host.core import crypto_abi as ca
from ppe_host.core.rule_engine import (ALERT_TYPES, EngineState, FrameEvent, Now, TickEvent, clear_alert, eval_mode, next_seq,
                                       open_alert, raise_alert, step)

ROOT = Path(__file__).resolve().parents[2]
VEC = json.loads((ROOT / 'shared' / 'vectors' / 'frames.json').read_text(encoding='utf8'))
F01 = ca.decode_frame(bytes.fromhex(next(f['hex'] for f in VEC['frames'] if f['id'] == 'F-01')))
T0 = Now(1_000_000, 5_000)

def ev(verify='OK', seq_class='fresh', flags=None, node=1, decoded=True):
    d = dict(F01) if decoded else None
    if d is not None and flags is not None: d['flags'] = flags
    return FrameEvent(node, verify, seq_class, d)

def test_alert_types_match_catalog_and_migration():
    cat = json.loads((ROOT / 'shared' / 'alert_catalog.json').read_text(encoding='utf8'))
    sql = (ROOT / 'host' / 'migrations' / '0001.sql').read_text(encoding='utf8')
    seeded = set(re.findall(r"'(\w+)'", re.search(r'INSERT INTO alert_types\(type\) VALUES (.*?);', sql).group(1)))
    assert ALERT_TYPES == {e['type'] for e in cat if e['owner'] == 'alerts'} == seeded and len(ALERT_TYPES) == 25

@pytest.mark.parametrize('verify,seq_class,flags,decoded,mode', [
    ('OK', 'fresh', None, True, 'full'), ('OK', 'reboot', None, True, 'full'), ('OK', 'suspect', None, True, 'raise_only'),
    ('OK', 'duplicate', None, True, 'none'), ('BAD_MAC', 'fresh', None, True, 'none'), ('BAD_CRC', 'suspect', None, True, 'none'),
    ('BAD_LEN', 'fresh', None, False, 'none'), ('OK', 'fresh', 0x03, True, 'none'), ('OK', 'suspect', 0x03, True, 'none'),
    ('OK', 'fresh', 0x02, True, 'full'), ('OK', 'suspect', 0x06, True, 'raise_only')])
def test_eval_gate(verify, seq_class, flags, decoded, mode):
    assert eval_mode(ev(verify, seq_class, flags, decoded=decoded)) == mode

@pytest.mark.parametrize('verify,seq_class', [('REJECT_ROSTER', 'fresh'), ('ok', 'fresh'), ('OK', 'stale'), ('OK', None)])
def test_eval_gate_rejects_unknown_values(verify, seq_class):
    with pytest.raises(ValueError): eval_mode(ev(verify, seq_class))

def test_step_without_rules_changes_nothing():
    s = EngineState()
    for e in (ev(), ev('OK', 'suspect'), ev('BAD_MAC'), TickEvent()):
        s2, fx = step(s, e, T0); assert s2 is s and fx == ()
    with pytest.raises(TypeError): step(s, 'frame', T0)
    with pytest.raises(TypeError): step(s, ev(), (1, 2))

def test_event_seq_strictly_increasing_and_never_reset():
    s, seqs = EngineState(), []
    for _ in range(5): s, q = next_seq(s); seqs.append(q)
    assert seqs == [1, 2, 3, 4, 5] and s.event_seq == 5
    s, fx1 = raise_alert(s, 1, 'co_threshold', 'WARNING', 'r', T0); s, fx2 = clear_alert(s, 1, 'co_threshold', T0, 'x')
    s, fx3 = raise_alert(s, 1, 'co_threshold', 'WARNING', 'r', T0)
    assert [fx1[0].event_seq, fx2[0].event_seq, fx3[0].event_seq] == [6, 7, 8]

def test_one_open_alert_per_node_and_type():
    s, fx = raise_alert(EngineState(), 1, 'man_down', 'DANGER', 'a', T0)
    assert len(fx) == 1 and fx[0].type == 'man_down' and fx[0].raised_ts == T0.wall_ms and open_alert(s, 1, 'man_down').event_seq == 1
    s2, fx2 = raise_alert(s, 1, 'man_down', 'DANGER', 'again', T0)
    assert s2 is s and fx2 == () and s2.event_seq == 1                         # no second row, no event_seq used
    s3, fx3 = raise_alert(s2, 2, 'man_down', 'DANGER', 'b', T0); s3, fx4 = raise_alert(s3, 1, 'mayday', 'DANGER', 'c', T0)
    assert len(fx3) == 1 and len(fx4) == 1 and len(s3.alerts) == 3             # other node or other type is allowed
    s4, fx5 = clear_alert(s3, 1, 'man_down', T0, 'done')
    assert fx5[0].raised_event_seq == 1 and open_alert(s4, 1, 'man_down') is None and len(s4.alerts) == 2
    s5, fx6 = clear_alert(s4, 1, 'man_down', T0, 'again'); assert s5 is s4 and fx6 == ()  # nothing open: nothing to clear
    s6, fx7 = raise_alert(s4, 1, 'man_down', 'DANGER', 'new', T0); assert len(fx7) == 1 and open_alert(s6, 1, 'man_down').event_seq == s4.event_seq + 1

@pytest.mark.parametrize('node,type,level', [(1, 'nope', 'DANGER'), (1, 'man_down', 'HIGH'), ('1', 'man_down', 'DANGER'), (True, 'man_down', 'DANGER')])
def test_raise_alert_rejects_bad_arguments(node, type, level):
    with pytest.raises(ValueError): raise_alert(EngineState(), node, type, level, '', T0)

def test_purity_no_mutation_and_deterministic():
    def run():
        s, out = EngineState(), []
        for i, (n, t) in enumerate([(1, 'heat'), (2, 'heat'), (1, 'heat'), (3, 'checkin')]):
            s, fx = raise_alert(s, n, t, 'WARNING', f'r{i}', Now(10 + i, i)); out.append(fx)
            if i == 3: s, fx = clear_alert(s, 1, 'heat', Now(99, 99), 'end'); out.append(fx)
        return s, out
    a, b = run(), run()
    assert a == b                                                               # same inputs, same state and effects
    s0 = EngineState(); snap = copy.deepcopy(s0); raise_alert(s0, 1, 'heat', 'WARNING', 'r', T0)
    assert s0 == snap and s0.alerts == {}                                       # the input state is untouched

def test_rules_run_in_order_with_mode_and_concatenate_effects():
    calls = []
    def rule_a(state, event, now, mode): calls.append(('a', mode)); return raise_alert(state, 1, 'heat', 'WARNING', 'a', now)
    def rule_b(state, event, now, mode): calls.append(('b', mode)); return raise_alert(state, 1, 'checkin', 'WARNING', 'b', now)
    old = re_.RULES; re_.RULES = (rule_a, rule_b)
    try:
        s, fx = step(EngineState(), ev('OK', 'suspect'), T0)
        assert calls == [('a', 'raise_only'), ('b', 'raise_only')] and [x.type for x in fx] == ['heat', 'checkin'] and [x.event_seq for x in fx] == [1, 2]
        calls.clear(); s, fx = step(EngineState(), TickEvent(), T0); assert calls == [('a', 'full'), ('b', 'full')]
        calls.clear(); s, fx = step(EngineState(), ev('BAD_MAC'), T0); assert calls == [] and fx == ()   # the gate runs before any rule
        calls.clear(); s, fx = step(EngineState(), ev('OK', 'duplicate'), T0); assert calls == [] and fx == ()
    finally: re_.RULES = old

def test_core_import_rule():  # design 14.1 and the guide: core/ imports nothing from io/, services/ or api/ and does no I/O or clock access
    banned = {'time', 'datetime', 'os', 'pathlib', 'sys', 'socket', 'serial', 'sqlite3', 'subprocess', 'shutil', 'winsound', 'asyncio',
              'threading', 'urllib', 'http', 'requests', 'httpx', 'websockets', 'random', 'logging', 'tempfile', 'fastapi'}
    files = sorted((ROOT / 'host' / 'ppe_host' / 'core').glob('*.py')); assert any(f.name == 'rule_engine.py' for f in files)
    for f in files:
        for n in ast.walk(ast.parse(f.read_text(encoding='utf8'))):
            names = []
            if isinstance(n, ast.Import): names = [a.name for a in n.names]
            elif isinstance(n, ast.ImportFrom):
                mod = n.module or ''
                names = [('ppe_host.' + mod if n.level else mod)] if mod else ['ppe_host.' + a.name for a in n.names]
            for m in names:
                assert m.split('.')[0] not in banned, f'{f.name} imports {m}'
                assert not re.match(r'ppe_host\.(io|services|api)\b', m), f'{f.name} imports {m}'
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name): assert n.func.id not in ('open', 'print', 'input'), f'{f.name} calls {n.func.id}'

def test_fake_clock():
    c = FakeClock(1000, 50); assert (c.wall_ms(), c.mono_ms()) == (1000, 50) and c.now() == Now(1000, 50) == now_of(c)
    c.advance(250); assert (c.wall_ms(), c.mono_ms()) == (1250, 300)
    c.set_wall(5); assert (c.wall_ms(), c.mono_ms()) == (5, 300)               # an NTP step moves wall time only
    c.advance(0); assert c.mono_ms() == 300
    for bad in (-1, 1.5, True, '1'):
        with pytest.raises(ValueError): c.advance(bad)
    with pytest.raises(ValueError): FakeClock(-1, 0)
    assert FakeClock().now() == Now(0, 0)
`);
  append('docs/PROGRESS.md', '- Part 5a done: host/ppe_host/core/rule_engine.py (skeleton: types, step, 14.1 gate, event_seq, one open alert per node and type), host/ppe_host/clock.py (Clock, FakeClock), host/tests/test_rule_engine_core.py');
}
