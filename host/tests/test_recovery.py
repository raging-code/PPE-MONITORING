"""P25-1: services/recovery.py (start-up step 11, ADR 0037): the rebuild of the engine state from the last 30 minutes of stored frames. Real database and writer, FakeClock."""
import asyncio, json
from ppe_host.clock import FakeClock
from ppe_host.core import rule_engine as eng
from ppe_host.io.db_writer import DBWriter
from ppe_host.io.ingest import Ingest
from ppe_host.io.serial_reader import Frame
from ppe_host.services import recovery as RC
from test_db_schema import new_db, session
from test_gv_bytes import KEY, SYS, pack

T = 1_700_000_000_000

def live(tmp_path):
    c = new_db(tmp_path); session(c); clock = FakeClock(T, 10_000)
    c.execute("INSERT INTO system_events(session_id, event_seq, ts, kind, detail) VALUES (1, 0, ?, 'HOST_START', ?)", (T, json.dumps({'mono_base_ms': 10_000, 'wall_base_ms': T})))
    w = DBWriter(tmp_path / 't.db', clock, retry_sleep_s=0.005).start()
    return c, w, clock, Ingest(KEY, SYS, (1, 2, 3), w, clock, 1, event_seq_start=100)

def send(ing, clock, node=1, seq=0, dt=1000, **kw):
    clock.advance(dt); return ing.frame(Frame(pack(seq=seq, node=node, **kw), 'OK', -68.5, 9.2, 1, 1000))

def scenario(ing, clock):
    """node 1: CO climbs (a co_threshold alert opens), node 2: a man-down edge (episode and alert), node 3: quiet frames."""
    for i in range(6):
        send(ing, clock, 1, seq=i, co_x10=200 + 300 * i, flags=0)
        send(ing, clock, 3, seq=i, co_x10=20)
    for i in range(3): send(ing, clock, 2, seq=i, flags=0)
    for i in range(3, 6): send(ing, clock, 2, seq=i, flags=0x04 | 0x02)

def restart(tmp_path, c, ing_a, w, gap_ms, advance=True):
    """A second process: same database, a new Ingest, the open rows loaded (step 9). Returns (Ingest, writer, clock)."""
    w.stop(); clock = FakeClock(ing_a.clock.wall_ms() + gap_ms, 500)
    w2 = DBWriter(tmp_path / 't.db', clock, retry_sleep_s=0.005).start()
    b = Ingest(KEY, SYS, (1, 2, 3), w2, clock, 1, event_seq_start=ing_a.st.event_seq)
    b.load_open(c); return b, w2, clock

def counts(c): return {t: c.execute('SELECT COUNT(*) FROM ' + t).fetchone()[0] for t in ('frames', 'alerts', 'episodes', 'system_events', 'audit_events')}
def norm(st): return {n: RC.reset_timers(v) for n, v in st.nodes.items()}

def test_an_empty_database_rebuilds_nothing(tmp_path):
    c, w, clock, a = live(tmp_path); b, w2, _ = restart(tmp_path, c, a, w, 60_000)
    rep = RC.Rebuilder(b, c, b.clock).run(); w2.stop()
    assert (rep.done, rep.frames, rep.anchor_ts, rep.nodes) == (True, 0, None, frozenset()) and b.st.nodes == {} and b.st.event_seq == a.st.event_seq

def test_the_rebuilt_state_equals_the_live_state_apart_from_the_timers(tmp_path):
    c, w, clock, a = live(tmp_path); scenario(a, clock)
    assert a.st.alerts and a.st.episodes, 'the scenario must open something'
    b, w2, _ = restart(tmp_path, c, a, w, 25 * 60_000)
    rep = RC.Rebuilder(b, c, b.clock).run(); w2.stop()
    assert rep.frames == 18 and rep.nodes == {1, 2, 3} and rep.skipped == 0
    assert norm(b.st) == norm(a.st) and b.st.alerts == a.st.alerts and b.st.episodes == a.st.episodes     # the open rows are the ones step 9 loaded, with their row references

def test_a_rebuild_writes_nothing_uses_no_event_seq_and_returns_no_effects(tmp_path):
    c, w, clock, a = live(tmp_path); scenario(a, clock); b, w2, _ = restart(tmp_path, c, a, w, 60_000)
    before, seq = counts(c), b.st.event_seq; RC.Rebuilder(b, c, b.clock).run(); w2.stop()
    assert counts(c) == before and b.st.event_seq == seq and w2.counters['commits'] == 0

