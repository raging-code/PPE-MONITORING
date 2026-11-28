"""S7-2 (ADR 0058): the serial drain of SIMULATOR and REPLAY (design 3.10 and 1, Operating mode isolation). The port is read only to detect live hardware: a valid MAC-verified frame writes
LIVE_FRAME_IN_TEST_MODE, nothing else is ingested, nothing is written to the port. Requirements: REQ-ING-001."""
import json, threading, time
from pathlib import Path
import pytest
from ppe_host import main as M, runtime as R
from ppe_host.clock import FakeClock
from ppe_host.io.serial_reader import Frame, Heartbeat, SerialReader
from ppe_host.services import serial_drain as D, simulator as S
from fakeport import FakePort, frame_line, hb_line
from test_simulator import rows, wait_polls
from test_startup import NOW, home, run

ROOT = Path(__file__).resolve().parents[2]
KEY, SYS, T0 = bytes(range(16)), 7, 1_000_000

def good(node=1, seq=5, key=KEY, sys_id=SYS): return S.encode_frame(key, sys_id, node, seq)
def fr(raw, base_id=1): return Frame(raw, 'OK', -70.0, 8.0, base_id, 1000)
def hb(): return Heartbeat(1, 1000, 80, 1, 0, 0, 0, 1)

def detector(every_s=60):
    clock, out = FakeClock(NOW, T0), []
    return D.LiveTrafficDetector(clock, lambda k, d, droppable: out.append((k, json.loads(d), droppable)), KEY, SYS, every_s), clock, out

# ---- the detector ----
def test_the_first_valid_frame_writes_one_row_that_is_not_droppable_and_names_the_node():
    d, clock, out = detector(); d.on_item('frame', fr(good(node=2, seq=41), base_id=3))
    assert out == [('LIVE_FRAME_IN_TEST_MODE', {'base_id': 3, 'node_id': 2, 'seq': 41, 'valid_frames': 1}, False)]
    assert d.counters == {'drain_frames': 1, 'drain_valid': 1, 'drain_heartbeats': 0, 'drain_events': 1}

def test_a_busy_base_gives_one_row_a_minute_and_the_next_row_counts_the_frames_in_between():
    d, clock, out = detector()
    for i in range(3): d.on_item('frame', fr(good(seq=i))); clock.advance(10_000)        # 0 s, 10 s, 20 s: one row
    assert len(out) == 1
    clock.advance(30_000); d.on_item('frame', fr(good(seq=9)))                          # 50 s later than the first at 60 s: due
    assert len(out) == 2 and out[1][1]['valid_frames'] == 3 and out[1][1]['seq'] == 9
    clock.advance(59_999); d.on_item('frame', fr(good())); assert len(out) == 2         # 1 ms early
    clock.advance(1); d.on_item('frame', fr(good())); assert len(out) == 3 and out[2][1]['valid_frames'] == 2

def test_frames_that_the_host_does_not_verify_are_counted_and_never_raise_the_event():
    d, clock, out = detector(); raw = good(); bad_crc = bytearray(raw); bad_crc[3] ^= 1; bad_mac = bytearray(raw); bad_mac[-1] ^= 1
    for r in (bytes(bad_crc), bytes(bad_mac), raw[:-1], raw + b'\x00', b'', good(key=bytes(range(1, 17))), good(sys_id=SYS + 1)): d.on_item('frame', fr(r))
    assert out == [] and d.counters['drain_frames'] == 7 and d.counters['drain_valid'] == 0

def test_the_base_saying_OK_is_not_enough_the_host_checks_the_mac_itself():
    d, clock, out = detector(); raw = bytearray(good()); raw[-1] ^= 0xFF
    d.on_item('frame', Frame(bytes(raw), 'OK', None, None, 1, 5)); assert out == []

def test_heartbeats_and_unknown_items_are_ignored():
    d, clock, out = detector(); d.on_item('hb', hb()); d.on_item('hb', hb()); d.on_item('other', None)
    assert out == [] and d.counters['drain_heartbeats'] == 2 and d.counters['drain_frames'] == 0

def test_a_monotonic_clock_that_goes_back_does_not_silence_the_event_forever():
    d, clock, out = detector(); d.on_item('frame', fr(good()))
    clock._mono = 0; d.on_item('frame', fr(good())); assert len(out) == 2

def test_a_node_id_of_zero_or_unknown_is_still_live_hardware_of_this_system():
    d, clock, out = detector(); d.on_item('frame', fr(good(node=7))); assert out[0][1]['node_id'] == 7

def test_a_failing_emit_reaches_the_reader_as_a_handler_error_and_never_stops_it():
    clock = FakeClock(NOW, T0)
    def boom(*a): raise RuntimeError('writer gone')
    det = D.LiveTrafficDetector(clock, boom, KEY, SYS)
    port = FakePort([frame_line(good().hex()), frame_line(good().hex())]); r = SerialReader(lambda: port, det.on_item, retry_s=0.01).start()
    assert port.drained.wait(5); r.stop(); assert r.counters['serial_handler_errors'] >= 1 and r.counters['serial_lines_ok'] == 2

