"""api/models.py (P18a): every WebSocket message and the REST error envelope as Pydantic v2 models (design 3.8 and 3.13).
One discriminated union on "type" per direction, plus WsMessage (both directions) for the schema export of P18b. Every model forbids extra
fields and has no defaults (v and type are always sent and always required), so a key or token can not ride on a server message by accident. Readings of the design that 3.8 leaves open are in docs/adr/0005.md.
Imports nothing from core/, io/ or services/. Level values are uppercase on the wire; a node level is NORMAL, WARNING or DANGER and an alert level is NONE, WARNING or DANGER."""
from typing import Annotated, Any, Literal, Optional, Union
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

SCHEMA_VERSION = 1
NodeLevel = Literal['NORMAL', 'WARNING', 'DANGER']
AlertLevel = Literal['NONE', 'WARNING', 'DANGER']
Bit = Literal[0, 1]
Byte = Annotated[int, Field(ge=0, le=255)]
CoValidity = Literal['VALID', 'DERATED', 'UNRELIABLE']
Posture = Literal['UPRIGHT', 'LOW_LEANING', 'HORIZONTAL', 'UNKNOWN']
LinkState = Literal['not_connected', 'ok', 'weak_signal', 'signal_lost', 'link_lost', 'recovered']
SeqClass = Literal['fresh', 'duplicate', 'reboot', 'suspect']
SessionMode = Literal['LIVE', 'SIMULATOR', 'REPLAY']
EpisodeKind = Literal['MAN_DOWN', 'MAYDAY']
EpisodeState = Literal['OPEN', 'ACKNOWLEDGED', 'RESOLVED']
ResolveReason = Literal['rescued', 'false_alarm', 'device_removed']
MotionState = Literal['no_response', 'movement_detected']
BannerKind = Literal['host_gap', 'logging_fault']  # the two banners an operator may acknowledge (design 3.8)
# The 25 types of the alert_types seed (0001.sql) and alert_catalog.json; a test keeps the three lists equal.
ALERT_TYPES = ('mayday', 'man_down', 'co_threshold', 'link_lost', 'signal_lost', 'checkin', 'scba_expired', 'sensor_fault', 'wrist_open', 'wrist_close', 'battery_low',
               'heat', 'unauth_alert', 'node_reboot', 'button_stuck', 'missed_event', 'suspect_frame', 'estimate', 'shadow_notice', 'weak_signal', 'co_warmup',
               'co_rising', 'latch_restored', 'watchdog_recovery', 'node_danger')
AlertType = Literal[ALERT_TYPES]
# REST error codes (design 3.8, Proposed): a response with a code outside this list is a bug.
ERROR_CODES = ('BAD_REQUEST', 'UNAUTHENTICATED', 'ORIGIN_REJECTED', 'NOT_FOUND', 'RECOVERING', 'STATE_CONFLICT', 'VALIDATION_ERROR', 'INTERNAL_ERROR')
ErrorCode = Literal[ERROR_CODES]
RETRY_AFTER_CODES = ('RECOVERING', 'UNAUTHENTICATED')  # the only codes whose retry_after_s may be set (recovering_target_s; the login backoff)

class _Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')

class _Server(_Strict):  # envelope of every host-to-dashboard message
    v: Literal[1]
    srv_seq: int = Field(ge=0)   # per connection, assigned by that socket's sender task
    srv_ts: int = Field(ge=0)    # UTC ms

class ErrorEnvelope(_Strict):
    error_code: ErrorCode
    detail: str
    retry_after_s: Optional[float]
    @model_validator(mode='after')
    def retry_only_where_allowed(self):
        if self.retry_after_s is not None and self.error_code not in RETRY_AFTER_CODES: raise ValueError('retry_after_s must be null for ' + self.error_code)
        return self

# ---- pieces shared by the snapshot and the incremental messages ----
class RosterRow(_Strict):
    node_id: int = Field(ge=1, le=7)
    alias: str
    active: Bit
class SessionInfo(_Strict):
    session_id: int
    started_ts: int
    mode: SessionMode
    session_label: Optional[str]
class ScbaCorrection(_Strict):
    recorded_ts: int
    operator: str
class NodeSnap(_Strict):  # measurements are null until the node's first verified frame (a rostered node never heard is NOT HEARD)
    node_id: int = Field(ge=1, le=7)
    alias: str
    last_rx_ts: Optional[int]
    co_ppm: Optional[float]
    temp_c: Optional[float]
    hum_pct: Optional[int]
    motion_g: Optional[float]
    bat_pct: Optional[int]
    scba: Optional[Bit]
    mandown: Optional[Bit]
    level: Optional[NodeLevel]
    link_state: LinkState
    status2: Optional[Byte]
    flags: Optional[Byte]
    id_mode: Optional[Byte]
    status3: Optional[Byte]
    status4: Optional[Byte]
    co_validity: CoValidity
    co_reason: Optional[str]
    scba_correction: Optional[ScbaCorrection]
