"""S7-3 (ADR 0059): REPLAY. The ScaledClock (1x, 4x, 16x, pause), the read-only source, the item stream, the ReplayThread, the optional replay of Runtime (REPLAY mode only) and the --session and --speed
options of main. The mode isolation of design 8: REPLAY never writes to the original database. Requirements: REQ-ING-001."""
import hashlib, sqlite3, threading, time
from pathlib import Path
import pytest
from ppe_host import main as M, runtime as R
from ppe_host.cli import MIGRATIONS_DIR, seed_roster
from ppe_host.clock import FakeClock, ScaledClock
from ppe_host.core.crypto_abi import node_id_of
from ppe_host.io.db_writer import connect_db, run_migrations
from ppe_host.io.serial_reader import Frame, Heartbeat
from ppe_host.services import replay as RP, simulator as S
from test_startup import KEY, NOW, home, run

ROOT = Path(__file__).resolve().parents[2]
T0 = 1_700_000_000_000
SYS = 1

# ---- ScaledClock ----
def test_the_scaled_clock_starts_at_the_base_values_and_runs_speed_times_as_fast():
    for speed in (1, 4, 16):
        b = FakeClock(5000, 700); c = ScaledClock(b, speed); assert (c.wall_ms(), c.mono_ms()) == (5000, 700)
        b.advance(1000); assert (c.wall_ms(), c.mono_ms()) == (5000 + 1000 * speed, 700 + 1000 * speed)

def test_pause_stops_both_clocks_and_resume_goes_on_from_there():
    b = FakeClock(0, 0); c = ScaledClock(b, 4); b.advance(1000); c.pause(); assert c.paused
    b.advance(60_000); assert (c.wall_ms(), c.mono_ms()) == (4000, 4000)
    c.pause(); b.advance(5); assert c.mono_ms() == 4000                          # a second pause changes nothing
    c.resume(); assert not c.paused; b.advance(500); assert (c.wall_ms(), c.mono_ms()) == (6000, 6000)
    c.resume(); b.advance(250); assert c.mono_ms() == 7000

def test_the_scaled_clock_does_not_follow_a_step_of_the_base_wall_clock():
    b = FakeClock(10_000, 0); c = ScaledClock(b, 1); b.set_wall(99_000_000); b.advance(1000); assert c.wall_ms() == 11_000

@pytest.mark.parametrize('bad', [0, -1, True, 'x', None, float('nan')])
def test_a_speed_that_is_not_above_zero_is_refused(bad):
    with pytest.raises(ValueError): ScaledClock(FakeClock(0, 0), bad)

# ---- the source ----
def make_source(h, scenario='man_down', seconds=70, hb=True, extra=None):
    """A session 1 in <home>/data/ppe.db made the way the host stores one: simulated frames at T0 + t, one base_health row a second."""
    db = h / 'data' / 'ppe.db'; db.parent.mkdir(parents=True, exist_ok=True)
    c = connect_db(db); run_migrations(c, str(MIGRATIONS_DIR), NOW); seed_roster(c)
    c.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash) VALUES (1, ?, 'LIVE', 'b', 'c', 's')", (T0,))
    c.execute("UPDATE sessions SET ended_ts = ?, end_kind = 'ENDED' WHERE session_id = 1", (T0 + 90_000,))
    sched = S.Schedule(scenario, 1, bytes.fromhex(KEY), SYS, 1); seq = 0
    for t in range(0, seconds * 1000 + 1, 100):
        for kind, p in sched.poll(t):
            seq += 1
            if kind == 'frame':
                c.execute("INSERT INTO frames(event_seq, session_id, node_id, rx_ts, rx_mono, verify, base_verify, seq_class, raw_hex, backend_ms, rssi, snr) VALUES (?, 1, ?, ?, ?, 'OK', 'OK', 'fresh', ?, 0, ?, ?)",
                          (seq, node_id_of(p.raw), T0 + t, t, p.raw.hex(), p.rssi, p.snr))
            elif hb:
                c.execute('INSERT INTO base_health(session_id, ts, uptime_ms, bat_pct, rx_ok, rx_bad_len, rx_bad_crc, rx_bad_mac) VALUES (1, ?, ?, ?, ?, 0, 0, 0)', (T0 + t, p.uptime_ms, p.bat_pct, p.rx_ok))
    for sql in (extra or ()): c.execute(sql)
    c.close(); return db

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def test_open_source_says_what_the_session_holds(tmp_path):
    h = home(tmp_path); db = make_source(h, 'quiet', 10); i = RP.open_source(db, 1)
    assert (i.session_id, i.mode, i.started_ts, i.ended_ts) == (1, 'LIVE', T0, T0 + 90_000) and i.frames >= 15 and i.heartbeats >= 10 and i.first_ts == T0 and i.last_ts >= T0 + 9000
    assert RP.label_of(i) == 'REPLAY of session 1 (LIVE, started 2023-11-14 22:13 UTC)'

