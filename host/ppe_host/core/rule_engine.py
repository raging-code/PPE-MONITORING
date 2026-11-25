"""core/rule_engine.py: the pure rule engine, P5 skeleton (design 14.1 and 14.6).
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