# ---- the runtime ----
def drain_runtime(tmp_path, port, mode='SIMULATOR', simulator=None, writes=None):
    h = home(tmp_path); st = run(h, mode); M.begin_session(st); clock = FakeClock(NOW, 0)
    rt = R.Runtime(st, clock, open_port=lambda: port, simulator=simulator, drain=True)
    if simulator: rt.sim.poll_s = 0.002
    return st, rt, clock

class WritablePort(FakePort):
    def __init__(self, script): super().__init__(script); self.written = []
    def write(self, b): self.written.append(b); return len(b)

def live_line(st, node=1, seq=1, **kw):
    return frame_line(S.encode_frame(st.settings.cmac_key(), st.settings['sys_id'], node, seq).hex(), **kw)

@pytest.mark.parametrize('mode', ['SIMULATOR', 'REPLAY'])
def test_a_live_frame_in_test_mode_writes_one_system_event_and_nothing_else(tmp_path, mode):
    h = home(tmp_path); st0 = run(h, mode); st0.close()
    st = run(h, mode); M.begin_session(st); port = WritablePort([hb_line(), live_line(st, 1, 1), live_line(st, 2, 1), live_line(st, 1, 2)])
    rt = R.Runtime(st, FakeClock(NOW, 0), open_port=lambda: port, drain=True).start()
    try: assert port.drained.wait(5); assert rt.gate.depth() == 0
    finally: rt.stop(); st.close()
    ev = rows(st.db_path, "SELECT kind, detail FROM system_events WHERE kind = 'LIVE_FRAME_IN_TEST_MODE'")
    assert len(ev) == 1 and json.loads(ev[0][1])['node_id'] == 1                          # three valid frames, one row a minute
    assert rows(st.db_path, 'SELECT COUNT(*) FROM frames')[0][0] == 0 and rows(st.db_path, 'SELECT COUNT(*) FROM base_health')[0][0] == 0 and rows(st.db_path, 'SELECT COUNT(*) FROM alerts')[0][0] == 0
    assert port.written == [] and rt.detector.counters['drain_valid'] == 3 and rt.detector.counters['drain_heartbeats'] == 1

def test_the_drain_never_reaches_ingest_even_for_frames_the_host_would_accept_after_release(tmp_path):
    h = home(tmp_path); st = run(h, 'SIMULATOR'); M.begin_session(st); port = FakePort([live_line(st, 1, n) for n in range(1, 6)])
    rt = R.Runtime(st, FakeClock(NOW, 0), open_port=lambda: port, drain=True).start()
    try: assert port.drained.wait(5); rt.release(); assert rt.ingest.health.offline is False
    finally: rt.stop(); st.close()
    assert rows(st.db_path, 'SELECT COUNT(*) FROM frames')[0][0] == 0 and rt.gate.depth() == 0

def test_simulated_frames_still_flow_and_a_live_frame_is_reported_beside_them(tmp_path):
    h = home(tmp_path); st = run(h, 'SIMULATOR'); M.begin_session(st); port = FakePort([live_line(st, 3, 65000)])
    rt = R.Runtime(st, FakeClock(NOW, 0), open_port=lambda: port, simulator=('quiet', 1), drain=True); rt.sim.poll_s = 0.002; rt.start()
    try:
        assert port.drained.wait(5); wait_polls(rt.sim); rt.release()
        for _ in range(6): rt.clock.advance(500); wait_polls(rt.sim)
    finally: rt.stop(); st.close()
    assert rows(st.db_path, "SELECT COUNT(*) FROM system_events WHERE kind = 'LIVE_FRAME_IN_TEST_MODE'")[0][0] == 1
    n = rows(st.db_path, 'SELECT COUNT(*) FROM frames')[0][0]; assert n >= 3 and rows(st.db_path, "SELECT COUNT(*) FROM frames WHERE seq = 65000")[0][0] == 0   # only simulated frames are stored

def test_a_missing_port_is_logged_once_writes_no_system_event_and_the_host_runs_on(tmp_path):
    h = home(tmp_path); st = run(h, 'SIMULATOR'); M.begin_session(st); calls = []
    def no_port(): calls.append(1); raise OSError('COM4 not found')
    rt = R.Runtime(st, FakeClock(NOW, 0), open_port=no_port, drain=True); rt.drain.retry_s = 0.01; rt.start()
    try:
        end = time.monotonic() + 5
        while len(calls) < 3 and time.monotonic() < end: time.sleep(0.005)
        assert len(calls) >= 3 and rt.drain.alive() and rt.drain.lost
    finally: rt.stop(); st.close()
    assert rows(st.db_path, "SELECT COUNT(*) FROM system_events WHERE kind IN ('SERIAL_LOST', 'SERIAL_BACK', 'LIVE_FRAME_IN_TEST_MODE')")[0][0] == 0