def test_an_alert_the_replay_raises_but_no_row_holds_open_does_not_exist(tmp_path):
    c, w, clock, a = live(tmp_path); scenario(a, clock)
    c.execute('UPDATE alerts SET cleared_ts = ? WHERE type = ?', (T, 'co_threshold'))       # cleared since: the operator or the engine closed it
    b, w2, _ = restart(tmp_path, c, a, w, 60_000); RC.Rebuilder(b, c, b.clock).run(); w2.stop()
    assert (1, 'co_threshold') not in b.st.alerts and (2, 'man_down') in b.st.alerts

def test_a_resolved_but_still_latched_node_opens_no_new_episode_on_its_first_live_frame(tmp_path):
    c, w, clock, a = live(tmp_path); scenario(a, clock)
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (7, 'op', 'x', 1, 1)")
    c.execute("UPDATE episodes SET state = 'RESOLVED', resolved_by = 7, resolved_ts = ?, resolve_reason = 'rescued'", (T,)); c.execute('UPDATE alerts SET cleared_ts = ? WHERE node_id = 2', (T,))
    b, w2, clock2 = restart(tmp_path, c, a, w, 60_000); RC.Rebuilder(b, c, b.clock).run()
    assert b.st.episodes == {} and b.st.nodes[2].mandown_prev is True
    r = send(b, clock2, 2, seq=6, flags=0x04 | 0x02); w2.stop()
    assert not [e for e in r.effects if isinstance(e, eng.EpisodeOpened)] and not [e for e in r.effects if isinstance(e, eng.RaiseAlert)]

def test_a_node_silent_for_more_than_30_minutes_has_no_baseline_and_a_mandown_frame_opens_an_episode(tmp_path):
    c, w, clock, a = live(tmp_path)
    for i in range(3): send(a, clock, 1, seq=i, flags=0)
    send(a, clock, 2, seq=0, dt=31 * 60_000)                                                # node 2 is the newest frame: the window is the 30 minutes before it
    b, w2, clock2 = restart(tmp_path, c, a, w, 60_000); rep = RC.Rebuilder(b, c, b.clock).run()
    assert rep.nodes == {2} and 1 not in b.st.nodes
    r = send(b, clock2, 1, seq=9, flags=0x04 | 0x02); w2.stop()
    assert [type(e).__name__ for e in r.effects if isinstance(e, eng.EpisodeOpened)] == ['EpisodeOpened']      # accepted over-alarm (section 1, Rev 3.42)

def test_the_window_ends_at_the_newest_frame_not_at_the_restart(tmp_path):
    c, w, clock, a = live(tmp_path); scenario(a, clock)
    b, w2, _ = restart(tmp_path, c, a, w, 25 * 60_000); rep = RC.Rebuilder(b, c, b.clock).run(); w2.stop()        # 25 minutes of outage: every node of the last 30 minutes is restored
    assert rep.nodes == {1, 2, 3} and rep.window_start_ts == rep.anchor_ts - 30 * 60_000

def test_the_gap_alone_raises_no_signal_lost_link_lost_or_co_timeout_and_the_first_fresh_frame_restarts_the_timers(tmp_path):
    c, w, clock, a = live(tmp_path); scenario(a, clock)
    b, w2, clock2 = restart(tmp_path, c, a, w, 25 * 60_000); RC.Rebuilder(b, c, b.clock).run()
    assert all(n.last_fresh_mono is None and n.last_valid_co_mono is None for n in b.st.nodes.values())
    clock2.advance(120_000); st, fx = eng.step(b.st, eng.TickEvent(), eng.Now(clock2.wall_ms(), clock2.mono_ms()))
    assert not [e for e in fx if isinstance(e, eng.RaiseAlert) and e.type in ('signal_lost', 'link_lost', 'sensor_fault')]
    send(b, clock2, 3, seq=6, co_x10=20); assert b.st.nodes[3].last_fresh_mono == clock2.mono_ms()
    clock2.advance(16_000); st, fx = eng.step(b.st, eng.TickEvent(), eng.Now(clock2.wall_ms(), clock2.mono_ms())); w2.stop()
    assert (3, 'signal_lost') in st.alerts                                                    # silent 16 s since the first fresh frame: the 15 s timer is running again

def test_the_sequence_baseline_is_rebuilt_so_the_first_live_frame_is_judged_against_it(tmp_path):
    c, w, clock, a = live(tmp_path)
    for i in range(4): send(a, clock, 3, seq=i, co_x10=20)
    b, w2, clock2 = restart(tmp_path, c, a, w, 60_000); RC.Rebuilder(b, c, b.clock).run()
    again = send(b, clock2, 3, seq=3, co_x10=20); nxt = send(b, clock2, 3, seq=4, co_x10=20); w2.stop()
    assert (again.seq_class, nxt.seq_class) == ('suspect', 'fresh')      # a repeated seq a minute later is not a duplicate any more, it is behind the baseline; without a baseline it would be 'fresh'
    assert b.cs.nodes[3].seq == 4

