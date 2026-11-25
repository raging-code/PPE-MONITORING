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
    one_shot: bool = False        # P7b: a one-shot notice is stored already closed (cleared_ts = raised_ts) and never held in EngineState.alerts (14.1b)

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
    last_co_ge_warn_mono: Optional[int] = None       # last fresh frame with a usable CO of co_warn_ppm or more and SCBA OFF (read by P6c; set by P6a)
    co_clear_since_mono: Optional[int] = None        # P6b: first fresh frame of the current run below co_warn_clear_ppm (10 s clear timer)
    co_lower_since_mono: Optional[int] = None        # P6b: first fresh frame of the current run below co_danger_clear_ppm (10 s DANGER-to-WARNING timer)
    fault_kinds: frozenset = frozenset()             # P6c: fault kinds shown by the last fresh frame (co, imu, temp; a CO timeout counts as co)
    last_heat_alert_mono: Optional[int] = None       # P6c reads it for condition (ii); P7c sets it, nothing sets it before then
    mandown_prev: Optional[bool] = None              # P7-1: flags bit 2 of the last FRESH frame (None = never seen: a first-seen 1 counts as an edge)
    mayday_prev: Optional[bool] = None               # P7-1: status4 bit 4 of the last fresh frame
    node_danger_streak: int = 0                      # P7-1: consecutive evaluated frames that meet the node_danger condition (14.1)
    last_fresh_mono: Optional[int] = None            # P7-2: mono time of the last FRESH frame (silence clock of signal_lost and link_lost); suspect frames never move it
    last_fresh_adverse: bool = False                 # P7-2: that frame reported WARNING, DANGER or mandown (link_lost after link_lost_adverse_s)
    unauth_count: int = 0                            # P7-2: BAD_MAC frames counted on the open unauth_alert (WebSocket unauth_count)
    unauth_last_seen_ts: Optional[int] = None        # P7-2: wall ms of the last such frame
    wrist_open_since_mono: Optional[int] = None      # P7b: first fresh frame of the current run with status4 bit 0 (wrist connector open)
    wrist_last_open_mono: Optional[int] = None       # P7b: last fresh frame with that bit set (wrist_close_confirm_s counts from it)
    latch_restored_prev: Optional[bool] = None       # P7b: status4 bit 1 of the last fresh frame (None = never seen: a first-seen 1 is an edge)
    restored_prev: Optional[bool] = None             # P7b: status3 bit 4 of the last fresh frame
    evt_unsent_prev: Optional[bool] = None           # P7b: id_mode bit 7 of the last fresh frame
    checkin_prev: Optional[bool] = None              # P7c-2: flags bit 7 (check-in) of the last fresh frame (None = never seen: a first-seen 1 is an edge)
    scba_lower_since_mono: Optional[int] = None      # P7c-2: first fresh frame of the current run below co_warn_clear_ppm on a DANGER scba_expired (10 s lowering timer)
    heat_hot_since_mono: Optional[int] = None        # P7c-3: first fresh frame of the current run at or above heat_warn_c (the 'time' trigger)
    heat_ext_since_mono: Optional[int] = None        # P7c-3: first fresh frame of the current run at or above heat_extreme_c
    heat_hist: tuple = ()                            # P7c-3: (mono, temp_x100) of healthy fresh frames inside heat_rise_window_s (the 'rise' trigger)
    heat_triggers: frozenset = frozenset()           # P7c-3: triggers of the open heat row (time, rise, extreme); each has its own clear condition
    heat_clear_since_mono: Optional[int] = None      # P7c-3: first fresh frame of the current run in which every trigger's clear condition holds (10 s)
    heat_skip_next: bool = False                     # P7c-3: the last frame had a temperature fault, so the next fresh frame is not evaluated (14.1)
    shadow_still_since_mono: Optional[int] = None    # P7c-3: first fresh frame of the current run with motion at or below still_g_default (shadow estimator)
    shadow_rebaseline_left: int = 0                  # P7c-3: fresh frames still to skip after a link recovery (rebaseline_clean_frames)
    suspect_prev: bool = False                       # P8: the last evaluated frame met the suspect_frame condition (a one-shot notice is raised once per run, 14.1b)

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