def test_open_source_refuses_a_missing_database_a_missing_session_and_a_session_without_frames(tmp_path):
    h = home(tmp_path)
    with pytest.raises(RP.ReplayError, match='no database'): RP.open_source(h / 'data' / 'ppe.db', 1)
    db = make_source(h, 'quiet', 5)
    with pytest.raises(RP.ReplayError, match='session 9 is not in'): RP.open_source(db, 9)
    c = sqlite3.connect(db); c.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash) VALUES (2, 1, 'LIVE', 'b', 'c', 's')"); c.commit(); c.close()
    with pytest.raises(RP.ReplayError, match='no stored frame'): RP.open_source(db, 2)
    (h / 'data' / 'junk.db').write_bytes(b'not a database at all' * 50)
    with pytest.raises(RP.ReplayError): RP.open_source(h / 'data' / 'junk.db', 1)

def test_the_source_connection_cannot_write_and_reading_leaves_the_file_as_it_was(tmp_path):
    h = home(tmp_path); db = make_source(h, 'quiet', 10); before = sha(db); c = RP.connect_readonly(db)
    with pytest.raises(sqlite3.OperationalError): c.execute("UPDATE sessions SET mode = 'REPLAY'")
    with pytest.raises(sqlite3.OperationalError): c.execute('DELETE FROM frames')
    list(RP.items(c, 1)); c.close(); RP.open_source(db, 1); assert sha(db) == before

def test_items_are_in_time_order_with_offsets_from_the_first_and_both_kinds(tmp_path):
    h = home(tmp_path); db = make_source(h, 'quiet', 10); c = RP.connect_readonly(db); got = list(RP.items(c, 1)); c.close()
    offs = [o for o, _, _ in got]; assert offs[0] == 0 and offs == sorted(offs) and offs[-1] >= 9000
    assert {k for _, k, _ in got} == {'frame', 'hb'} and all(isinstance(p, Frame) for _, k, p in got if k == 'frame') and all(isinstance(p, Heartbeat) for _, k, p in got if k == 'hb')
    assert all(p.base_id == 1 for _, _, p in got)

def mem_source(rows, hbs=()):
    c = sqlite3.connect(':memory:'); c.execute('CREATE TABLE frames(event_seq, session_id, rx_ts, raw_hex, base_verify, rssi, snr)'); c.execute('CREATE TABLE base_health(id INTEGER PRIMARY KEY, session_id, ts, uptime_ms, bat_pct, rx_ok, rx_bad_len, rx_bad_crc, rx_bad_mac)')
    for i, ts in enumerate(rows): c.execute("INSERT INTO frames VALUES (?, 1, ?, '00', 'OK', NULL, NULL)", (i, ts))
    for ts in hbs: c.execute('INSERT INTO base_health(session_id, ts, uptime_ms, bat_pct, rx_ok, rx_bad_len, rx_bad_crc, rx_bad_mac) VALUES (1, ?, 1, 1, 1, 0, 0, 0)', (ts,))
    return c

def test_a_step_back_in_the_stored_time_counts_as_no_time_and_a_long_gap_is_cut():
    c = mem_source([1000, 3000, 2500, 4500, 4500 + 3_600_000, 4500 + 3_600_000 + 2000]); offs = [o for o, _, _ in RP.items(c, 1)]
    assert offs == [0, 2000, 2000, 4000, 4000 + RP.MAX_GAP_S * 1000, 6000 + RP.MAX_GAP_S * 1000]
    assert [o for o, _, _ in RP.items(c, 1, max_gap_ms=1000)] == [0, 1000, 1000, 2000, 3000, 4000]

def test_a_frame_comes_before_a_heartbeat_of_the_same_millisecond_and_a_gap_of_exactly_the_limit_is_kept():
    c = mem_source([1000, 2000], hbs=[1000, 1500, 2000]); got = [(o, k) for o, k, _ in RP.items(c, 1)]
    assert got == [(0, 'frame'), (0, 'hb'), (500, 'hb'), (1000, 'frame'), (1000, 'hb')]
    assert [o for o, _, _ in RP.items(mem_source([0, RP.MAX_GAP_S * 1000]), 1)] == [0, RP.MAX_GAP_S * 1000]

