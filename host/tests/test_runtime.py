"""P24-3c-1: start-up step 8 (runtime.py): the writer and serial threads, the pre-replay queue and its drop rule, and the first host_tick with recovering=1."""
import json, sqlite3, threading
from types import SimpleNamespace as NS
from ppe_host import main as M, runtime as R
from ppe_host.clock import FakeClock
from ppe_host.io.serial_reader import Frame
from ppe_host.io.serial_writer import host_tick_line
from fakeport import FakePort, frame_line, hb_line
from test_startup import home, run, NOW

def frame(flags=0, status4=0, n=23):
    b = bytearray(n); 
    if n == 23: b[11], b[16] = flags, status4
    return Frame(bytes(b), 'OK', None, None, 1, 1)

class Sink:
    def __init__(self): self.got, self.health = [], None
    def on_item(self, kind, p): self.got.append((kind, p))
    def frame(self, f): self.got.append(('frame', f))

def test_protected_frames_are_the_ones_with_a_level_or_an_event_bit():
    assert not R.protected(frame().raw) and not R.protected(frame(n=10).raw)
    for flags in (0x01, 0x02, 0x04, 0x08, 0x80): assert R.protected(frame(flags).raw)      # WARNING, DANGER, mandown, fault, check-in
    assert R.protected(frame(0, 0x10).raw) and not R.protected(frame(0x10).raw)             # mayday yes; co_sat alone is not an event

def test_a_full_queue_drops_only_normal_frames_and_keeps_the_mandown_frame():          # design 8, pre-replay queue test
    g = R.PreReplayGate(Sink(), 5); mandown = frame(0x06)
    for i in range(20): g._add(mandown if i == 7 else frame())
    assert g.depth() == 5 and g.dropped == 15 and mandown in list(g._q) and g.overflow == 0

def test_when_nothing_is_droppable_the_queue_grows_and_overflow_is_counted():
    g = R.PreReplayGate(Sink(), 2)
    for _ in range(4): g._add(frame(0x02))
    assert g.depth() == 4 and g.dropped == 0 and g.overflow == 2

def test_release_feeds_arrival_order_then_goes_live_and_heartbeats_skip_the_queue():
    s = Sink(); g = R.PreReplayGate(s, 10); a, b, c = frame(1), frame(2), frame(4)
    g.on_item('frame', a); g.on_item('hb', 'H'); g.on_item('frame', b); assert s.got == [('hb', 'H')]
    assert g.release() == 2 and [p for k, p in s.got[1:]] == [a, b]
    g.on_item('frame', c); assert s.got[-1] == ('frame', c) and g.depth() == 0              # live: straight to on_item

def test_a_frame_arriving_during_release_queues_behind_it():
    s = Sink(); g = R.PreReplayGate(s, 10); first, late = frame(1), frame(2); sent = []
    def slow(f):
        if not sent: sent.append(1); g.on_item('frame', late)                              # a live frame arrives while the first one is being processed
        s.got.append(('frame', f))
    s.frame = slow; g.on_item('frame', first)
    assert g.release() == 2 and [p for _, p in s.got] == [first, late] and g.live and g.depth() == 0

def started(tmp_path, mode='LIVE', port=None):
    h = home(tmp_path); st = run(h, mode); M.begin_session(st)
    rt = R.Runtime(st, FakeClock(NOW, 0), open_port=(lambda: port) if port else (lambda: FakePort([])))
    return st, rt

def rows(db, sql):
    c = sqlite3.connect(db); out = c.execute(sql).fetchall(); c.close(); return out

def test_runtime_wires_ingest_from_the_session_and_the_next_event_seq(tmp_path):
    st, rt = started(tmp_path)
    assert rt.ingest.session_id == st.session_id and rt.ingest.st.event_seq == st.event_seq - 1 and rt.ingest.health is rt.health
    assert sorted(rt.ingest.roster) == [1, 2, 3] and rt.gate.max == 500 and not rt.gate.live
    rt.writer.conn.close(); st.close()

def test_start_logs_a_heartbeat_row_and_stop_drains_the_writer(tmp_path):
    port = FakePort([hb_line()]); st, rt = started(tmp_path, port=port); rt.start()
    assert port.drained.wait(3); rt.stop()
    assert len(rows(st.db_path, 'SELECT * FROM base_health')) == 1; st.close()

def test_frames_wait_in_the_queue_until_release(tmp_path):
    port = FakePort([frame_line('00' * 23), frame_line('00' * 23)]); st, rt = started(tmp_path, port=port); rt.start()   # 23 zero bytes: the host rejects them (BAD_MAC) once they run
    assert port.drained.wait(3); assert rt.gate.depth() == 2 and not rows(st.db_path, 'SELECT * FROM frames')
    assert rt.release() == 2 and rt.gate.depth() == 0; rt.stop()
    assert [r[0] for r in rows(st.db_path, 'SELECT verify FROM frames')] == ['BAD_MAC', 'BAD_MAC']; st.close()

def test_the_first_host_tick_says_recovering_and_comes_out_on_the_port(tmp_path):
    class Port(FakePort):
        def __init__(self): super().__init__([]); self.out, self.wrote = [], threading.Event()
        def write(self, b): self.out.append(b); self.wrote.set()
    port = Port(); st, rt = started(tmp_path, port=port); rt.start()
    assert port.wrote.wait(3); rt.stop(); st.close()
    assert port.out[0] == host_tick_line(NOW, True, 'LIVE') and json.loads(port.out[0])['recovering'] == 1

def test_serial_loss_is_logged_once_and_counted(tmp_path):
    def bad(): raise OSError('no port')
    h = home(tmp_path); st = run(h); M.begin_session(st); rt = R.Runtime(st, FakeClock(NOW, 0), open_port=bad); rt.start()
    for _ in range(300):
        if rt.reader.lost: break
        threading.Event().wait(0.01)
    rt.stop(); k = [r[0] for r in rows(st.db_path, "SELECT kind FROM system_events WHERE kind LIKE 'SERIAL%'")]; st.close()
    assert k == ['SERIAL_LOST']

def test_simulator_mode_has_no_serial_threads(tmp_path):
    st, rt = started(tmp_path, 'SIMULATOR'); rt.start(); assert not rt.reader.alive() and rt.writer._thread.is_alive(); rt.stop(); st.close()

def test_counters_report_the_queue_drops(tmp_path):
    st, rt = started(tmp_path); rt.gate.dropped = 3
    assert rt.health.counters.snapshot()['pre_replay_dropped'] == 3 and 'pre_replay_overflow' in rt.health.counters.snapshot()
    rt.writer.conn.close(); st.close()