# ---- P6b: co_threshold, design 14.1 row and 14.2 (3). Reads the P6a state (co_mode, co_hold_ended), so it runs after co_state_rule. ----
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
    clearing = fresh and open_alert(state, nid, 'sensor_fault') is not None and not any(_bit(d, 'status2', b) for b in ('co_fault', 'imu_fault', 'temp_fault'))
    usable = (n.co_mode != CO_NO_READING_HELD if fresh else not _bit(d, 'status2', 'co_fault')) and not clearing   # no reading: CO fault or timeout; P6c: the frame that clears sensor_fault evaluates nothing (14.1)
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

# ---- P6c: sensor_fault, design 14.1 row. Runs after co_threshold_rule, which skips the frame that clears it ("from the next fresh valid frame only"). ----
FAULT_BITS = (('co_fault', 'co'), ('imu_fault', 'imu'), ('temp_fault', 'temp'))   # status2 bits 4, 5, 6; a CO timeout is also kind 'co'
FAULT_NAMES = {'co': 'co_fault', 'imu': 'imu_fault', 'temp': 'temp_fault'}

def _sf_danger(state, nid, kinds, now):
    """Why a sensor_fault of these kinds is DANGER now (14.1 (i) or (ii)), else None. (ii) reads last_heat_alert_mono, which P7c sets."""
    n, mono, win = state.nodes.get(nid, NodeState()), now.mono_ms, K.SENSOR_FAULT_DANGER_WINDOW_S * 1000
    if 'co' in kinds and n.last_co_ge_warn_mono is not None and mono - n.last_co_ge_warn_mono <= win: return 'recent_co_ge_warn'
    if 'temp' in kinds and (open_alert(state, nid, 'heat') is not None or (n.last_heat_alert_mono is not None and mono - n.last_heat_alert_mono <= win)): return 'heat'
    return None

def _sensor_fault(state, nid, kinds, new, names, now):
    """Open at the level decided on the first frame that shows a fault; escalate a WARNING in place when a fault of another kind
    (a kind not shown before) meets (i) or (ii). Never lowered."""
    row, text = open_alert(state, nid, 'sensor_fault'), ','.join(names)
    if row is None:
        why = _sf_danger(state, nid, kinds, now)
        return raise_alert(state, nid, 'sensor_fault', 'DANGER' if why else 'WARNING', text + (f' danger:{why}' if why else ''), now)
    why = _sf_danger(state, nid, new, now) if row.level == 'WARNING' and new else None
    return set_alert_level(state, nid, 'sensor_fault', 'DANGER', f'{text} danger:{why}', now) if why else (state, ())

def sensor_fault_rule(state, event, now, mode):
    """Rule 3 of RULES. Triggers: status2 bits 4, 5, 6 and no valid CO for co_fault_timeout_s (a tick). The wrist-lost trigger is not built:
    the design names no bit for it (open question). A suspect frame may open or escalate but never clears and only adds to the kinds seen."""
    if mode == NONE: return state, ()
    fx = ()
    if isinstance(event, TickEvent):
        for nid, n in list(state.nodes.items()):
            if n.co_reason == 'co_timeout' and 'co' not in n.fault_kinds:
                state, more = _sensor_fault(state, nid, n.fault_kinds | {'co'}, frozenset(('co',)), ('co_timeout',), now); fx += more
                state = replace(state, nodes={**state.nodes, nid: replace(state.nodes[nid], fault_kinds=n.fault_kinds | {'co'})})
                state = refresh_level(state, nid, 0, True)
        return state, fx
    if event.node_id is None: return state, ()
    nid, d, fresh = event.node_id, event.decoded, mode == FULL
    n = state.nodes.get(nid, NodeState())
    kinds = frozenset(k for b, k in FAULT_BITS if _bit(d, 'status2', b))
    if kinds: state, fx = _sensor_fault(state, nid, kinds, kinds - n.fault_kinds, sorted(FAULT_NAMES[k] for k in kinds), now)
    elif fresh: state, fx = clear_alert(state, nid, 'sensor_fault', now, 'fault_bits_clear')   # all fault bits 0 and valid readings resume
    seen = kinds if fresh else n.fault_kinds | kinds
    cur = state.nodes.get(nid, NodeState())
    if cur.fault_kinds != seen or nid not in state.nodes: state = replace(state, nodes={**state.nodes, nid: replace(cur, fault_kinds=seen)})
    return refresh_level(state, nid, _bit(d, 'flags', 'node_level'), not fresh), fx