# ---- the thread ----
def wait_for(cond, timeout=5.0):
    end = time.monotonic() + timeout
    while not cond() and time.monotonic() < end: time.sleep(0.001)
    assert cond()

def wait_polls(th, n=2):
    target = th.polls + n; wait_for(lambda: th.polls >= target or th.finished.is_set())

def make_thread(db, speed=16, ready=None, got=None, done=None, **kw):
    base = FakeClock(T0, 0); clock = ScaledClock(base, speed); got = [] if got is None else got
    th = RP.ReplayThread(clock, lambda k, p: got.append((clock.mono_ms(), k, p)), db, 1, ready=ready, poll_s=0.002, on_done=(lambda: done.append(1)) if done is not None else None, **kw)
    return base, clock, th, got

def test_the_thread_delivers_each_item_when_the_scaled_clock_reaches_its_offset(tmp_path):
    h = home(tmp_path); db = make_source(h, 'quiet', 20); c = RP.connect_readonly(db); want = list(RP.items(c, 1)); c.close()
    base, clock, th, got = make_thread(db, 4); th.start()
    try:
        wait_polls(th); assert len(got) == 1 and got[0][1] in ('frame', 'hb')                    # offset 0 only
        t0 = th.started_at
        for _ in range(8): base.advance(500); wait_polls(th)                                    # 4 s of source time at 4x
    finally: th.stop()
    assert all(m - t0 >= o for (m, _, _), (o, _, _) in zip(got, want))                          # never early
    assert [(k, p) for _, k, p in got] == [(k, p) for _, k, p in want[:len(got)]]               # in order, none skipped
    assert len(got) == sum(1 for o, _, _ in want if o <= 16_000) and len(got) > 20

def test_nothing_is_delivered_before_ready_and_time_zero_is_the_moment_it_is(tmp_path):
    h = home(tmp_path); db = make_source(h, 'quiet', 20); flag = []; base, clock, th, got = make_thread(db, 1, ready=lambda: bool(flag)); th.start()
    try:
        wait_polls(th, 3); base.advance(30_000); wait_polls(th, 3); assert got == [] and th.started_at is None   # the host is still recovering
        flag.append(1); wait_for(lambda: th.started_at is not None); assert th.started_at == clock.mono_ms()
        wait_polls(th); assert len(got) >= 1 and got[0][0] == th.started_at                    # the first items are offset 0, not 30 s late
    finally: th.stop()

def test_pause_holds_the_replay_and_resume_goes_on_without_a_burst(tmp_path):
    h = home(tmp_path); db = make_source(h, 'quiet', 20); base, clock, th, got = make_thread(db, 1); th.start()
    try:
        wait_polls(th); base.advance(3000); wait_polls(th); n = len(got); assert n > 3
        th.pause(); assert th.paused; base.advance(600_000); wait_polls(th, 3); assert len(got) == n
        th.resume(); wait_polls(th); assert len(got) == n; base.advance(2000); wait_polls(th); assert n < len(got) <= n + 8
    finally: th.stop()

def test_at_the_end_of_the_data_the_clock_stops_finished_is_set_and_on_done_is_called_once(tmp_path):
    h = home(tmp_path); db = make_source(h, 'quiet', 6); done = []; base, clock, th, got = make_thread(db, 16, done=done); th.start()
    try:
        wait_polls(th); base.advance(10_000); wait_for(th.finished.is_set); wait_for(lambda: not th.alive())
        t = clock.mono_ms(); base.advance(100_000); assert clock.mono_ms() == t and clock.paused and done == [1]
    finally: th.stop()
    c = RP.connect_readonly(db); assert len(got) == len(list(RP.items(c, 1))); c.close(); assert th.counters['replay_frames'] + th.counters['replay_heartbeats'] == len(got)

def test_a_failing_handler_is_counted_and_never_stops_the_thread(tmp_path):
    h = home(tmp_path); db = make_source(h, 'quiet', 6); calls = []; clock = ScaledClock(FakeClock(T0, 0), 1)
    def cb(k, p):
        calls.append(k)
        if len(calls) == 1: raise RuntimeError('boom')
    th = RP.ReplayThread(clock, cb, db, 1, poll_s=0.002).start()
    try: wait_polls(th, 3); clock.base.advance(10_000); wait_for(th.finished.is_set)
    finally: th.stop()
    assert th.counters['replay_handler_errors'] == 1 and 'boom' in th.last_error and len(calls) > 3

