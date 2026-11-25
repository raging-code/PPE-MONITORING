"""P18a: message contract of api/models.py (design 3.8 and 3.13). The snapshot, auth, hb and tick examples are copied from design 3.8.
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
