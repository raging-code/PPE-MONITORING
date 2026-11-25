"""core/rule_engine.py: the pure rule engine, P5 skeleton (design 14.1 and 14.6).
step(state, event, now) -> (state, effects). No database, socket, clock, file or audio access: time arrives only as 'now'
(Now(wall_ms, mono_ms), built by the shell from the injected Clock). State is never mutated; a changed copy is returned.
P5 holds the types, the 14.1 evaluation gate, event_seq allocation and the 'one open alert per node and type' helpers.
Rules are added later by Parts P6 to P7c as functions rule(state, event, now, mode) -> (state, effects) listed in RULES, in order
(node_danger is evaluated last, 14.1). In-place escalation and de-escalation of an open alert is added with the first rule that needs it (P6)."""
from dataclasses import dataclass, field, replace
from typing import Mapping, NamedTuple, Optional
from .. import abi
from .. import constants as K

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

# P6a: per-frame CO mode (NodeState.co_mode), set by co_state_rule and read by P6b and P6c (design 14.2 (1) and (3))
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

@dataclass(frozen=True)
class EngineState:
    event_seq: int = 0                                       # last allocated event_seq
    nodes: dict = field(default_factory=dict)                # node_id -> NodeState
    alerts: dict = field(default_factory=dict)               # (node_id, type) -> OpenAlert; at most one per key
    episodes: dict = field(default_factory=dict)             # node_id -> active episode; filled by P7c

# ---- P6a: CO state, design 14.2 (1) and (2). This rule raises and clears no alert and never changes event_seq. ----
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

RULES = (co_state_rule,)  # rule functions in evaluation order; later Parts add theirs after this one (node_danger stays last, 14.1)

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
