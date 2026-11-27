"""P12-2: ingest pipeline (design 1 per-frame order, 2.1 overflow rule, 2.3 frames table, Section 5 host share). Real writer and database, fake port, FakeClock."""
import logging, statistics, time
from ppe_host.clock import FakeClock
from ppe_host.io.db_writer import DBWriter
from ppe_host.io.ingest import Ingest, BAD_FRAMES_KEPT_PER_MIN
from ppe_host.io.serial_reader import Frame, SerialReader
from ppe_host.settings import Settings
from ppe_host.core.rule_engine import RaiseAlert
from test_db_schema import new_db, session
from test_gv_bytes import pack, KEY, WRONG_KEY, SYS, VEC
from fakeport import FakePort, frame_line

HOSTS = {f['id']: f for f in VEC['frames']}
T = 1_700_000_000_000

def rig(tmp_path, **kw):
    c = new_db(tmp_path); session(c); clock = FakeClock(T, 10_000)
    w = DBWriter(tmp_path / 't.db', clock, retry_sleep_s=0.005).start()
    ing = Ingest(KEY, SYS, (1, 2, 3), w, clock, 1, **kw)
    return c, w, clock, ing
def fr(raw, base='OK'): return Frame(raw, base, -68.5, 9.2, 1, 1000)
def send(ing, clock, raw, base='OK', dt=1000): clock.advance(dt); return ing.frame(fr(raw, base))
def rows(c, sql='SELECT * FROM frames ORDER BY event_seq'):
    c.row_factory = __import__('sqlite3').Row; return [dict(r) for r in c.execute(sql)]
def done(w, c, **kw): w.stop(); return rows(c, **kw) if kw else rows(c)

def test_every_vector_gives_the_stored_verify_the_design_lists_and_rejections_are_counted(tmp_path):
    c, w, clock, ing = rig(tmp_path); exp = []
    for f in VEC['frames']:
        res = f['expect']['result']; r = send(ing, clock, bytes.fromhex(f['hex']), base='OK' if res in ('OK', 'REJECT_ROSTER') else res)
        assert r.verify == res, f['id']
        if res != 'REJECT_ROSTER': exp.append(res)
    got = done(w, c)
    assert [r['verify'] for r in got] == exp and len(got) == 23 and all(r['verify'] == 'OK' or r['seq_class'] == 'suspect' for r in got)     # F-20 (node 0) is never stored
    assert ing.counters['rejected_frames'] == 7 and ing.counters['rejected_BAD_LEN'] == 2 and ing.counters['rejected_BAD_CRC'] == 1 and ing.counters['rejected_BAD_MAC'] == 3 and ing.counters['rejected_REJECT_ROSTER'] == 1
    assert ing.counters['mac_disagree'] == 0
    by = {r['raw_hex']: r for r in got}; f01 = by[HOSTS['F-01']['hex']]
    assert (f01['node_id'], f01['node_level'], f01['backend_level'], f01['final_level'], f01['co_x10'], f01['verify'], f01['seq_class']) == (1, 'WARNING', 'WARNING', 'WARNING', 520, 'OK', 'fresh')
    f16 = by[HOSTS['F-16']['hex']]; assert (f16['node_id'], f16['final_level'], f16['node_level'], f16['backend_level'], f16['base_verify']) == (2, None, None, None, 'BAD_MAC')      # GV-04 row
    assert by[HOSTS['F-24']['hex']]['temp_x100'] == -500 and by[HOSTS['F-21']['hex']]['node_id'] is None and by[HOSTS['F-21']['hex']]['seq'] is None
    assert [r['event_seq'] for r in got] == sorted(r['event_seq'] for r in got) and len({r['event_seq'] for r in got}) == 23

