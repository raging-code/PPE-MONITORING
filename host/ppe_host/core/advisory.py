"""core/advisory.py: the Tier 1 advisory table of design 14.3 (P9). Pure: no database, clock, file or audio access.
advisory_step(state, adv, event, now, cfg, rebuild) -> (state, adv, effects). The shell calls it after every step() with the same event and 'now'
(a frame or a TickEvent). Per active node (a node in state.nodes) it evaluates every cfg.eval_s and on any level transition, takes the first matching row of
the 14.3 table, and emits an AdvisoryRow only when the risk changes, plus one heartbeat row every cfg.heartbeat_s. Rows take their event_seq from the same
sequence as every other effect (state.event_seq), so advisory_summaries.event_seq stays unique across the database.
Rebuild mode (14.6): the state is returned as in live mode and the effects are empty, so recovery writes no advisory row.
window_s and the 30 s cadence are module constants (docs/adr/0001.md): the design gives no key for them and constants.json is frozen.
heartbeat_s is the settings key advisory_heartbeat_s; core cannot read files, so the shell passes it in AdvisoryConfig."""
from dataclasses import dataclass, field, replace
from typing import Optional
from .. import constants as K
from .rule_engine import FULL, Effect, FrameEvent, eval_mode, next_seq

ADVISORY_WINDOW_S = 60   # advisory_summaries.window_s: seconds of history a row covers (ADR 0001)
ADVISORY_EVAL_S = 30     # 14.3: evaluated every 30 s per active node (ADR 0001: no constants key)
RISKS = ('CRITICAL_LIFE_SAFETY', 'TOXIC_ATMOSPHERE', 'COMMS_LOSS_ADVERSE', 'ELEVATED_EXPOSURE', 'DEGRADED_TELEMETRY', 'NOMINAL')  # = the advisory_summaries CHECK
QUALITIES = ('high', 'medium', 'low')

# 14.3 table, in design order: (level, reasons that match (None = any other reason), risk, fixed action text). First match for the node's level wins.
TABLE = (
    ('DANGER', frozenset(('mayday', 'man_down')), 'CRITICAL_LIFE_SAFETY', 'Dispatch RIT immediately; verify voice contact and last known sector.'),
    ('DANGER', frozenset(('co_threshold', 'scba_expired')), 'TOXIC_ATMOSPHERE', 'Order immediate withdrawal to fresh air; verify SCBA cylinder supply.'),
    ('DANGER', frozenset(('link_lost',)), 'COMMS_LOSS_ADVERSE', 'Treat responder as missing; initiate PAR check and relay search.'),
    ('DANGER', frozenset(('sensor_fault', 'node_danger')), 'DEGRADED_TELEMETRY', 'Responder reports DANGER with unreliable or unidentified data: confirm by voice radio now and order withdrawal if there is no answer.'),
    ('WARNING', frozenset(('co_threshold', 'heat')), 'ELEVATED_EXPOSURE', 'Monitor exposure duration; prepare rotation and verify SCBA seal.'),
    ('WARNING', frozenset(('sensor_fault', 'signal_lost', 'battery_low')), 'DEGRADED_TELEMETRY', 'Confirm responder status by voice radio; plan battery/unit swap.'),
    ('WARNING', frozenset(('checkin',)), 'DEGRADED_TELEMETRY', 'Responder has not answered the stillness prompt: confirm by voice radio now.'),
    ('WARNING', None, 'DEGRADED_TELEMETRY', 'Confirm responder status by voice radio.'),
    ('DANGER', None, 'DEGRADED_TELEMETRY', 'Responder reports DANGER with unidentified data: confirm by voice radio now and order withdrawal if there is no answer.'),
)
NOMINAL_ACTION = 'Continue routine 2 s telemetry monitoring.'

def advise(level, reasons):
    """Design 14.3: (risk, action) for a node level ('NORMAL', 'WARNING', 'DANGER') and the set of reason types. NORMAL is NOMINAL.
    The two fallback rows mean every level other than NORMAL matches a row."""
    if level == 'NORMAL': return 'NOMINAL', NOMINAL_ACTION
    if level not in ('WARNING', 'DANGER'): raise ValueError(f'unknown level: {level}')
    reasons = frozenset(reasons)
    for lv, match, risk, action in TABLE:
        if lv == level and (match is None or reasons & match): return risk, action
    raise AssertionError('unreachable: the fallback rows match every WARNING and DANGER level')