class AlertBody(_Strict):  # alert_type, not type: the envelope already owns "type" (docs/adr/0005.md)
    alert_id: int
    node_id: Optional[int]    # null for base-wide
    alert_type: AlertType
    level: AlertLevel
    reasons: Optional[str]
    authenticated: Bit
    episode_id: Optional[int]
    raised_ts: int
    cleared_ts: Optional[int]
    acknowledged_ts: Optional[int]
    acknowledged_by: Optional[int]  # operator_id
    unauth_count: Optional[int]     # unauth_alert only
    last_seen_ts: Optional[int]     # unauth_alert only
class EpisodeBody(_Strict):
    episode_id: int
    node_id: int = Field(ge=1, le=7)
    kind: EpisodeKind
    state: EpisodeState
    man_down_motion_state: Optional[MotionState]  # null for MAYDAY
    resolve_reason: Optional[ResolveReason]
    operator: Optional[str]                       # display name
class HostGap(_Strict):
    gap_s: float
    reason: Optional[Literal['db_restored']]
class Banners(_Strict):
    base_offline: bool
    logging_fault: bool
    host_gap: Optional[HostGap]
    host_power: str
    audio_fault: bool

# ---- host to dashboard ----
class SnapshotMsg(_Server):
    type: Literal['snapshot']
    srv_seq: Literal[0]       # the snapshot starts every connection's counter
    epoch: UUID               # one per host start
    recovering: bool
    monitoring_active: bool
    session: SessionInfo
    roster: list[RosterRow]
    nodes: list[NodeSnap]
    open_alerts: list[AlertBody]
    open_episodes: list[EpisodeBody]
    co_history_30m: dict[str, list[list[float]]]  # node_id -> [[ts, ppm], ...]
    banners: Banners
    constants: dict[str, Any]                      # the whole constants.json; the dashboard hard-codes no threshold
class ReadingMsg(_Server):
    type: Literal['reading']
    node_id: int = Field(ge=1, le=7)
    alias: str
    rx_ts: int
    co_ppm: float             # raw, un-clamped; the dashboard clamps its display
    co_over_range: Bit
    co_validity: CoValidity
    co_reason: Optional[str]
    temp_c: float
    hum_pct: int
    motion_g: float
    posture: Posture
    stillness_s: float
    bat_pct: int
    scba: Bit
    mandown: Bit
    level: NodeLevel
    reasons: list[str]
    seq_class: SeqClass
    rssi: Optional[float]
    snr: Optional[float]
    status2: Byte             # raw status bytes: the 3.10 hotspot map runs from them
    flags: Byte
    id_mode: Byte
    status3: Byte
    status4: Byte
class AlertMsg(_Server, AlertBody):
    type: Literal['alert']
class EpisodeMsg(_Server, EpisodeBody):
    type: Literal['episode']
class LinkMsg(_Server):
    type: Literal['link']
    node_id: int = Field(ge=1, le=7)
    state: LinkState
    since_ts: int
    last_state: Optional[LinkState]
class SystemMsg(_Server):
    type: Literal['system']
    base: Literal['ok', 'offline']
    recovering: bool
    session_id: int
    session_mode: SessionMode
    rejected_frames: int
    logging_fault: bool
    host_gap: Optional[HostGap]
    host_power: str
    audio_fault: bool
    banner: Optional[BannerKind]        # set only on a banner acknowledgement (BANNER_ACK)
    acknowledged_ts: Optional[int]
class AdvisoryMsg(_Server):
    type: Literal['advisory']
    node_id: int = Field(ge=1, le=7)
    risk: str
    reasons: str
    action: str
    quality: Literal['high', 'medium', 'low']
    source: str
class MlMsg(_Server):  # Tier 2: defined, never sent in Tier 1
    type: Literal['ml']
    node_id: int = Field(ge=1, le=7)
    forecast_5min_ppm: Optional[float]
    early_warning: bool
    anomaly_unusual: bool
    cohb_low: Optional[float]
    cohb_high: Optional[float]
class TickMsg(_Server):
    type: Literal['tick']

# ---- dashboard to host ----
class AuthMsg(_Strict):  # first message on /ws and /ws/tick, within ws_auth_timeout_s
    v: Literal[1]
    type: Literal['auth']
    token: str = Field(min_length=1)
class HbMsg(_Strict):    # 1 Hz on /ws
    v: Literal[1]
    type: Literal['hb']
    srv_ts: int = Field(ge=0)