# ---- P7-1: man_down, mayday (alerts only; the episode half is P7c) and node_danger, design 14.1 rows. node_danger stays LAST in RULES (14.1). ----
def _why(d):
    return f"flags=0x{d['flags']:02x} status2=0x{d['status2']:02x} status3=0x{d['status3']:02x} status4=0x{d['status4']:02x}"

def man_down_rule(state, event, now, mode):
    """man_down on flags bit 2 (mandown) 0->1 or first-seen 1, mayday on status4 bit 4 0->1 or first-seen 1; both DANGER. The 'before' value is the
    last FRESH frame's bit (None = never seen), so a suspect frame can raise but never moves the baseline (14.1). Nothing here clears: the alert
    rows close only when an operator resolves the episode (P7c), and a latch that stays set after Resolve is a level, not an edge, so it raises nothing."""
    if not isinstance(event, FrameEvent) or event.node_id is None or mode == NONE: return state, ()
    nid, d, fresh = event.node_id, event.decoded, mode == FULL
    n, fx = state.nodes.get(nid, NodeState()), ()
    md, my = bool(_bit(d, 'flags', 'mandown')), bool(_bit(d, 'status4', 'mayday'))
    state, fx = _episode_edges(state, nid, n, md, my, now)   # P7c-1: the episode opens or upgrades BEFORE the alert rows, so alerts.episode_id can link
    if md and not n.mandown_prev: state, more = raise_alert(state, nid, 'man_down', 'DANGER', _why(d), now); fx += more
    if my and not n.mayday_prev:
        state, more = raise_alert(state, nid, 'mayday', 'DANGER', _why(d), now); fx += more
    if fresh: state, more = _man_down_label(state, nid, d, now); fx += more
    if fresh and (n.mandown_prev, n.mayday_prev) != (md, my):
        cur = state.nodes.get(nid, n); state = replace(state, nodes={**state.nodes, nid: replace(cur, mandown_prev=md, mayday_prev=my)})
    return refresh_level(state, nid, _bit(d, 'flags', 'node_level'), not fresh), fx

def node_danger_rule(state, event, now, mode):
    """Catch-all, evaluated last: the node reports DANGER (flags level 2), mandown is 0 and no OTHER open alert of the node is at DANGER, on the
    node_danger_confirm_frames-th consecutive evaluated frame. A fresh frame that does not meet it resets the streak, a suspect one leaves it
    (and a suspect one that meets it counts). Clears on a fresh frame with level not DANGER, with mandown 1, or when another DANGER alert exists."""
    if not isinstance(event, FrameEvent) or event.node_id is None or mode == NONE: return state, ()
    nid, d, fresh = event.node_id, event.decoded, mode == FULL
    n, fx = state.nodes.get(nid, NodeState()), ()
    lvl, md = _bit(d, 'flags', 'node_level'), bool(_bit(d, 'flags', 'mandown'))
    other = any(a.level == 'DANGER' for (a_nid, t), a in state.alerts.items() if a_nid == nid and t != 'node_danger')
    meets = lvl == abi.ENUMS['node_level']['DANGER'] and not md and not other
    streak = n.node_danger_streak + 1 if meets else (0 if fresh else n.node_danger_streak)
    if meets and streak >= K.NODE_DANGER_CONFIRM_FRAMES: state, fx = raise_alert(state, nid, 'node_danger', 'DANGER', _why(d), now)
    elif fresh and not meets and open_alert(state, nid, 'node_danger') is not None:
        state, fx = clear_alert(state, nid, 'node_danger', now, 'mandown' if md else 'superseded' if other else 'node_level_not_danger')
    cur = state.nodes.get(nid, n)
    if cur.node_danger_streak != streak or nid not in state.nodes: state = replace(state, nodes={**state.nodes, nid: replace(cur, node_danger_streak=streak)})
    return refresh_level(state, nid, lvl, not fresh), fx