def test_a_database_that_cannot_be_read_stops_the_thread_with_an_error_and_calls_on_done(tmp_path):
    done = []; th = RP.ReplayThread(ScaledClock(FakeClock(T0, 0), 1), lambda k, p: None, tmp_path / 'nope.db', 1, poll_s=0.002, on_done=lambda: done.append(1)).start()
    wait_for(lambda: not th.alive()); assert th.error and done == [1] and not th.finished.is_set()

def test_stop_returns_at_once_even_with_a_slow_poll(tmp_path):
    h = home(tmp_path); db = make_source(h, 'quiet', 6); th = RP.ReplayThread(ScaledClock(FakeClock(T0, 0), 1), lambda k, p: None, db, 1, poll_s=30).start(); wait_for(lambda: th.polls >= 1)
    t = time.monotonic(); th.stop(); assert time.monotonic() - t < 1 and not th.alive()

# ---- the runtime ----
def replay_runtime(tmp_path, speed=16, scenario='man_down', seconds=70):
    h = home(tmp_path); db = make_source(h, scenario, seconds); st = run(h, 'REPLAY'); M.begin_session(st); base = FakeClock(NOW, 0)
    rt = R.Runtime(st, base, replay=(1, speed)); rt.replay.poll_s = 0.002
    return h, db, st, rt, base

def rows(db, sql):
    c = sqlite3.connect(db); out = c.execute(sql).fetchall(); c.close(); return out

def test_a_replay_runtime_stores_the_source_frames_in_the_test_database_and_never_touches_the_original(tmp_path):
    h, db, st, rt, base = replay_runtime(tmp_path); before = sha(db); src = rows(db, 'SELECT COUNT(*) FROM frames')[0][0]; hbs = rows(db, 'SELECT COUNT(*) FROM base_health')[0][0]
    rt.start()
    try:
        assert rt.replay.alive() and not rt.serial and rt.sim is None and isinstance(rt.clock, ScaledClock) and rt.clock is not rt.real_clock
        wait_polls(rt.replay); assert rows(st.db_path, 'SELECT COUNT(*) FROM frames')[0][0] == 0 and rt.gate.depth() == 0     # the gate is not live yet: nothing is delivered
        rt.release()
        for _ in range(20): base.advance(500); wait_polls(rt.replay)
        wait_for(rt.replay.finished.is_set)
    finally: rt.stop(); st.close()
    assert sha(db) == before                                                                       # the original database is byte for byte what it was
    assert rows(st.db_path, "SELECT mode FROM sessions") == [('REPLAY',)] and rows(st.db_path, 'SELECT COUNT(*) FROM frames')[0][0] == src and rows(st.db_path, 'SELECT COUNT(*) FROM base_health')[0][0] == hbs
    assert rows(st.db_path, "SELECT node_id, type, level FROM alerts WHERE type = 'man_down'") == [(2, 'man_down', 'DANGER')]
    assert rows(st.db_path, "SELECT COUNT(*) FROM frames WHERE verify != 'OK'")[0][0] == 0

def test_replay_timestamps_follow_the_scaled_clock_from_the_start_of_the_replay(tmp_path):
    h, db, st, rt, base = replay_runtime(tmp_path, speed=4, scenario='quiet', seconds=20); rt.start()
    try:
        wait_polls(rt.replay); rt.release(); wait_polls(rt.replay)
        for _ in range(12): base.advance(500); wait_polls(rt.replay)
        wait_for(rt.replay.finished.is_set)
    finally: rt.stop(); st.close()
    ts = [r[0] for r in rows(st.db_path, 'SELECT rx_ts FROM frames ORDER BY event_seq')]
    assert ts == sorted(ts) and ts[0] >= NOW and ts[-1] - ts[0] <= 20_500 and ts[-1] - ts[0] >= 15_000                 # about 20 s of source time, at 4x

def test_pause_in_the_runtime_stops_storing_frames_and_resume_goes_on(tmp_path):
    h, db, st, rt, base = replay_runtime(tmp_path, speed=1, scenario='quiet', seconds=30); rt.start()
    try:
        wait_polls(rt.replay); rt.release(); wait_polls(rt.replay)
        for _ in range(6): base.advance(500); wait_polls(rt.replay)
        n = rt.replay.counters['replay_frames']; assert n > 3
        rt.replay.pause(); base.advance(300_000); wait_polls(rt.replay, 3); assert rt.replay.counters['replay_frames'] == n
        rt.replay.resume(); base.advance(1000); wait_polls(rt.replay, 3); assert rt.replay.counters['replay_frames'] > n
    finally: rt.stop(); st.close()