def test_a_host_and_base_disagreement_logs_mac_disagree_and_keeps_both_results(tmp_path):
    c, w, clock, ing = rig(tmp_path)
    send(ing, clock, bytes.fromhex(HOSTS['F-18']['hex']), base='OK')           # host: BAD_MAC, base said OK
    send(ing, clock, bytes.fromhex(HOSTS['F-01']['hex']), base='BAD_CRC')      # host: OK, base said BAD_CRC
    send(ing, clock, bytes.fromhex(HOSTS['F-20']['hex']), base='BAD_MAC')      # host: node 0 (counted as OK by the base's rules), base said BAD_MAC
    w.stop(); ev = rows(c, 'SELECT * FROM system_events ORDER BY event_seq'); fr_ = rows(c)
    assert [e['kind'] for e in ev] == ['MAC_DISAGREE'] * 3 and ev[0]['detail'] == 'node=1 host=BAD_MAC base=OK' and ing.counters['mac_disagree'] == 3
    assert [(r['verify'], r['base_verify']) for r in fr_] == [('BAD_MAC', 'OK'), ('OK', 'BAD_CRC')]
    assert len({r['event_seq'] for r in fr_} | {e['event_seq'] for e in ev}) == 5

def test_a_bad_frame_flood_keeps_20_per_minute_and_verified_frames_are_still_stored(tmp_path):
    c, w, clock, ing = rig(tmp_path); _bad = pack(seq=5, flags=6, node=2, key=WRONG_KEY)
    bad_crc = bytearray(pack(seq=6)); bad_crc[2] ^= 1; bad_crc = bytes(bad_crc)
    for i in range(30): send(ing, clock, bad_crc, 'BAD_CRC', dt=100)
    for s in range(1, 4): send(ing, clock, pack(seq=s), dt=100)
    assert ing.counters['rejected_frames'] == 30 and ing.counters['bad_frames_not_stored'] == 10 and BAD_FRAMES_KEPT_PER_MIN == 20
    clock.advance(61_000); send(ing, clock, bad_crc, 'BAD_CRC')
    got = done(w, c); assert [r['verify'] for r in got].count('BAD_CRC') == 21 and [r['verify'] for r in got].count('OK') == 3

def test_a_humidity_byte_outside_0_to_100_is_stored_raw_and_not_rejected_or_suspect(tmp_path):
    c, w, clock, ing = rig(tmp_path)
    for s, h in ((1, 255), (2, 101), (3, 0)): r = send(ing, clock, pack(seq=s, hum=h)); assert r.verify == 'OK' and r.seq_class == 'fresh'
    got = done(w, c); assert [r['hum'] for r in got] == [255, 101, 0] and ing.counters['rejected_frames'] == 0 and {r['seq_class'] for r in got} == {'fresh'}

def test_flags_level_3_and_a_reserved_status4_bit_are_stored_suspect_and_logged_without_moving_the_baseline(tmp_path):
    c, w, clock, ing = rig(tmp_path); msgs = []
    class H(logging.Handler):
        def emit(self, rec): msgs.append(rec.getMessage())
    h = H(); lg = logging.getLogger('ppe.ingest'); lg.addHandler(h); lg.setLevel(logging.INFO)
    try:
        send(ing, clock, pack(seq=10)); r3 = send(ing, clock, pack(seq=11, flags=3)); rr = send(ing, clock, pack(seq=12, status4=0x04)); ok = send(ing, clock, pack(seq=11))
    finally: lg.removeHandler(h)
    assert (r3.seq_class, rr.seq_class, ok.seq_class) == ('suspect', 'suspect', 'fresh') and len(msgs) == 2 and ing.counters['suspect_logged'] == 2     # seq 11 after the level-3 frame is still fresh: the baseline stayed at 10
    got = done(w, c); assert (got[1]['node_level'], got[1]['final_level'], got[1]['backend_level']) == (None, None, None) and got[1]['flags'] == 3 and got[2]['status4'] == 4 and got[3]['frames_lost'] == 0