# ---- P7-2: battery_low, signal_lost / link_lost and unauth_alert, design 14.1 rows and 14.1b. node_danger stays LAST (14.1). ----
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

# ---- P7b: notice and badge types, design 14.1b. All level NONE: they never change a node level or open an episode. Evaluated on FRESH verified
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

# ---- P7c-1: episode lifecycle (MAN_DOWN and MAYDAY), operator Acknowledge and Resolve, and the MAN_DOWN label rule, design 14.1 (man_down / mayday row),
# 2.3 (episodes), 3.3 and 3.8. One active episode per node (idx_episodes_one_active). Episodes close ONLY through ResolveEpisodeEvent; Acknowledge never closes a
# safety alert (only unauth_alert closes on Acknowledge, 14.1b). checkin, scba_expired, heat and the shadow estimator are P7c-2 and P7c-3. ----
RESOLVE_REASONS = ('rescued', 'false_alarm', 'device_removed')
EPISODE_ALERT_TYPES = ('man_down', 'mayday')
NO_RESPONSE, MOVEMENT_DETECTED = 'no_response', 'movement_detected'

@dataclass(frozen=True)
class Episode:
    node_id: int
    kind: str                       # MAN_DOWN | MAYDAY
    state: str                      # OPEN | ACKNOWLEDGED (a RESOLVED episode leaves EngineState.episodes)
    opened_event_seq: int           # identifies the row for the writer
    opened_ts: int
    acknowledged_ts: Optional[int] = None
    acknowledged_by: Optional[int] = None
    motion_state: Optional[str] = NO_RESPONSE   # man_down_motion_state; None for MAYDAY (no such label)
    move_since_mono: Optional[int] = None       # first fresh frame of the current run above STILL_G (label to movement_detected after mandown_move_label_s)
    still_since_mono: Optional[int] = None      # first fresh frame of the current run at or below STILL_G (label back after mandown_still_revert_s)

@dataclass(frozen=True)
class AckAlertEvent:                # operator: POST /api/alerts/{alert_id}/ack (idempotent)
    node_id: int
    type: str
    operator_id: Optional[int] = None

@dataclass(frozen=True)
class AckEpisodeEvent:              # operator: POST /api/episodes/{episode_id}/ack (acknowledges the episode and its open alert rows)
    node_id: int
    operator_id: Optional[int] = None

@dataclass(frozen=True)
class ResolveEpisodeEvent:          # operator: Resolve with a reason (rescued, false_alarm, device_removed)
    node_id: int
    reason: str
    operator_id: Optional[int] = None

@dataclass(frozen=True)
class EpisodeOpened(Effect):        # emitted BEFORE the RaiseAlert of the same frame, so the writer can link alerts.episode_id
    node_id: int
    kind: str
    opened_ts: int

@dataclass(frozen=True)
class EpisodeEscalated(Effect):     # MAN_DOWN -> MAYDAY in place (audit EPISODE_ESCALATED)
    node_id: int
    old_kind: str
    kind: str
    ts: int

@dataclass(frozen=True)
class EpisodeLabelChanged(Effect):  # incremental episode WebSocket message (man_down_motion_state)
    node_id: int
    motion_state: str
    ts: int

@dataclass(frozen=True)
class EpisodeAcknowledged(Effect):
    node_id: int
    operator_id: Optional[int]
    ts: int

@dataclass(frozen=True)
class EpisodeResolved(Effect):
    node_id: int
    kind: str
    reason: str
    operator_id: int
    ts: int

@dataclass(frozen=True)
class AlertAcknowledged(Effect):    # sets alerts.acknowledged_ts and acknowledged_by on the row identified by raised_event_seq
    node_id: int
    type: str
    raised_event_seq: int
    operator_id: Optional[int]
    ts: int

def _put_episode(state, ep): return replace(state, episodes={**state.episodes, ep.node_id: ep})