def test_the_os_watchdog_and_the_liveness_stamps_keep_the_real_clock_and_the_replay_stamp_is_retired_at_the_end(tmp_path):
    h, db, st, rt, base = replay_runtime(tmp_path, speed=16, scenario='quiet', seconds=5)
    assert rt.liveness.clock is rt.real_clock and rt.real_clock is base; rt.start()
    try:
        wait_for(lambda: 'replay' in rt.liveness.ages()); wait_polls(rt.replay); rt.release()
        for _ in range(10): base.advance(2000); wait_polls(rt.replay)
        wait_for(rt.replay.finished.is_set)
        wait_for(lambda: 'replay' not in rt.liveness.ages())                                       # a finished replay must not look like a stalled thread
    finally: rt.stop(); st.close()

@pytest.mark.parametrize('mode', ['LIVE', 'SIMULATOR'])
def test_a_replay_is_refused_outside_replay_mode_before_anything_is_built(tmp_path, mode):
    h = home(tmp_path); st = run(h, mode); M.begin_session(st)
    try:
        with pytest.raises(ValueError, match='REPLAY'): R.Runtime(st, FakeClock(NOW, 0), replay=(1, 4))
        assert not [t for t in threading.enumerate() if t.name == 'ReplayThread']
    finally: st.close()

def test_runtime_without_a_replay_is_as_before_the_real_clock_and_no_thread(tmp_path):
    h = home(tmp_path); st = run(h, 'REPLAY'); M.begin_session(st); base = FakeClock(NOW, 0); rt = R.Runtime(st, base); assert rt.replay is None and rt.clock is base and rt.real_clock is base
    rt.start(); rt.stop(); st.close(); assert not [t for t in threading.enumerate() if t.name == 'ReplayThread']

def test_the_runtime_leaves_no_replay_thread_behind(tmp_path):
    h, db, st, rt, base = replay_runtime(tmp_path); rt.start(); wait_polls(rt.replay); rt.stop(); st.close()
    assert not [t for t in threading.enumerate() if t.name == 'ReplayThread']

# ---- begin_session ----
def test_a_replay_session_is_never_resumed_the_old_one_is_abandoned_as_new_replay(tmp_path):
    h = home(tmp_path); st = run(h, 'REPLAY'); M.begin_session(st); first = st.session_id; st.close()
    st = run(h, 'REPLAY'); M.begin_session(st)
    try:
        assert st.session_id != first and not st.resumed
        assert rows(st.db_path, "SELECT detail FROM system_events WHERE kind = 'SESSION_ABANDONED'") == [('new_replay',)]
    finally: st.close()

@pytest.mark.parametrize('mode', ['LIVE', 'SIMULATOR'])
def test_other_modes_still_resume_a_young_session(tmp_path, mode):
    h = home(tmp_path); st = run(h, mode); M.begin_session(st); first = st.session_id; st.close(); st = run(h, mode); M.begin_session(st)
    try: assert st.session_id == first and st.resumed
    finally: st.close()

# ---- main ----
def run_main(tmp_path, argv, capsys, prepare=None):
    box = {}
    async def serve(rt, host, port): box['rt'] = rt; box['alive'] = rt.replay is not None and rt.replay.alive()
    tmp_path.mkdir(parents=True, exist_ok=True); h = home(tmp_path)
    if prepare: prepare(h)
    code = M.main(['--home', str(h)] + argv, serve=serve); out = capsys.readouterr(); return code, out.out, out.err, box, h

def test_main_replays_a_session_at_the_chosen_speed_and_labels_the_new_session(tmp_path, capsys):
    db = []; code, out, err, box, h = run_main(tmp_path, ['--mode', 'REPLAY', '--session', '1', '--speed', '4'], capsys, prepare=lambda h: db.append(make_source(h, 'quiet', 10)))
    assert code == 0 and box['alive'] and 'replaying session 1 at 4x' in out and box['rt'].clock.speed == 4 and box['rt'].replay.session_id == 1
    assert rows(h / 'data' / 'ppe_test.db', 'SELECT mode, session_label FROM sessions') == [('REPLAY', 'REPLAY of session 1 (LIVE, started 2023-11-14 22:13 UTC)')]