SERVER_TYPES = (SnapshotMsg, ReadingMsg, AlertMsg, EpisodeMsg, LinkMsg, SystemMsg, AdvisoryMsg, MlMsg, TickMsg)
CLIENT_TYPES = (AuthMsg, HbMsg)
ServerMessage = Annotated[Union[SERVER_TYPES], Field(discriminator='type')]
ClientMessage = Annotated[Union[CLIENT_TYPES], Field(discriminator='type')]
WsMessage = Annotated[Union[SERVER_TYPES + CLIENT_TYPES], Field(discriminator='type')]
SERVER_ADAPTER, CLIENT_ADAPTER, WS_ADAPTER = TypeAdapter(ServerMessage), TypeAdapter(ClientMessage), TypeAdapter(WsMessage)
def parse_client(raw):  # str, bytes or dict; raises pydantic.ValidationError for an unknown v or type, a missing field or an extra field
    return CLIENT_ADAPTER.validate_json(raw) if isinstance(raw, (str, bytes)) else CLIENT_ADAPTER.validate_python(raw)
def parse_server(raw):
    return SERVER_ADAPTER.validate_json(raw) if isinstance(raw, (str, bytes)) else SERVER_ADAPTER.validate_python(raw)
# ---- REST bodies (P19-1; the rest of the frozen endpoint list follows in P19-2 and P19c) ----
class LoginReq(_Strict):
    token: str = Field(min_length=1)
class LoginResp(_Strict):
    operator_id: int
    display_name: str
    session_id: int
EventRecordType = Literal['alert_raised', 'alert_cleared', 'audit', 'system', 'advisory']
class EventRow(_Strict):  # one row of v_events (11 DDL): never a frame row, no raw_hex, no measurement column
    event_seq: int
    log_ts: int
    record_type: EventRecordType
    node_id: Optional[int]
    level: Optional[str]
    code: str
    detail: Optional[str]
    operator_id: Optional[int]
class EventsResp(_Strict):
    events: list[EventRow]
    last_seq: int
# ---- REST bodies (P19-2): session start and end, Acknowledge, Resolve (design 3.8) ----
class EmptyReq(_Strict):  # the ack bodies are {} (or no body at all)
    pass
class SessionStartReq(_Strict):
    session_label: Optional[str] = None
class SessionStartResp(_Strict):
    session_id: int
    started_ts: int
    mode: SessionMode
    monitoring_active: Literal[True]
class SessionEndReq(_Strict):  # confirm_text is a plain str: a wrong value is 400 BAD_REQUEST (design 8), not a 422 schema failure
    confirm_text: str
    session_id: int
class SessionEndResp(_Strict):
    closed_session_id: int
    new_session_id: int
    backup_ok: bool
class AckAlertResp(_Strict):
    alert_id: int
    acknowledged_ts: int
    acknowledged_by: int
class AckEpisodeResp(_Strict):
    episode_id: int
    state: Literal['ACKNOWLEDGED']
    acknowledged_ts: int
    acknowledged_by: int
class ResolveReq(_Strict):  # a reason outside the three is 422 VALIDATION_ERROR
    reason: ResolveReason
class ResolveResp(_Strict):
    episode_id: int
    state: Literal['RESOLVED']
    resolved_ts: int
    resolve_reason: ResolveReason
    resolved_by: int
    latch_still_set: bool
# ---- REST bodies (P19c-1): GET /api/sessions and POST /api/dashboard-outage (design 3.8) ----
class SessionListRow(_Strict):  # one row of GET /api/sessions; highest_level_by_node maps a node id (as a string) to WARNING or DANGER, a node with no alert above a notice is absent
    session_id: int
    started_ts: int
    ended_ts: Optional[int]
    duration_s: float
    mode: SessionMode
    session_label: Optional[str]
    end_kind: Optional[Literal['ENDED', 'CLEAN_SHUTDOWN', 'ABANDONED']]
    alert_count: int
    unresolved_episodes: int
    highest_level_by_node: dict[str, Literal['WARNING', 'DANGER']]
class OutageReq(_Strict):  # times are UTC milliseconds like every stored timestamp, duration_s is seconds
    started_ts: int
    ended_ts: int
    duration_s: float = Field(allow_inf_nan=False)
class OutageResp(_Strict):
    logged: Literal[True]
# ---- REST bodies (P19c-2): SCBA correction and banner acknowledgement (design 3.8); the response of scba-correction is ScbaCorrection above ----
class ScbaCorrectionReq(_Strict):
    node_id: int
    note: Optional[str] = None
class BannerAckResp(_Strict):
    kind: BannerKind
    acknowledged_ts: int
