"""P25-4 (ADR 0037): the release checks of P25. (1) Replay timing: a 24 h database of 3 nodes (routine_period_s = 2 s: 129,600 frames, plus the stored bad frames at the 20 per minute cap and a COUNTERS row
per minute) is rebuilt and RECOVERING_EXIT is logged in 3 s or less of real time (design 2.9 and s05: Proposed, provisional), with no gap between two 'loop' liveness stamps near task_stall_s.
A second run with a window of 5 times the routine rate gates only the loop stall (a stall is os._exit(1)) and a 9 s ceiling; its time is printed (about 0.35 ms per replayed frame, so the 3 s gate holds up to about 8,000 frames in the window). (2) One restart chain end to end: a crash with an open alert and an open episode, a restart after a gap (open items there before the replay ends, HOST_GAP, no SIGNAL LOST from the gap alone,
no second episode on the first live frame), a clean stop, and the next start in a new session. The pieces are tested one by one in test_recovery.py, test_recovery_run.py and test_sessions.py; this is the whole path in one test."""
import json, sqlite3, time
from ppe_host.clock import FakeClock
from test_recovery_run import P, kinds, process_a, process_b, recover, finish, rows, send, tick
from test_startup import home

SLOW_S = 3.0           # the gate: RECOVERING_EXIT within 3 s of the start of recovery
STALL_S = 3.0          # task_stall_s: a longer gap between two loop stamps is os._exit(1)
DAY_MS = 24 * 3600 * 1000

COLS = ('event_seq, session_id, node_id, rx_ts, rx_mono, seq, boot_ctr, uptime_s, co_x10, co_over_range, temp_x100, hum, hr, motion_x100, bat, status2, flags, id_mode, status3, status4, '
        'node_level, backend_level, final_level, reasons, rssi, snr, verify, base_verify, seq_class, frames_lost, raw_hex, backend_ms')


def build_day(db_path, start_ts, start_seq, window_period_ms, per_node_period_ms=2000, bad_per_min=20):
    c = sqlite3.connect(str(db_path)); c.execute('PRAGMA synchronous=OFF')
    t0, t1 = start_ts + 1000, start_ts + DAY_MS; win0 = t1 - 30 * 60 * 1000; mono0 = 1000        # process A's clock: mono_base 1000 at wall NOW
    es, rows_, sample = start_seq, [], {}
    ts = t0; seq = {1: 0, 2: 0, 3: 0}; cnt = 0
    while ts < t1:
        step = window_period_ms if ts >= win0 else per_node_period_ms
        for n in (1, 2, 3):
            seq[n] = (seq[n] + 1) % 65536
            if ts >= win0 or n not in sample:
                raw = P(seq=seq[n], node=n, co_x10=20, uptime_s=seq[n] % 60000).hex(); sample[n] = raw
            else: raw = sample[n]
            es += 1; cnt += 1
            rows_.append((es, 1, n, ts + n, mono0 + (ts + n - start_ts), seq[n], 7, seq[n] % 60000, 20, 0, 2500, 50, 0, 0, 80, 0, 0, n | 0x40, 0, 0, 'NORMAL', 'NORMAL', 'NORMAL', '', -68.5, 9.2, 'OK', 'OK', 'fresh', 0, raw, 0.4))
        ts += step
    c.executemany('INSERT INTO frames(%s) VALUES (%s)' % (COLS, ','.join('?' * 32)), rows_)
    nbad = 0
    for minute in range(24 * 60):
        mts = t0 + minute * 60_000
        for k in range(bad_per_min):
            es += 1; nbad += 1
            c.execute("INSERT INTO frames(%s) VALUES (%s)" % (COLS, ','.join('?' * 32)), (es, 1, None, mts + k, mono0 + (mts + k - start_ts), None, None, None, None, 0, None, None, None, None, None, None, None, None, None, None, None, None, None, None, -90.0, -3.0, 'BAD_MAC', 'OK', 'fresh', 0, sample[1], 0.1))
        es += 1; c.execute("INSERT INTO system_events(session_id, event_seq, ts, kind, detail) VALUES (1, ?, ?, 'COUNTERS', ?)", (es, mts + 59_000, json.dumps({'rejected_frames': nbad})))
    c.commit(); c.close()
    return t1 + 3, cnt, es

def day_database(tmp_path, window_period_ms):
    h = home(tmp_path); last = process_a(h); db = next((h).rglob('*.db'))
    c = sqlite3.connect(str(db)); es = max(c.execute('SELECT MAX(event_seq) FROM frames').fetchone()[0] or 0, c.execute('SELECT MAX(event_seq) FROM system_events').fetchone()[0] or 0); c.close()
    end_ts, frames, _ = build_day(db, last, es + 1, window_period_ms)
    return h, end_ts, frames

class Timed:
    """Real elapsed time to RECOVERING_EXIT, and the longest gap between two 'loop' stamps."""
    def __init__(self, rt):
        self.t0 = self.exit = self.last = None; self.max_gap = 0.0
        orig = rt.ingest.system_event; me = self
        def system_event(kind, *a, **k):
            if kind == 'RECOVERING_EXIT': me.exit = time.perf_counter()
            return orig(kind, *a, **k)
        rt.ingest.system_event = system_event
        lv = rt.liveness; stamp = lv.stamp
        def st(name, *a, **k):
            if name == 'loop':
                now = time.perf_counter(); me.max_gap = max(me.max_gap, now - (me.last or me.t0 or now)); me.last = now
            return stamp(name, *a, **k)
        lv.stamp = st
    def start(self): self.t0 = self.last = time.perf_counter()
    def seconds(self): return self.exit - self.t0