def test_monotonic_stamps_of_an_earlier_epoch_are_rebased_by_the_host_start_row(tmp_path):
    now = eng.Now(T + 600_000, 5_000)
    ep = [RC.Epoch(0, 10_000, T), RC.Epoch(500, 1_000, T + 300_000)]; seqs = [e.event_seq for e in ep]
    assert RC.rebased_mono(ep, seqs, 10, 70_000, T + 60_000, now) == 5_000 - 600_000 + 60_000        # epoch 1: wall = T + 60 000, 540 s old
    assert RC.rebased_mono(ep, seqs, 600, 61_000, T + 999, now) == 5_000 - (600_000 - 360_000)        # epoch 2 (a reboot reset the clock): wall = T + 300 000 + 60 000
    assert RC.rebased_mono([], [], 10, 70_000, T + 60_000, now) == 5_000 - 540_000                    # no HOST_START: the stored wall time
    assert RC.rebased_mono(ep, seqs, 10, 70_000, T + 60_000, now) < RC.rebased_mono(ep, seqs, 600, 61_000, T, now)

def test_a_reboot_inside_the_window_gives_the_same_state_as_no_reboot(tmp_path):
    c, w, clock, a = live(tmp_path); scenario(a, clock); w.stop()
    plain, _, _ = restart(tmp_path, c, a, w, 60_000); RC.Rebuilder(plain, c, plain.clock).run()
    cut = c.execute('SELECT event_seq FROM frames ORDER BY frame_id LIMIT 1 OFFSET 9').fetchone()[0]          # the host rebooted after the 9th frame: monotonic time restarted from a small value
    c.execute("INSERT INTO system_events(session_id, event_seq, ts, kind, detail) VALUES (1, ?, ?, 'HOST_START', ?)", (cut, T + 99, json.dumps({'mono_base_ms': 300, 'wall_base_ms': c.execute('SELECT rx_ts FROM frames WHERE event_seq = ?', (cut,)).fetchone()[0] - 1000})))
    c.execute('UPDATE frames SET rx_mono = rx_mono - (SELECT rx_mono FROM frames WHERE event_seq = ?) + 1300 WHERE event_seq >= ?', (cut, cut))
    rebooted, _, _ = restart(tmp_path, c, a, w, 60_000); RC.Rebuilder(rebooted, c, rebooted.clock).run()
    assert norm(rebooted.st) == norm(plain.st) and rebooted.st.alerts == plain.st.alerts

def test_chunks_give_the_same_result_and_the_caller_gets_control_between_them(tmp_path):
    c, w, clock, a = live(tmp_path); scenario(a, clock); b, w2, _ = restart(tmp_path, c, a, w, 60_000); big, w3, _ = restart(tmp_path, c, a, w2, 60_000)
    RC.Rebuilder(big, c, big.clock).run(); beats = []; rb = RC.Rebuilder(b, c, b.clock, chunk=4); rep = rb.run(on_chunk=lambda: beats.append(1)); w3.stop()
    assert rep.chunks == 5 and len(beats) == 4 and norm(b.st) == norm(big.st) and b.st.alerts == big.st.alerts and b.cs == big.cs

def test_run_async_yields_to_the_event_loop_between_chunks(tmp_path):
    c, w, clock, a = live(tmp_path); scenario(a, clock); b, w2, _ = restart(tmp_path, c, a, w, 60_000)
    async def main():
        ticks = []
        async def beat():
            while True: ticks.append(1); await asyncio.sleep(0)
        t = asyncio.ensure_future(beat()); rep = await RC.Rebuilder(b, c, b.clock, chunk=2).run_async(); t.cancel(); return rep, len(ticks)
    rep, n = asyncio.run(main()); w2.stop()
    assert rep.frames == 18 and n >= rep.chunks - 1

def test_a_row_that_no_longer_decodes_is_skipped_and_counted(tmp_path):
    c, w, clock, a = live(tmp_path); scenario(a, clock); c.execute("UPDATE frames SET raw_hex = 'zz' WHERE frame_id = 3"); c.execute("UPDATE frames SET raw_hex = '00' WHERE frame_id = 4")
    b, w2, _ = restart(tmp_path, c, a, w, 60_000); rep = RC.Rebuilder(b, c, b.clock).run(); w2.stop()
    assert rep.skipped == 2 and rep.frames == 16

def test_the_window_is_found_through_the_node_index_without_scanning_frames(tmp_path):
    c, w, clock, a = live(tmp_path); w.stop()
    plan = ' '.join(r[3] for r in c.execute('EXPLAIN QUERY PLAN SELECT MIN(frame_id) FROM frames WHERE node_id = ? AND rx_ts >= ?', (1, 0)))
    assert 'idx_frames_node_ts' in plan and 'SCAN' not in plan.replace('SCAN frames USING', '')