def _episode_edges(state, nid, n, md, my, now):
    """Open an episode on a mandown or mayday edge (0->1 or first-seen 1) when the node has none; upgrade an active MAN_DOWN to MAYDAY in place on a mayday edge.
    An edge while an episode is active adds no episode (and no alert: the open rows stay, 14.1)."""
    md_edge, my_edge, ep = md and not n.mandown_prev, my and not n.mayday_prev, state.episodes.get(nid)
    if ep is None and (md_edge or my_edge):
        kind = 'MAYDAY' if my else 'MAN_DOWN'
        state, seq = next_seq(state)
        return _put_episode(state, Episode(nid, kind, 'OPEN', seq, now.wall_ms, motion_state=None if kind == 'MAYDAY' else NO_RESPONSE)), (EpisodeOpened(seq, nid, kind, now.wall_ms),)
    if ep is not None and my_edge and ep.kind == 'MAN_DOWN':
        state, seq = next_seq(state)
        return _put_episode(state, replace(ep, kind='MAYDAY', motion_state=None, move_since_mono=None, still_since_mono=None)), (EpisodeEscalated(seq, nid, 'MAN_DOWN', 'MAYDAY', now.wall_ms),)
    return state, ()

def _man_down_label(state, nid, d, now):
    """Spec 7: chest movement above STILL_G for mandown_move_label_s changes the label to movement_detected; mandown_still_revert_s of renewed stillness reverts it.
    Fresh frames only (the caller checks); card, siren and level never change. MAYDAY has no label."""
    ep = state.episodes.get(nid)
    if ep is None or ep.kind != 'MAN_DOWN': return state, ()
    mono, moving = now.mono_ms, d['motion_x100'] / 100 > K.STILL_G_DEFAULT
    mv, st, label = ep.move_since_mono, ep.still_since_mono, ep.motion_state
    if label == NO_RESPONSE:
        mv, st = ((mono if mv is None else mv) if moving else None), None
        if mv is not None and mono - mv >= K.MANDOWN_MOVE_LABEL_S * 1000: label, mv = MOVEMENT_DETECTED, None
    else:
        st, mv = ((mono if st is None else st) if not moving else None), None
        if st is not None and mono - st >= K.MANDOWN_STILL_REVERT_S * 1000: label, st = NO_RESPONSE, None
    new = replace(ep, motion_state=label, move_since_mono=mv, still_since_mono=st)
    if new == ep: return state, ()
    state = _put_episode(state, new)
    if label == ep.motion_state: return state, ()
    state, seq = next_seq(state)
    return state, (EpisodeLabelChanged(seq, nid, label, now.wall_ms),)

def _ack_row(state, nid, type, operator_id, now):
    row = state.alerts.get((nid, type))
    if row is None or row.acknowledged_ts is not None: return state, ()
    state, seq = next_seq(state)
    return replace(state, alerts={**state.alerts, (nid, type): replace(row, acknowledged_ts=now.wall_ms)}), (AlertAcknowledged(seq, nid, type, row.event_seq, operator_id, now.wall_ms),)