def timed_recovery(tmp_path, window_period_ms):
    h, end_ts, frames = day_database(tmp_path, window_period_ms)
    clock = FakeClock(end_ts + 60_000, 500); from test_recovery_run import M, R, FakePort, run, HostPort, Hub, Wire, CUR
    st = run(h, 'SIMULATOR'); st.host_gap_reason = None; M.begin_session(st, clock)
    rt = R.Runtime(st, clock, open_port=lambda: FakePort([])).start(); rt.load_open(); CUR.append(rt)
    port = HostPort.from_startup(st, rt.ingest); rt.port = port; rt.wire = Wire(port, Hub()).attach()
    tm = Timed(rt); tm.start(); rep = recover(rt)
    return st, rt, rep, tm, frames

def test_a_24_hour_database_is_replayed_in_3_seconds_or_less_and_the_loop_never_stalls(tmp_path):
    st, rt, rep, tm, frames = timed_recovery(tmp_path, 2000)
    assert frames > 129_000
    assert rows(st, 'SELECT COUNT(*) FROM frames')[0][0] > 150_000                                    # the database is a full day, not the fixture of the other tests
    assert 2600 <= rep.rebuild.frames <= 2800 and rep.rebuild.skipped == 0 and rep.done and rep.error is None and rep.integrity == 'ok'
    print('\nTIMING routine: exit %.3f s, longest loop gap %.3f s' % (tm.seconds(), tm.max_gap))
    assert tm.seconds() <= SLOW_S, 'RECOVERING_EXIT took %.2f s' % tm.seconds()
    assert tm.max_gap < STALL_S / 2, 'the event loop was blocked for %.2f s' % tm.max_gap
    assert rep.rejected_restored >= 20 * 60 * 24 - 20 * 60                                            # bad frames at the cap are counted back from the COUNTERS row, not lost
    finish(rt, st)

def test_a_window_with_five_times_the_routine_frame_rate_still_never_stalls_the_loop(tmp_path):      # the 3 s gate is for the routine rate; here only survival is gated
    st, rt, rep, tm, frames = timed_recovery(tmp_path, 400)
    assert 13_000 <= rep.rebuild.frames <= 13_500 and rep.done and rep.error is None
    print('\nTIMING dense (5x): exit %.3f s, longest loop gap %.3f s' % (tm.seconds(), tm.max_gap))
    assert tm.seconds() <= 3 * SLOW_S, 'RECOVERING_EXIT took %.2f s' % tm.seconds()       # reported, not the gate: replay cost is about 0.35 ms per frame, so the window size decides
    assert tm.max_gap < STALL_S / 2, 'the event loop was blocked for %.2f s' % tm.max_gap
    finish(rt, st)

def test_a_restart_chain_crash_recover_clean_stop_and_the_next_start(tmp_path):
    h = home(tmp_path)
    def script(rt, clock):
        for i in range(6, 9): send(rt, clock, 1, seq=i, co_x10=900)                                                  # a CO alert on node 1
        for i in range(6, 9): send(rt, clock, 2, seq=i, flags=0x04 | 0x02)                                           # a man-down episode on node 2
    last = process_a(h, script)                                                                                      # stop() is not clean: the session stays open
    st, rt, hub, clock = process_b(h, last, 5 * 60_000)
    open_before = set(rt.ingest.st.alerts); assert (1, 'co_threshold') in open_before and (2, 'man_down') in open_before and st.recovering     # shown before the replay ends
    assert [e.state for e in rt.ingest.st.episodes.values()] == ['OPEN'] and rt.port.recovering
    sid = rows(st, 'SELECT session_id FROM sessions WHERE ended_ts IS NULL')[0][0]
    rep = recover(rt)
    assert rep.done and rep.gap_ms == 5 * 60_000 and set(rt.ingest.st.alerts) == open_before and not st.recovering
    assert kinds(st).count('SESSION_ABANDONED') == 0 and rows(st, 'SELECT session_id FROM sessions WHERE ended_ts IS NULL')[0][0] == sid     # resumed, not abandoned
    assert not tick(rt, clock, 14) and set(rt.ingest.st.alerts) == open_before                                       # the gap alone raises no SIGNAL LOST or LINK LOST
    send(rt, clock, 2, seq=9, flags=0x04 | 0x02)                                                                     # the latch is still set: a level, not an edge
    assert rows(st, 'SELECT COUNT(*) FROM episodes WHERE node_id = 2')[0][0] == 1
    send(rt, clock, 1, seq=9, co_x10=20); send(rt, clock, 3, seq=9, co_x10=20)
    assert all(rt.wire.link_state(n) in ('ok', 'recovered') for n in (1, 2, 3)) and not rt.wire.unconfirmed       # every node left 'not_connected' on its first fresh frame
    rt.stop(clean=True); st.close()
    assert rows(st, "SELECT COUNT(*) FROM system_events WHERE kind = 'CLEAN_SHUTDOWN'")[0][0] == 1 and rows(st, 'SELECT end_kind FROM sessions WHERE session_id = ?', (sid,))[0][0] == 'CLEAN_SHUTDOWN'
    last2 = rows(st, 'SELECT MAX(ts) FROM system_events')[0][0]
    st3, rt3, hub3, clock3 = process_b(h, last2, 2 * 60_000)
    new = rows(st3, 'SELECT session_id, monitoring_active FROM sessions WHERE ended_ts IS NULL')
    assert new and new[0][0] != sid and new[0][1] == 0                                                               # a new session, monitoring off (ADR 0037)
    assert (1, 'co_threshold') in rt3.ingest.st.alerts and any(e.node_id == 2 for e in rt3.ingest.st.episodes.values())      # open items survive the clean stop too
    finish(rt3, st3)
