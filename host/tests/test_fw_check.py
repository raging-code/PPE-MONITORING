"""P24-5e (ADR 0050): the firmware tag and ABI in the base heartbeat. Parser, FwState edges, and the rows through the real writer and the 0002 migration. Requirements: REQ-ING-003."""
import json
from ppe_host import abi as host_abi
from ppe_host.io.serial_reader import Heartbeat, parse_line
from ppe_host.services.fw_check import FwState
from test_ingest import rig, rows

HB = {'v': 1, 'type': 'hb', 'base_id': 1, 'uptime_ms': 13000, 'bat_pct': 85, 'rx_ok': 412, 'rx_bad_len': 0, 'rx_bad_crc': 1, 'rx_bad_mac': 0, 'beacon_tx': 105}
def line(**kw): return json.dumps({**HB, **kw})
GOOD = host_abi.BEACON_ABI_VER

def test_old_heartbeat_without_the_fields_still_parses_and_equals_the_short_form():
    k, hb = parse_line(line()); assert k == 'hb' and hb == Heartbeat(1, 13000, 85, 412, 0, 1, 0, 105) and hb.fw is None and hb.abi is None

def test_fw_and_abi_are_read_when_present():
    k, hb = parse_line(line(fw='1.3.0', abi=3)); assert k == 'hb' and (hb.fw, hb.abi) == ('1.3.0', 3)

def test_malformed_optional_fields_read_as_absent_and_never_drop_the_heartbeat():
    for bad in ({'fw': 5}, {'fw': ''}, {'fw': 'a b'}, {'fw': 'x' * 33}, {'abi': -1}, {'abi': '3'}, {'abi': True}, {'abi': 3.0}):
        k, hb = parse_line(line(**bad)); assert k == 'hb' and (hb.fw is None or 'fw' not in bad) and (hb.abi is None or 'abi' not in bad), bad

def test_required_fields_are_still_required():
    d = dict(HB); del d['bat_pct']; assert parse_line(json.dumps(d)) == ('bad', 'bad_hb')

def test_nothing_reported_writes_nothing():
    s = FwState(); assert s.update(None, None) == [] and not s.mismatch

def test_first_fw_is_reported_once_and_a_change_is_reported_again():
    s = FwState(); assert s.update('1.3.0', None) == [('FW_REPORTED', '1.3.0')] and s.update('1.3.0', None) == [] and s.update('1.4.0', None) == [('FW_REPORTED', '1.4.0')]

def test_matching_abi_is_silent_the_first_time():
    s = FwState(); assert s.update(None, GOOD) == [] and not s.mismatch

def test_abi_mismatch_fires_once_then_recovery_fires_once():
    s = FwState(); r = s.update('1.3.0', GOOD + 1)
    assert [k for k, _ in r] == ['FW_REPORTED', 'ABI_MISMATCH'] and str(GOOD + 1) in r[1][1] and str(GOOD) in r[1][1] and s.mismatch
    assert s.update('1.3.0', GOOD + 1) == [] and s.update('1.3.0', None) == [] and s.mismatch
    assert [k for k, _ in s.update('1.3.0', GOOD)] == ['ABI_OK'] and not s.mismatch and s.update('1.3.0', GOOD) == []

def test_rows_reach_the_database_and_sessions_fw_version_is_recorded(tmp_path):
    c, w, clock, ing = rig(tmp_path)
    for fw, abi in ((None, None), ('1.3.0', GOOD + 1), ('1.3.0', GOOD + 1), ('1.3.0', GOOD)):
        clock.advance(1000); ing.heartbeat(Heartbeat(1, 1000, 85, 1, 0, 0, 0, 1, fw, abi))
    w.stop(); got = rows(c, 'SELECT kind, detail FROM system_events ORDER BY event_seq')
    assert [r['kind'] for r in got] == ['FW_REPORTED', 'ABI_MISMATCH', 'ABI_OK'] and got[0]['detail'] == '1.3.0'
    assert c.execute('SELECT fw_version FROM sessions WHERE session_id = 1').fetchone()[0] == '1.3.0'
    assert len(rows(c, 'SELECT * FROM base_health')) == 4 and not w.logging_fault

def test_a_new_session_reports_again(tmp_path):
    c, w, clock, ing = rig(tmp_path); ing.heartbeat(Heartbeat(1, 1, 85, 1, 0, 0, 0, 1, '1.3.0', GOOD))
    from test_db_schema import session; c.execute("UPDATE sessions SET ended_ts = 2, end_kind = 'ENDED' WHERE session_id = 1"); session(c, 2); ing.session_id = 2; ing.heartbeat(Heartbeat(1, 2, 85, 1, 0, 0, 0, 1, '1.3.0', GOOD))
    w.stop(); assert [(r['session_id'], r['kind']) for r in rows(c, 'SELECT session_id, kind FROM system_events ORDER BY event_seq')] == [(1, 'FW_REPORTED'), (2, 'FW_REPORTED')]
