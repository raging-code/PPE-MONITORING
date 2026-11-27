"""P12b: real clock, host_tick writer thread, SERIAL_LOST/BACK sharing, base_health rows, BASE_OFFLINE/BACK, COUNTERS."""
import json, threading, time
from ppe_host.clock import RealClock, now_of
from ppe_host.io.health import Counters, Health
from ppe_host.io.serial_reader import SerialReader, Heartbeat, Frame
from ppe_host.io.serial_writer import LinkMonitor, SerialWriter, host_tick_line
from test_ingest import rig, send, rows
from test_gv_bytes import pack

def until(cond, t=3.0):
    end = time.time() + t
    while time.time() < end:
        if cond(): return True
        time.sleep(0.003)
    return cond()
class WPort:
    """Records writes and the thread that wrote them. gate (an Event) makes a write block; fail makes it raise."""
    def __init__(self): self.writes, self.threads, self.gate, self.fail = [], [], None, False
    def write(self, b):
        self.threads.append(threading.current_thread().name)
        if self.gate is not None: self.gate.wait(2)
        if self.fail: raise TimeoutError('write timeout')
        self.writes.append(b)
def lines(p): return [json.loads(w) for w in p.writes]

def test_the_real_clock_gives_integer_wall_and_monotonic_milliseconds():
    c = RealClock(); a, b = c.mono_ms(), c.mono_ms(); w = c.wall_ms(); n = now_of(c)
    assert isinstance(a, int) and isinstance(w, int) and b >= a and abs(w - time.time() * 1000) < 2000 and n.wall_ms >= w and n.mono_ms >= b

def test_host_tick_line_is_the_frozen_json_and_rejects_bad_input():
    assert host_tick_line(1795481200000, 0, 'LIVE') == b'{"v":1,"type":"host_tick","srv_ts":1795481200000,"recovering":0,"session_mode":"LIVE"}\n'
    assert json.loads(host_tick_line(5, True, 'REPLAY'))['recovering'] == 1
    for bad in ((1, 0, 'TEST'), (-1, 0, 'LIVE'), (True, 0, 'LIVE'), (1.5, 0, 'LIVE')):
        try: host_tick_line(*bad); assert False, bad
        except ValueError: pass

def test_ticks_carry_recovering_and_are_written_off_the_event_loop_by_the_writer_thread():
    p = WPort(); w = SerialWriter(lambda: p, LinkMonitor(lambda k, d: None)).start()
    for i, rec in enumerate((1, 1, 0)): w.offer(host_tick_line(1000 + i, rec, 'LIVE')); assert until(lambda: len(p.writes) == i + 1)
    assert [(d['srv_ts'], d['recovering'], d['session_mode']) for d in lines(p)] == [(1000, 1, 'LIVE'), (1001, 1, 'LIVE'), (1002, 0, 'LIVE')]
    assert set(p.threads) == {'SerialWriterThread'} and threading.current_thread().name not in p.threads; w.stop()

def test_offer_never_blocks_a_stuck_write_and_a_newer_tick_replaces_an_unsent_one():
    p = WPort(); p.gate = threading.Event(); w = SerialWriter(lambda: p, LinkMonitor(lambda k, d: None)).start()
    w.offer(host_tick_line(1, 0, 'LIVE')); assert until(lambda: p.threads)                    # tick 1 is inside a blocked write
    t0 = time.perf_counter(); w.offer(host_tick_line(2, 0, 'LIVE')); w.offer(host_tick_line(3, 0, 'LIVE')); assert (time.perf_counter() - t0) < 0.05
    p.gate.set(); assert until(lambda: len(p.writes) == 2)
    assert [d['srv_ts'] for d in lines(p)] == [1, 3] and w.counters['ticks_replaced'] == 1; w.stop()

def test_a_blocked_port_times_out_logs_serial_lost_once_drops_the_tick_and_serial_back_follows_the_first_good_write():
    p, ev = WPort(), []; w = SerialWriter(lambda: p, LinkMonitor(lambda k, d: ev.append((k, d)))).start(); p.fail = True
    for i in range(3): w.offer(host_tick_line(i, 0, 'LIVE')); assert until(lambda: w.counters['ticks_dropped'] >= i + 1)
    assert ev == [('SERIAL_LOST', 'write')] and len(p.threads) == 3 and p.writes == []             # each tick tried once, never retried
    p.fail = False; w.offer(host_tick_line(9, 0, 'LIVE')); assert until(lambda: len(p.writes) == 1)
    assert ev == [('SERIAL_LOST', 'write'), ('SERIAL_BACK', None)] and w.last_error; w.stop()