def reasons_of(state, node_id, level):
    """Reason types of a node: its open alerts whose level equals the node level. Notices (level NONE) are never a reason."""
    return frozenset(a.type for (nid, _), a in state.alerts.items() if nid == node_id and a.level == level)

@dataclass(frozen=True)
class AdvisoryConfig:
    heartbeat_s: int                      # settings key advisory_heartbeat_s (300); no default on purpose, the shell passes it
    window_s: int = ADVISORY_WINDOW_S
    eval_s: int = ADVISORY_EVAL_S
    period_s: int = K.ROUTINE_PERIOD_S    # routine frame period: window_s / period_s frames fill the window

@dataclass(frozen=True)
class AdvisoryRow(Effect):                # one advisory_summaries row (source 'table'; passage_ids is NULL in Tier 1)
    node_id: int
    ts: int
    window_s: int
    risk: str
    reasons: str
    action: str
    quality: str
    source: str = 'table'
    passage_ids: Optional[str] = None
    heartbeat: bool = False               # True when written by the heartbeat and not by a risk change (the table has no column for it)

@dataclass(frozen=True)
class NodeAdvisory:
    last_level: Optional[str] = None
    last_risk: Optional[str] = None
    last_row_mono: Optional[int] = None
    last_eval_mono: Optional[int] = None
    frames: tuple = ()                    # mono ms of the evaluated (fresh or reboot, verify OK) frames inside the window

@dataclass(frozen=True)
class AdvisoryState:
    nodes: dict = field(default_factory=dict)   # node_id -> NodeAdvisory

def quality_of(fault, frame_count, cfg):
    """high: no fault and the window at least 80 % covered; medium: no fault and 50 to under 80 %; low: any fault or under 50 %.
    Coverage = frames seen in the window / (window_s / period_s), compared in integers."""
    cover = frame_count * cfg.period_s * 100             # percent of the window, times window_s
    if fault or cover < 50 * cfg.window_s: return 'low'
    return 'high' if cover >= 80 * cfg.window_s else 'medium'

def has_fault(state, node_id):
    n = state.nodes[node_id]
    return bool(n.fault_kinds) or n.co_validity == 'UNRELIABLE' or (node_id, 'sensor_fault') in state.alerts

def _trim(frames, mono, cfg): return tuple(t for t in frames if mono - cfg.window_s * 1000 < t <= mono)

def advisory_step(state, adv, event, now, cfg, rebuild=False):
    nodes = dict(adv.nodes)
    if isinstance(event, FrameEvent) and event.node_id is not None and eval_mode(event) == FULL:
        na = nodes.get(event.node_id, NodeAdvisory()); nodes[event.node_id] = replace(na, frames=_trim(na.frames + (now.mono_ms,), now.mono_ms, cfg))
    fx = ()
    for nid in sorted(state.nodes):
        na, level = nodes.get(nid, NodeAdvisory()), state.nodes[nid].level
        due = na.last_eval_mono is None or now.mono_ms - na.last_eval_mono >= cfg.eval_s * 1000 or now.mono_ms - na.last_row_mono >= cfg.heartbeat_s * 1000   # the heartbeat is never delayed by the 30 s step
        if not (due or na.last_level != level): nodes[nid] = na; continue
        reasons = reasons_of(state, nid, level)
        risk, action = advise(level, reasons)
        beat = na.last_risk is not None and risk == na.last_risk and now.mono_ms - na.last_row_mono >= cfg.heartbeat_s * 1000
        write = na.last_risk is None or risk != na.last_risk or beat
        frames = _trim(na.frames, now.mono_ms, cfg)
        if write:
            state, seq = next_seq(state)
            fx += (AdvisoryRow(seq, nid, now.wall_ms, cfg.window_s, risk, ' '.join(sorted(reasons)) or 'none', action,
                               quality_of(has_fault(state, nid), len(frames), cfg), heartbeat=beat),)
        nodes[nid] = replace(na, last_level=level, last_risk=risk, last_eval_mono=now.mono_ms, frames=frames,
                             last_row_mono=now.mono_ms if write else na.last_row_mono)
    return state, AdvisoryState(nodes), (() if rebuild else fx)