def test_main_defaults_to_speed_1(tmp_path, capsys):
    code, out, err, box, h = run_main(tmp_path, ['--mode', 'REPLAY', '--session', '1'], capsys, prepare=lambda h: make_source(h, 'quiet', 5))
    assert code == 0 and 'at 1x' in out and box['rt'].clock.speed == 1

@pytest.mark.parametrize('argv', [['--session', '1'], ['--speed', '4'], ['--mode', 'SIMULATOR', '--session', '1'], ['--mode', 'LIVE', '--speed', '16']])
def test_main_refuses_session_and_speed_outside_replay_mode_with_exit_2_and_starts_nothing(tmp_path, capsys, argv):
    h = home(tmp_path)
    assert M.main(['--home', str(h)] + argv, serve=lambda *a: pytest.fail('the server must not start')) == 2
    assert 'need --mode REPLAY' in capsys.readouterr().err and not (h / 'data').exists() and not (h / M.LOCK_NAME).exists()

def test_main_in_replay_mode_needs_a_session(tmp_path, capsys):
    h = home(tmp_path)
    assert M.main(['--home', str(h), '--mode', 'REPLAY'], serve=lambda *a: pytest.fail('the server must not start')) == 2
    assert '--session' in capsys.readouterr().err and not (h / 'data').exists()

def test_main_refuses_a_speed_that_is_not_1_4_or_16(tmp_path):
    h = home(tmp_path)
    for sp in ('2', '0', 'x'):
        with pytest.raises(SystemExit) as e: M.main(['--home', str(h), '--mode', 'REPLAY', '--session', '1', '--speed', sp], serve=lambda *a: pytest.fail('no'))
        assert e.value.code == 2

def test_main_exits_2_with_a_message_for_a_missing_database_or_session_and_writes_no_session(tmp_path, capsys):
    code, out, err, box, h = run_main(tmp_path, ['--mode', 'REPLAY', '--session', '1'], capsys)
    assert code == 2 and 'no database' in err and rows(h / 'data' / 'ppe_test.db', 'SELECT COUNT(*) FROM sessions')[0][0] == 0 and not (h / M.LOCK_NAME).exists()
    code, out, err, box, h = run_main(tmp_path / 'b', ['--mode', 'REPLAY', '--session', '7'], capsys, prepare=lambda h: make_source(h, 'quiet', 5))
    assert code == 2 and 'session 7 is not in' in err and rows(h / 'data' / 'ppe_test.db', 'SELECT COUNT(*) FROM sessions')[0][0] == 0

def test_main_exits_2_when_the_test_database_holds_an_open_alert_from_an_earlier_session(tmp_path, capsys):
    def prep(h):
        make_source(h, 'quiet', 5); st = run(h, 'SIMULATOR'); M.begin_session(st)
        st.conn.execute("INSERT INTO alerts(event_seq, session_id, node_id, type, level, raised_ts) VALUES (999, ?, 2, 'man_down', 'DANGER', 1)", (st.session_id,)); st.close()
    code, out, err, box, h = run_main(tmp_path, ['--mode', 'REPLAY', '--session', '1'], capsys, prepare=prep)
    assert code == 2 and '1 open alert' in err and 'ppe_test.db' in err and rows(h / 'data' / 'ppe_test.db', "SELECT COUNT(*) FROM sessions WHERE mode = 'REPLAY'")[0][0] == 0

def test_main_never_opens_the_original_database_for_writing(tmp_path, capsys):
    holder = []
    code, out, err, box, h = run_main(tmp_path, ['--mode', 'REPLAY', '--session', '1', '--speed', '16'], capsys, prepare=lambda h: holder.append(sha(make_source(h, 'man_down', 30))))
    assert code == 0 and sha(h / 'data' / 'ppe.db') == holder[0]                                  # SQLite may leave empty -wal and -shm files beside a WAL database it read; the database file itself is untouched

# ---- docs ----
def test_adr_0059_exists_is_proposed_and_progress_points_to_it():
    adr = (ROOT / 'docs' / 'adr' / '0059.md').read_text(encoding='utf8'); assert adr.startswith('# ADR 0059') and 'Status: Proposed' in adr
    assert all(w in adr for w in ('--session', '--speed', 'ScaledClock', 'read-only', 'MAX_GAP_S', 'new_replay', 'Decisions to confirm', 'Pause'))
    assert 'Part S7-3 done (ADR 0059' in (ROOT / 'docs' / 'PROGRESS.md').read_text(encoding='utf8')