def test_one_outage_logs_one_row_whichever_side_noticed_first_and_a_missing_port_adds_nothing():
    ev = []; m = LinkMonitor(lambda k, d: ev.append((k, d))); m.on_link('SERIAL_LOST', 'read'); m.writer_lost(); m.writer_lost(); m.writer_ok(); m.on_link('SERIAL_BACK', None); m.writer_ok()
    assert ev == [('SERIAL_LOST', 'read'), ('SERIAL_BACK', None)]
    w = SerialWriter(lambda: None, m).start(); w.offer(b'x\n'); assert until(lambda: w.counters['ticks_dropped'] == 1) and len(ev) == 2; w.stop()

def test_serial_lost_and_back_reach_system_events_through_the_ingest_writer(tmp_path):
    c, w, clock, ing = rig(tmp_path); m = LinkMonitor(ing.system_event); m.on_link('SERIAL_LOST', 'open'); m.writer_lost(); m.on_link('SERIAL_BACK', None); w.stop()
    assert [(r['kind'], r['detail']) for r in rows(c, 'SELECT * FROM system_events ORDER BY event_seq')] == [('SERIAL_LOST', 'open'), ('SERIAL_BACK', None)]

def hb(up=13000, bat=85): return Heartbeat(1, up, bat, 412, 0, 1, 2, 105)

def test_each_heartbeat_becomes_one_base_health_row(tmp_path):
    c, w, clock, ing = rig(tmp_path)
    ing.on_item('hb', hb(13000, 85)); clock.advance(1000); ing.on_item('hb', hb(14000, 84)); send(ing, clock, pack(seq=1)); w.stop()
    got = rows(c, 'SELECT * FROM base_health ORDER BY id')
    assert [(r['ts'], r['uptime_ms'], r['bat_pct'], r['rx_ok'], r['rx_bad_len'], r['rx_bad_crc'], r['rx_bad_mac']) for r in got] == [(1_700_000_000_000, 13000, 85, 412, 0, 1, 2), (1_700_000_001_000, 14000, 84, 412, 0, 1, 2)]
    assert c.execute('PRAGMA foreign_key_check').fetchall() == []

def test_base_offline_is_raised_at_5_s_without_a_heartbeat_or_frame_and_base_back_follows_a_sign_of_life(tmp_path):
    c, w, clock, ing = rig(tmp_path); h = ing.health = Health(clock, ing.system_event, Counters({}))
    clock.advance(4999); h.tick(); assert not h.offline
    clock.advance(1); h.tick(); h.tick(); assert h.offline                                       # exactly 5 s after the last sign of life, one row however often tick() runs
    clock.advance(3000); ing.on_item('hb', hb()); assert not h.offline
    clock.advance(5000); h.tick(); assert h.offline; clock.advance(100); ing.on_item('frame', Frame(pack(seq=1), 'OK', -60.0, 9.0, 1, 1)); assert not h.offline      # a frame line is a sign of life too
    w.stop(); assert [r['kind'] for r in rows(c, 'SELECT * FROM system_events ORDER BY event_seq')] == ['BASE_OFFLINE', 'BASE_BACK', 'BASE_OFFLINE', 'BASE_BACK']

def test_counters_rows_match_the_live_counters_every_interval_and_add_restored_totals(tmp_path):
    c, w, clock, ing = rig(tmp_path); reader = SerialReader(lambda: None, ing.on_item); reader.counters['serial_framing_errors'] = 3
    ing.health = h = Health(clock, ing.system_event, Counters.for_host(ing, w, reader, restored={'rejected_frames': 10}), interval_s=60)
    bad = bytearray(pack(seq=1)); bad[2] ^= 1
    for _ in range(4): send(ing, clock, bytes(bad), 'BAD_CRC', dt=1000)
    send(ing, clock, b'\x00' * 22, 'BAD_LEN', dt=1000); h.tick(); ing.on_item('hb', hb()); assert not c.execute("SELECT 1 FROM system_events WHERE kind='COUNTERS'").fetchone()
    clock.advance(60_000); ing.on_item('hb', hb()); h.tick(); h.tick(); w.stop()
    got = [json.loads(r['detail']) for r in rows(c, "SELECT * FROM system_events WHERE kind='COUNTERS'")]
    assert len(got) == 1 and got[0]['rejected_frames'] == 10 + ing.counters['rejected_frames'] == 15 and got[0]['serial_framing_errors'] == 3 and got[0]['write_rejected'] == 0
    assert set(got[0]) >= {'rejected_frames', 'write_rejected', 'pre_replay_dropped', 'retry_buffer_dropped', 'serial_framing_errors', 'queue_overflow'}

def test_a_base_that_never_speaks_is_offline_5_s_after_start(tmp_path):
    c, w, clock, ing = rig(tmp_path); h = Health(clock, ing.system_event, Counters({})); clock.advance(5000); h.tick(); assert h.offline; w.stop()