def test_roster_is_checked_and_a_non_roster_node_is_counted_and_never_stored(tmp_path):
    c, w, clock, ing = rig(tmp_path)
    assert send(ing, clock, pack(seq=1, node=5)).verify == 'REJECT_ROSTER' and send(ing, clock, pack(seq=1, node=2)).verify == 'OK'
    got = done(w, c); assert [r['node_id'] for r in got] == [2] and ing.counters['rejected_REJECT_ROSTER'] == 1

def test_backend_ms_is_stored_per_frame_and_event_seq_continues_from_the_start_value(tmp_path):
    t = iter(x * 0.0025 for x in range(1000)); c, w, clock, ing = rig(tmp_path, event_seq_start=50, perf=lambda: next(t) * 2)
    send(ing, clock, pack(seq=1)); ev = ing.system_event('SERIAL_LOST', 'open'); send(ing, clock, pack(seq=2)); got = done(w, c)
    assert abs(got[0]['backend_ms'] - 5.0) < 1e-6 and got[0]['event_seq'] == 51 and ev.event_seq == 52 and got[1]['event_seq'] == 53
    assert rows(c, 'SELECT kind, detail FROM system_events') == [{'kind': 'SERIAL_LOST', 'detail': 'open'}]

def test_broadcast_follows_the_commit_and_covers_verified_frames_and_frames_that_raise_but_not_plain_diagnostics(tmp_path):
    seen = []; c, w, clock, ing = rig(tmp_path)
    ing.broadcast = lambda r: seen.append((r.verify, r.committed, r.stored, bool(c.execute('SELECT 1 FROM frames WHERE event_seq=?', (r.event_seq,)).fetchone())))
    send(ing, clock, pack(seq=1)); send(ing, clock, bytes.fromhex(HOSTS['F-17']['hex']), 'BAD_CRC')
    r = send(ing, clock, pack(seq=3, flags=6, node=2, key=WRONG_KEY), 'BAD_MAC')            # GV-04: a BAD_MAC frame claiming man-down raises unauth_alert
    assert seen == [('OK', True, True, True), ('BAD_MAC', True, True, True)] and [e.type for e in r.effects if isinstance(e, RaiseAlert)] == ['unauth_alert']
    assert all(e.event_seq > r.event_seq for e in r.effects); w.stop()

def test_from_settings_reads_the_key_and_sys_id_never_from_the_repo(tmp_path):
    c, w, clock, _ = rig(tmp_path); s = Settings({'sys_id': SYS, 'commit_wait_ms': 77}, tmp_path, {'cmac_key': KEY.hex()})
    ing = Ingest.from_settings(s, (1, 2, 3), w, clock, 1); assert ing.commit_wait_ms == 77 and send(ing, clock, pack(seq=1)).verify == 'OK'; w.stop()

def test_host_share_serial_line_to_broadcast_stays_inside_the_200_ms_budget_median_and_maximum(tmp_path):
    BUDGET_MS = 200                                                                       # design Section 5 (host share), in the test only
    c, w, clock, ing = rig(tmp_path); out, ts = [], []
    ing.broadcast = lambda r: out.append(time.perf_counter())
    port = FakePort([]); rd = SerialReader(lambda: port, ing.on_item, retry_s=0.005).start()
    for s in range(1, 101):
        n = len(out); clock.advance(1000); t0 = time.perf_counter(); port.script.append(frame_line(pack(seq=s).hex()))
        end = time.time() + 5
        while len(out) == n and time.time() < end: time.sleep(0.0005)
        assert len(out) == n + 1, 'frame %d was not broadcast' % s; ts.append((out[-1] - t0) * 1000)
    rd.stop(); w.stop()
    assert statistics.median(ts) <= BUDGET_MS and max(ts) <= BUDGET_MS, (statistics.median(ts), max(ts))
    assert c.execute('SELECT COUNT(*) FROM frames').fetchone()[0] == 100
