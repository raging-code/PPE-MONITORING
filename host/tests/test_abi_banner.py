"""P24-5f (ADR 0051): the abi_mismatch banner. A heartbeat through the real Ingest sets FwState, and Wire carries the flag to the system message and the snapshot banners.
Same rig as test_wire_2b1 (real DBWriter, database, HostPort, fake hub; every body is validated against the WsMessage models). Requirements: REQ-ING-003, REQ-API-007."""
from ppe_host import abi as host_abi
from ppe_host.api import models as M
from ppe_host.io.serial_reader import Heartbeat
from test_wire import got
from test_wire_2b1 import wired

GOOD, BAD = host_abi.BEACON_ABI_VER, host_abi.BEACON_ABI_VER + 1

def beat(ing, clock, fw=None, abi=None):
    clock.advance(1000); ing.heartbeat(Heartbeat(1, 1000, 85, 1, 0, 0, 0, 1, fw, abi))
def flag(wire): return wire.snapshot()['banners']['abi_mismatch']

def test_a_matching_or_missing_abi_sends_no_system_message_and_the_snapshot_flag_is_false(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    beat(ing, clock); wire.tick(); beat(ing, clock, '1.3.0', GOOD); wire.tick()
    assert got(h, 'system') == [] and flag(wire) is False; w.stop()

def test_a_reported_abi_that_differs_is_one_system_message_and_the_snapshot_flag_is_true(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    beat(ing, clock, '1.3.0', BAD); wire.tick(); (m,) = got(h, 'system')
    assert m['abi_mismatch'] is True and m['banner'] is None and flag(wire) is True
    beat(ing, clock, '1.3.0', BAD); wire.tick(); assert len(got(h, 'system')) == 1                                   # a steady mismatch is not repeated
    w.stop()

def test_the_banner_clears_with_one_system_message_when_the_abi_agrees_again(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    beat(ing, clock, '1.3.0', BAD); wire.tick(); beat(ing, clock, '1.3.0', GOOD); wire.tick()
    assert [m['abi_mismatch'] for m in got(h, 'system')] == [True, False] and flag(wire) is False; w.stop()

def test_a_heartbeat_without_abi_does_not_clear_a_mismatch(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    beat(ing, clock, '1.3.0', BAD); beat(ing, clock); wire.tick(); assert flag(wire) is True and len(got(h, 'system')) == 1; w.stop()

def test_a_new_session_reports_the_mismatch_again_and_the_banner_stays_on(tmp_path):
    from test_db_schema import session
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    beat(ing, clock, '1.3.0', BAD); wire.tick(); assert flag(wire) is True
    c.execute("UPDATE sessions SET ended_ts = 2, end_kind = 'ENDED' WHERE session_id = 1"); session(c, 2); ing.session_id = 2
    beat(ing, clock, '1.3.0', BAD); wire.tick(); assert flag(wire) is True; w.stop()                                # reported again in the new session

def test_an_explicit_source_replaces_the_fw_state(tmp_path):
    on = [False]; c, w, clock, ing, p, h, wire = wired(tmp_path, abi_mismatch=lambda: on[0])
    wire.tick(); assert got(h, 'system') == []
    on[0] = True; wire.tick(); (m,) = got(h, 'system'); assert m['abi_mismatch'] is True and flag(wire) is True; w.stop()

def test_the_snapshot_with_the_flag_is_a_valid_snapshot_message(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); beat(ing, clock, '1.3.0', BAD)
    s = wire.snapshot(); M.parse_server(dict(s, v=1, type='snapshot', srv_seq=0, srv_ts=1, epoch='5d1f7c3a-2b64-4e0f-9a51-3c7e8d2b6a10')); w.stop()