def test_a_pulled_cable_and_a_return_write_no_serial_events_in_test_mode(tmp_path):
    h = home(tmp_path); st = run(h, 'SIMULATOR'); M.begin_session(st); ports = [FakePort([OSError('unplugged')]), FakePort([live_line(st)])]
    rt = R.Runtime(st, FakeClock(NOW, 0), open_port=lambda: ports.pop(0) if ports else FakePort([]), drain=True); rt.drain.retry_s = 0.01; rt.start()
    try:
        end = time.monotonic() + 5
        while not rt.detector.counters['drain_events'] and time.monotonic() < end: time.sleep(0.005)
    finally: rt.stop(); st.close()
    kinds = {k for (k,) in rows(st.db_path, 'SELECT kind FROM system_events')}
    assert 'LIVE_FRAME_IN_TEST_MODE' in kinds and not kinds & {'SERIAL_LOST', 'SERIAL_BACK'}

def test_the_drain_thread_has_its_own_name_stamps_its_own_liveness_and_leaves_no_thread_behind(tmp_path):
    st, rt, clock = drain_runtime(tmp_path, FakePort([])); rt.start()
    try:
        names = {t.name for t in threading.enumerate()}; assert 'SerialDrainThread' in names and 'SerialReaderThread' not in names and 'SerialWriterThread' not in names
        end = time.monotonic() + 5
        while 'drain' not in rt.liveness.ages() and time.monotonic() < end: time.sleep(0.005)
        assert 'drain' in rt.liveness.ages() and 'serial' not in rt.liveness.ages()
    finally: rt.stop(); st.close()
    assert not [t for t in threading.enumerate() if t.name == 'SerialDrainThread']

def test_live_mode_refuses_a_drain_before_anything_is_built(tmp_path):
    h = home(tmp_path); st = run(h, 'LIVE'); M.begin_session(st)
    try:
        with pytest.raises(ValueError, match='drain'): R.Runtime(st, FakeClock(NOW, 0), drain=True)
        assert not [t for t in threading.enumerate() if t.name == 'SerialDrainThread']
    finally: st.close()

@pytest.mark.parametrize('mode', ['SIMULATOR', 'REPLAY'])
def test_without_the_drain_argument_no_port_is_opened(tmp_path, mode):
    h = home(tmp_path); st = run(h, mode); M.begin_session(st)
    rt = R.Runtime(st, FakeClock(NOW, 0), open_port=lambda: pytest.fail('no port may be opened')); assert rt.drain is None and rt.detector is None; rt.start(); rt.stop(); st.close()

def test_the_drain_stops_before_the_writer_so_no_row_is_queued_after_the_last_one(tmp_path):
    h = home(tmp_path); st = run(h, 'SIMULATOR'); M.begin_session(st); port = FakePort([live_line(st)])
    rt = R.Runtime(st, FakeClock(NOW, 0), open_port=lambda: port, drain=True).start(); assert port.drained.wait(5); rt.stop(clean=True); st.close()
    assert rows(st.db_path, "SELECT COUNT(*) FROM system_events WHERE kind = 'LIVE_FRAME_IN_TEST_MODE'")[0][0] == 1 and rows(st.db_path, "SELECT COUNT(*) FROM sessions WHERE end_kind = 'CLEAN_SHUTDOWN'")[0][0] == 1
    assert port.closed

# ---- main ----
def run_main(tmp_path, argv, capsys):
    box = {}
    async def serve(rt, host, port): box['rt'] = rt; box['drain'] = rt.drain is not None
    h = home(tmp_path); code = M.main(['--home', str(h)] + argv, serve=serve); capsys.readouterr(); return code, box

@pytest.mark.parametrize('mode,expect', [('SIMULATOR', True), ('REPLAY', True), ('LIVE', False)])
def test_main_starts_the_drain_in_simulator_and_replay_and_never_in_live(tmp_path, capsys, mode, expect):
    code, box = run_main(tmp_path, ['--mode', mode], capsys)
    assert code == 0 and box['drain'] is expect
    if expect: assert not box['rt'].drain.alive() and box['rt'].serial is False

def test_the_test_suite_cannot_open_a_real_port_through_the_runtime():
    with pytest.raises(OSError, match='no real serial port'): R.open_serial('COM4')

# ---- docs ----
def test_adr_0058_exists_is_proposed_and_progress_points_to_it():
    adr = (ROOT / 'docs' / 'adr' / '0058.md').read_text(encoding='utf8'); assert adr.startswith('# ADR 0058') and 'Status: Proposed' in adr
    assert 'LIVE_FRAME_IN_TEST_MODE' in adr and 'SerialDrainThread' in adr and 'Decisions to confirm' in adr
    assert 'Part S7-2 done (ADR 0058' in (ROOT / 'docs' / 'PROGRESS.md').read_text(encoding='utf8')
