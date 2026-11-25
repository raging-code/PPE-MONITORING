// patches/part18a_api_models.mjs  (run from repo root: node patches/part18a_api_models.mjs [--dry] [--force])
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
  put('host/ppe_host/api/models.py', String.raw`"""api/models.py (P18a): every WebSocket message and the REST error envelope as Pydantic v2 models (design 3.8 and 3.13).
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
`);
  put('host/tests/test_api_models.py', String.raw`"""P18a: message contract of api/models.py (design 3.8 and 3.13). The snapshot, auth, hb and tick examples are copied from design 3.8.
The schema export, openapi.json and the generated TypeScript are P18b."""
import copy, json, re
from pathlib import Path
import pytest
from pydantic import ValidationError
from ppe_host.api import models as M
ROOT = Path(__file__).resolve().parents[2]
CONSTANTS = json.loads((ROOT / 'shared' / 'constants.json').read_text(encoding='utf8'))
ENV = {'v': 1, 'srv_seq': 7, 'srv_ts': 1795481200000}
ALERT = {'alert_id': 5, 'node_id': 1, 'alert_type': 'co_threshold', 'level': 'WARNING', 'reasons': 'co_ppm >= 35', 'authenticated': 1, 'episode_id': None,
         'raised_ts': 1795481199000, 'cleared_ts': None, 'acknowledged_ts': None, 'acknowledged_by': None, 'unauth_count': None, 'last_seen_ts': None}
EPISODE = {'episode_id': 2, 'node_id': 1, 'kind': 'MAN_DOWN', 'state': 'OPEN', 'man_down_motion_state': 'no_response', 'resolve_reason': None, 'operator': None}
NODE = {'node_id': 1, 'alias': 'FF-01', 'last_rx_ts': 1795481199200, 'co_ppm': 12.0, 'temp_c': 31.2, 'hum_pct': 44, 'motion_g': 0.08, 'bat_pct': 86, 'scba': 1, 'mandown': 0,
        'level': 'NORMAL', 'link_state': 'ok', 'status2': 0, 'flags': 0, 'id_mode': 73, 'status3': 0, 'status4': 0, 'co_validity': 'VALID', 'co_reason': None, 'scba_correction': None}
SYSTEM = {'base': 'ok', 'recovering': False, 'session_id': 4, 'session_mode': 'LIVE', 'rejected_frames': 0, 'logging_fault': False, 'host_gap': None, 'host_power': 'ac',
          'audio_fault': False, 'banner': None, 'acknowledged_ts': None}
BODY = {
    'snapshot': {'epoch': '8f14e45f-ea9b-4d12-9a21-0c8b9e12a001', 'recovering': False, 'monitoring_active': True, 'session': {'session_id': 4, 'started_ts': 1795470000000, 'mode': 'LIVE', 'session_label': 'shift-1'},
                 'roster': [{'node_id': 1, 'alias': 'FF-01', 'active': 1}], 'nodes': [NODE], 'open_alerts': [ALERT], 'open_episodes': [EPISODE], 'co_history_30m': {'1': [[1795481198000, 12.0]]},
                 'banners': {'base_offline': False, 'logging_fault': False, 'host_gap': {'gap_s': 42.5, 'reason': 'db_restored'}, 'host_power': 'ac', 'audio_fault': False}, 'constants': CONSTANTS},
    'reading': {'node_id': 1, 'alias': 'FF-01', 'rx_ts': 1795481199200, 'co_ppm': 12.0, 'co_over_range': 0, 'co_validity': 'VALID', 'co_reason': None, 'temp_c': 31.2, 'hum_pct': 44, 'motion_g': 0.08,
                'posture': 'UPRIGHT', 'stillness_s': 0.0, 'bat_pct': 86, 'scba': 1, 'mandown': 0, 'level': 'NORMAL', 'reasons': [], 'seq_class': 'fresh', 'rssi': -71.5, 'snr': 8.0,
                'status2': 0, 'flags': 0, 'id_mode': 73, 'status3': 0, 'status4': 0},
    'alert': ALERT, 'episode': EPISODE, 'link': {'node_id': 1, 'state': 'link_lost', 'since_ts': 1795481100000, 'last_state': 'ok'}, 'system': SYSTEM,
    'advisory': {'node_id': 1, 'risk': 'NOMINAL', 'reasons': 'no adverse reading', 'action': 'Continue monitoring', 'quality': 'high', 'source': 'table'},
    'ml': {'node_id': 1, 'forecast_5min_ppm': None, 'early_warning': False, 'anomaly_unusual': False, 'cohb_low': None, 'cohb_high': None}, 'tick': {}}
def msg(kind): d = {**ENV, 'type': kind, **copy.deepcopy(BODY[kind])}; d['srv_seq'] = 0 if kind == 'snapshot' else d['srv_seq']; return d
SERVER_KINDS = ['snapshot', 'reading', 'alert', 'episode', 'link', 'system', 'advisory', 'ml', 'tick']
DESIGN_AUTH = '{"v":1,"type":"auth","token":"<bearer>"}'
DESIGN_HB = '{"v":1,"type":"hb","srv_ts":1795481200000}'
DESIGN_TICK = '{"v":1,"type":"tick","srv_seq":42,"srv_ts":1795481200000}'
DESIGN_SNAPSHOT = ('{"v":1,"type":"snapshot","epoch":"8f14e45f-ea9b-4d12-9a21-0c8b9e12a001","srv_seq":0,"srv_ts":1795481200000,"recovering":false,"monitoring_active":true,'
    '"session":{"session_id":4,"started_ts":1795470000000,"mode":"LIVE","session_label":"shift-1"},"roster":[{"node_id":1,"alias":"FF-01","active":1}],'
    '"nodes":[{"node_id":1,"alias":"FF-01","last_rx_ts":1795481199200,"co_ppm":12.0,"temp_c":31.2,"hum_pct":44,"motion_g":0.08,"bat_pct":86,"scba":1,"mandown":0,"level":"NORMAL",'
    '"link_state":"ok","status2":0,"flags":0,"id_mode":73,"status3":0,"status4":0,"co_validity":"VALID","co_reason":null,"scba_correction":null}],"open_alerts":[],"open_episodes":[],'
    '"co_history_30m":{"1":[[1795481198000,12.0]]},"banners":{"base_offline":false,"logging_fault":false,"host_gap":null,"host_power":"ac","audio_fault":false},'
    '"constants":{"co_warn_ppm":35.0,"co_danger_ppm":200.0,"co_clamp_max_ppm":500.0}}')

def test_design_3_8_examples_parse():
    assert M.parse_client(DESIGN_AUTH).token == '<bearer>' and M.parse_client(DESIGN_HB).srv_ts == 1795481200000
    assert M.parse_server(DESIGN_TICK).srv_seq == 42
    s = M.parse_server(DESIGN_SNAPSHOT); assert s.srv_seq == 0 and s.nodes[0].co_validity == 'VALID' and s.banners.host_power == 'ac' and s.constants['co_warn_ppm'] == 35.0
@pytest.mark.parametrize('kind', SERVER_KINDS)
def test_every_server_message_parses_and_round_trips(kind):
    m = M.parse_server(msg(kind)); assert m.type == kind and json.loads(m.model_dump_json()) == json.loads(json.dumps(msg(kind)))
@pytest.mark.parametrize('kind', SERVER_KINDS)
def test_server_messages_need_v_type_srv_seq_srv_ts(kind):
    for key in ('v', 'type', 'srv_seq', 'srv_ts'):
        d = msg(kind); del d[key]
        with pytest.raises(ValidationError): M.parse_server(d)
@pytest.mark.parametrize('kind', SERVER_KINDS)
def test_unknown_v_is_rejected(kind):
    for bad in (0, 2, '1', None):
        d = msg(kind); d['v'] = bad
        with pytest.raises(ValidationError): M.parse_server(d)
def test_unknown_v_is_rejected_on_client_messages():
    for raw in (DESIGN_AUTH, DESIGN_HB):
        with pytest.raises(ValidationError): M.parse_client(raw.replace('"v":1', '"v":2'))
def test_unknown_or_wrong_direction_type_is_rejected():
    for d in ({**msg('tick'), 'type': 'bogus'}, {**msg('tick'), 'type': 'auth'}, {'v': 1, 'srv_seq': 1, 'srv_ts': 1}):
        with pytest.raises(ValidationError): M.parse_server(d)
    for raw in ('{"v":1,"type":"tick","srv_seq":1,"srv_ts":1}', '{"v":1,"type":"snapshot"}', '{"v":1,"type":"auth"}', '{"v":1,"type":"auth","token":""}'):
        with pytest.raises(ValidationError): M.parse_client(raw)
@pytest.mark.parametrize('kind', SERVER_KINDS)
def test_extra_fields_are_rejected_so_no_key_or_token_can_ride_along(kind):
    for extra in ('token', 'cmac_key', 'anything'):
        d = msg(kind); d[extra] = 'x'
        with pytest.raises(ValidationError): M.parse_server(d)
def test_snapshot_counter_starts_at_zero_and_epoch_is_a_uuid():
    for bad in ({'srv_seq': 1}, {'epoch': 'not-a-uuid'}):
        with pytest.raises(ValidationError): M.parse_server({**msg('snapshot'), **bad})
def test_snapshot_carries_the_whole_constants_file_unchanged():
    assert M.parse_server(msg('snapshot')).model_dump(mode='json')['constants'] == CONSTANTS
def test_snapshot_node_open_episode_and_banner_fields():
    s = M.parse_server(msg('snapshot')); n = s.nodes[0]
    assert (n.co_validity, n.co_reason, n.scba_correction) == ('VALID', None, None) and s.open_episodes[0].man_down_motion_state == 'no_response'
    assert s.co_history_30m['1'][0] == [1795481198000, 12.0] and s.banners.host_gap.reason == 'db_restored' and s.roster[0].active == 1
    d = msg('snapshot'); d['nodes'][0]['scba_correction'] = {'recorded_ts': 5, 'operator': 'Ana'}; assert M.parse_server(d).nodes[0].scba_correction.operator == 'Ana'
    d = msg('snapshot'); d['nodes'] = [{**NODE, 'last_rx_ts': None, 'co_ppm': None, 'level': None, 'status2': None, 'link_state': 'not_connected'}]; assert M.parse_server(d).nodes[0].level is None
def test_no_key_or_token_field_in_any_server_message_or_in_constants():
    bad = re.compile(r'token|key|secret|salt|password', re.I)
    names = set(re.findall(r'"([A-Za-z0-9_]+)": \{', json.dumps(M.SERVER_ADAPTER.json_schema())))
    assert not [n for n in names if bad.search(n)]
    assert not [k for k in CONSTANTS if bad.search(k)]
    assert 'token' in M.AuthMsg.model_fields and all('token' not in c.model_fields for c in M.SERVER_TYPES)
def test_levels_and_enums():
    for lvl in ('NONE', 'normal'):
        with pytest.raises(ValidationError): M.parse_server({**msg('reading'), 'level': lvl})
    assert M.parse_server({**msg('alert'), 'level': 'NONE'}).level == 'NONE'
    with pytest.raises(ValidationError): M.parse_server({**msg('alert'), 'level': 'NORMAL'})
    with pytest.raises(ValidationError): M.parse_server({**msg('episode'), 'man_down_motion_state': 'moving'})
    assert M.parse_server({**msg('episode'), 'kind': 'MAYDAY', 'man_down_motion_state': None}).man_down_motion_state is None
    with pytest.raises(ValidationError): M.parse_server({**msg('alert'), 'alert_type': 'made_up'})
    with pytest.raises(ValidationError): M.parse_server({**msg('system'), 'banner': 'base_offline'})
def test_alert_types_match_catalog_and_database_seed():
    cat = [a['type'] for a in json.loads((ROOT / 'shared' / 'alert_catalog.json').read_text(encoding='utf8')) if a['owner'] == 'alerts']  # the other 7 rows are system banners
    sql = (ROOT / 'host' / 'migrations' / '0001.sql').read_text(encoding='utf8')
    seed = re.findall(r"'(\w+)'", re.search(r'INSERT INTO alert_types\(type\) VALUES (.*?);', sql).group(1))
    assert set(M.ALERT_TYPES) == set(cat) == set(seed) and len(M.ALERT_TYPES) == len(set(M.ALERT_TYPES)) == 25
def test_posture_names_match_the_abi():
    abi = json.loads((ROOT / 'shared' / 'abi.json').read_text(encoding='utf8'))
    assert set(abi['enums']['posture']) == set(M.Posture.__args__)
def test_error_envelope():
    assert M.ERROR_CODES == ('BAD_REQUEST', 'UNAUTHENTICATED', 'ORIGIN_REJECTED', 'NOT_FOUND', 'RECOVERING', 'STATE_CONFLICT', 'VALIDATION_ERROR', 'INTERNAL_ERROR')
    for code in M.ERROR_CODES: assert M.ErrorEnvelope(error_code=code, detail='x', retry_after_s=None).retry_after_s is None
    assert M.ErrorEnvelope(error_code='RECOVERING', detail='x', retry_after_s=30.0).retry_after_s == 30.0
    assert M.ErrorEnvelope(error_code='UNAUTHENTICATED', detail='x', retry_after_s=2.5).retry_after_s == 2.5
    for kw in ({'error_code': 'NOT_FOUND', 'retry_after_s': 1.0}, {'error_code': 'TEAPOT', 'retry_after_s': None}, {'error_code': 'NOT_FOUND'}):
        with pytest.raises(ValidationError): M.ErrorEnvelope(detail='x', **kw)
`);
  putB64('docs/adr/0005.md', 'IyBBRFIgMDAwNTogV2ViU29ja2V0IG1lc3NhZ2UgZmllbGRzIHRoYXQgZGVzaWduIDMuOCBsZWF2ZXMgb3BlbiAoUDE4YSkKClN0YXR1czogUHJvcG9zZWQgKGRlY2lkZWQgaW4gdGhlIFAxOGEgc2Vzc2lvbjsgY29uZmlybSBhdCB0aGUgbmV4dCBkZXNpZ24gcmV2aWV3KS4KRGVzaWduOiBSZXYgMy40NSBpcyBmcm96ZW4uIFRhYmxlIDMuOCBuYW1lcyB0aGUgbWFpbiBmaWVsZHMgb2YgZWFjaCBtZXNzYWdlIGJ1dCBub3QgZXZlcnkgdHlwZSwgdmFsdWUgc3BlbGxpbmcgb3IgbnVsbGFiaWxpdHkuIFRoZXNlIHJlYWRpbmdzIGFyZSB3aGF0IGBob3N0L3BwZV9ob3N0L2FwaS9tb2RlbHMucHlgIGVuY29kZXM7IHRoZSB0ZXN0cyBwaW4gdGhlbS4gTm90aGluZyBpbiB0aGUgZnJhbWUsIHRoZSBtaWdyYXRpb24gb3IgYGNvbnN0YW50cy5qc29uYCBjaGFuZ2VzLgoKLSAqKmB0eXBlYCBjb2xsaXNpb24gKG5lZWRzIHlvdXIgY29uZmlybWF0aW9uKToqKiBldmVyeSBtZXNzYWdlIGNhcnJpZXMgYHR5cGVgLCBhbmQgYW4gYGFsZXJ0YCBtZXNzYWdlIGFsc28gbGlzdHMgYW4gYWxlcnQgYHR5cGVgLiBCb3RoIGNhbiBub3QgYmUgb25lIEpTT04ga2V5LiBUaGUgYWxlcnQncyBvd24gdHlwZSBpcyBzZW50IGFzIGBhbGVydF90eXBlYCwgaW4gdGhlIGBhbGVydGAgbWVzc2FnZSBhbmQgaW4gYHNuYXBzaG90Lm9wZW5fYWxlcnRzW11gLiBJZiB5b3UgcHJlZmVyIGFub3RoZXIgbmFtZSwgY2hhbmdlIGBBbGVydEJvZHlgIGFuZCB0aGUgZGFzaGJvYXJkIHJlYWRzIGl0LgotICoqTm8gZGVmYXVsdHM6KiogYHZgIGFuZCBgdHlwZWAgYXJlIHJlcXVpcmVkIG9uIGV2ZXJ5IG1lc3NhZ2UgaW4gYm90aCBkaXJlY3Rpb25zLCBzbyBhIGNsaWVudCBtZXNzYWdlIHdpdGhvdXQgYHZgIGlzIHJlamVjdGVkLCBub3QgZGVmYXVsdGVkLiBUaGUgc25hcHNob3QncyBgc3J2X3NlcWAgaXMgdGhlIGxpdGVyYWwgMC4KLSAqKjAgb3IgMSB2ZXJzdXMgdHJ1ZSBvciBmYWxzZToqKiBmbGFncyB0aGF0IGNvbWUgZnJvbSBkYXRhYmFzZSBpbnRlZ2VyIGNvbHVtbnMgKGBzY2JhYCwgYG1hbmRvd25gLCBgY29fb3Zlcl9yYW5nZWAsIGBhdXRoZW50aWNhdGVkYCwgcm9zdGVyIGBhY3RpdmVgKSBhcmUgMCBvciAxLCBhcyBpbiB0aGUgMy44IHNuYXBzaG90IGV4YW1wbGUuIEJhbm5lciBmbGFncyBhbmQgYHJlY292ZXJpbmdgLCBgbW9uaXRvcmluZ19hY3RpdmVgIGFyZSBib29sZWFucywgYWxzbyBhcyBpbiB0aGUgZXhhbXBsZS4KLSAqKk5ldmVyLWhlYXJkIG5vZGU6KiogdGhlIHNuYXBzaG90IGxpc3RzIGV2ZXJ5IHJvc3RlciBub2RlOyBiZWZvcmUgaXRzIGZpcnN0IHZlcmlmaWVkIGZyYW1lIHRoZSBtZWFzdXJlbWVudCBmaWVsZHMsIGBsZXZlbGAgYW5kIHRoZSBzdGF0dXMgYnl0ZXMgYXJlIG51bGwgYW5kIGBsaW5rX3N0YXRlYCBpcyBgbm90X2Nvbm5lY3RlZGAuCi0gKipgbGlua19zdGF0ZWAgdmFsdWVzOioqIGBub3RfY29ubmVjdGVkYCwgYG9rYCwgYHdlYWtfc2lnbmFsYCwgYHNpZ25hbF9sb3N0YCwgYGxpbmtfbG9zdGAsIGByZWNvdmVyZWRgICgzLjggbGlzdHMgdGhlIHdvcmRzIHdpdGggc3BhY2VzIGFuZCB0aGUgZXhhbXBsZSB1c2VzIGBva2A7IHNuYWtlX2Nhc2UgZm9sbG93cyBgbm9fcmVzcG9uc2VgIGFuZCBgbW92ZW1lbnRfZGV0ZWN0ZWRgKS4KLSAqKk9wZXJhdG9yczoqKiBgYWNrbm93bGVkZ2VkX2J5YCBvbiBhbiBhbGVydCBpcyB0aGUgb3BlcmF0b3IgaWQ7IGBvcGVyYXRvcmAgb24gYW4gZXBpc29kZSBhbmQgb24gYHNjYmFfY29ycmVjdGlvbmAgaXMgdGhlIGRpc3BsYXkgbmFtZS4KLSAqKk90aGVyIHR5cGVzOioqIGFsZXJ0IGByZWFzb25zYCBpcyBvbmUgc3RyaW5nICh0aGUgZGF0YWJhc2UgY29sdW1uKSwgcmVhZGluZyBgcmVhc29uc2AgaXMgYSBsaXN0OyBgcmVqZWN0ZWRfZnJhbWVzYCBpcyBvbmUgY291bnQ7IGBob3N0X3Bvd2VyYCBpcyBhIGZyZWUgc3RyaW5nICgzLjggZ2l2ZXMgb25seSBgYWNgKTsgb24gYSBgc3lzdGVtYCBtZXNzYWdlIGBiYW5uZXJgIGFuZCBgYWNrbm93bGVkZ2VkX3RzYCBhcmUgbnVsbCBleGNlcHQgb24gYSBiYW5uZXIgYWNrbm93bGVkZ2VtZW50LiBUaGUgVGllciAyIGBtbGAgbWVzc2FnZSBpcyBkZWZpbmVkIHdpdGggZ3Vlc3NlZCB0eXBlcyAoYGVhcmx5X3dhcm5pbmdgIGFuZCBgYW5vbWFseV91bnVzdWFsYCBib29sZWFucykgYW5kIGlzIG5ldmVyIHNlbnQgaW4gVGllciAxLgotICoqUkVTVCBlcnJvciBlbnZlbG9wZToqKiBgcmV0cnlfYWZ0ZXJfc2AgbWF5IGJlIHNldCBvbmx5IGZvciBgUkVDT1ZFUklOR2AgYW5kIGZvciB0aGUgYFVOQVVUSEVOVElDQVRFRGAgYW5zd2VyIHRvIGEgbG9naW4gKHRoZSBiYWNrb2ZmKTsgZXZlcnkgb3RoZXIgY29kZSBtdXN0IHNlbmQgbnVsbC4K');
  append('docs/PROGRESS.md', '- Part 18a done: host/ppe_host/api/models.py (Pydantic v2: server messages snapshot, reading, alert, episode, link, system, advisory, ml and tick and client messages auth and hb as discriminated unions on type, all fields required and extra fields forbidden, v must be 1, alert type sent as alert_type, REST ErrorEnvelope with the 8 codes and retry_after_s only for RECOVERING and UNAUTHENTICATED), host/tests/test_api_models.py (contract tests with the 3.8 examples), docs/adr/0005.md; schema export, openapi.json and the generated TypeScript are P18b');
}