def operator_step(state, event, now):
    """Acknowledge and Resolve. Acknowledge sets acknowledged_ts and never clears a row, except unauth_alert, which closes with it (14.1b, GV-10).
    Resolve is the only way an episode ends; it also clears the episode's man_down and mayday rows. A latch still set on the jacket stays a level, not an edge."""
    nid = event.node_id
    _check_alert(nid, getattr(event, 'type', 'man_down'))
    ep = state.episodes.get(nid)
    if isinstance(event, AckAlertEvent):
        state, fx = _ack_row(state, nid, event.type, event.operator_id, now)
        if event.type == 'unauth_alert' and (nid, 'unauth_alert') in state.alerts:
            state, more = clear_alert(state, nid, 'unauth_alert', now, 'acknowledged'); fx += more
            if nid in state.nodes: state = replace(state, nodes={**state.nodes, nid: replace(state.nodes[nid], unauth_count=0)})
        return state, fx
    if isinstance(event, AckEpisodeEvent):
        if ep is None or ep.state == 'ACKNOWLEDGED': return state, ()
        state, seq = next_seq(state); fx = (EpisodeAcknowledged(seq, nid, event.operator_id, now.wall_ms),)
        state = _put_episode(state, replace(ep, state='ACKNOWLEDGED', acknowledged_ts=now.wall_ms, acknowledged_by=event.operator_id))
        for t in EPISODE_ALERT_TYPES: state, more = _ack_row(state, nid, t, event.operator_id, now); fx += more
        return state, fx
    if event.reason not in RESOLVE_REASONS or event.operator_id is None: raise ValueError('Resolve needs a reason from RESOLVE_REASONS and an operator')
    if ep is None: return state, ()
    state, seq = next_seq(state); fx = (EpisodeResolved(seq, nid, ep.kind, event.reason, event.operator_id, now.wall_ms),)
    state = replace(state, episodes={k: v for k, v in state.episodes.items() if k != nid})
    for t in EPISODE_ALERT_TYPES + ('shadow_notice',): state, more = clear_alert(state, nid, t, now, 'resolved'); fx += more   # P7c-3: a notice has no episode of its own, Resolve reaches it through the node's episode (14.1b)
    if nid in state.nodes: state = replace(state, nodes={**state.nodes, nid: replace(state.nodes[nid], shadow_still_since_mono=None)})   # the stillness run restarts
    latched = state.nodes.get(nid, NodeState()).mandown_prev          # the jacket latch is cleared only by the jacket CANCEL: until a frame says so the node still reports DANGER
    return refresh_level(state, nid, 2 if latched else 0, False), fx

# ---- P7c-2: checkin and scba_expired, design 14.1 rows. Both may open (or, for scba_expired, escalate) on a suspect frame; neither clears, lowers or moves a timer
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

# ---- P7c-3: heat (14.1 row, 14.2 (4), Summary D5) and the 14.2 (5) shadow estimator with its shadow_notice badge. Fresh frames only: a suspect frame never starts,
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

# ---- P8: suspect_frame, the one-shot notice of 14.1b (level NONE, stored with cleared_ts = raised_ts, never held in state.alerts). Condition: verify OK and
# (seq_class suspect, or a reserved status bit set). It runs on suspect frames too (raise-only gate): it only raises. Raised on the frame where the condition
# becomes true and not again while the run lasts; a fresh or reboot frame without the condition ends the run, a suspect frame never does. Frames the gate drops
# (flags level 3, verify other than OK) never raise it. ----
def suspect_frame_rule(state, event, now, mode):
    if not isinstance(event, FrameEvent) or event.node_id is None or mode == NONE: return state, ()
    nid, d, fx = event.node_id, event.decoded, ()
    n = state.nodes.get(nid, NodeState())
    reserved = any(d.get(f, 0) & m for f, m in abi.RESERVED_MASK.items())
    cond = event.seq_class == 'suspect' or reserved
    if cond and not n.suspect_prev:
        state, fx = raise_notice(state, nid, 'suspect_frame', ('reserved_bit ' if reserved else '') + f"seq={d['seq']} boot_ctr={d['boot_ctr']} " + _why(d), now)
    prev = True if cond else (False if mode == FULL else n.suspect_prev)
    cur = state.nodes.get(nid, n)
    if cur.suspect_prev != prev or nid not in state.nodes: state = replace(state, nodes={**state.nodes, nid: replace(cur, suspect_prev=prev)})
    return state, fx

RULES = (co_state_rule, co_threshold_rule, sensor_fault_rule, battery_low_rule, heat_rule, shadow_rule, link_rule, checkin_rule, scba_expired_rule, suspect_frame_rule, notice_rule, man_down_rule, node_danger_rule)  # evaluation order; new rules go before man_down_rule, node_danger_rule stays last (14.1)

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
        return (unauth_alert_rule(state, event, now) if mode == NONE else _run_rules(state, event, now, mode))   # P7-2: a BAD_MAC frame that claims an alert is the one frame outside the gate (14.1b)
    if isinstance(event, TickEvent): return _run_rules(state, event, now, FULL)
    if isinstance(event, (AckAlertEvent, AckEpisodeEvent, ResolveEpisodeEvent)): return operator_step(state, event, now)   # P7c-1: operator actions
    raise TypeError(f'unknown event: {type(event).__name__}')
