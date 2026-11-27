"""P25-2: start-up steps 11 to 13 wired into the host (services/recovery_run.py, Runtime.recover, serve.run_server, Wire.unconfirmed): the chunked rebuild with the liveness stamp, rejected_frames restored,
the silence clocks re-armed, RECOVERING_EXIT and HOST_GAP from the last row of the previous process, recovering=false, the pre-replay queue released after the exit, INTEGRITY_OK, and a failed rebuild that still ends RECOVERING.
Two real processes on one database: A writes frames and stops, B starts on the same home with a FakeClock, loads the open rows (step 9) and runs recover()."""
import asyncio, json, sqlite3, time
from types import SimpleNamespace as NS
from ppe_host import main as M, runtime as R
from ppe_host.clock import FakeClock
from ppe_host.core import rule_engine as eng
from ppe_host.host_port import HostPort
from ppe_host.io.db_writer import Stmt
from ppe_host.io.serial_reader import Frame
from ppe_host.services import recovery as RC, recovery_run as RR
from ppe_host.wire import Wire
from fakeport import FakePort
from test_gv_bytes import WRONG_KEY, pack
from test_startup import KEY as SKEY, NOW, home, run

HOSTKEY = bytes.fromhex(SKEY)      # config/secrets.json of the test home; the vectors' key is another one

def P(**kw): return pack(**{'key': HOSTKEY, 'sys_id': 1, **kw})          # settings.json sys_id is 1; the vectors use 90

CUR = []      # the Runtime of the test: system rows are queued, so a read waits for the writer first

def settle():
    for rt in CUR[-1:]:
        try: rt.writer.wait(rt.ingest.write([Stmt('SELECT 1', ())]), 3000)
        except Exception: pass

class Hub:
    """Collects every publish_* body (the Wire sends to the hub with _pub, so any name is accepted)."""
    def __init__(self): self.msgs = []
    def __getattr__(self, n):
        if n.startswith('publish_'): return lambda b: self.msgs.append((n, b))
        raise AttributeError(n)

def boot(h, clock, mode='SIMULATOR', wire=False, reason=None):
    st = run(h, mode); st.host_gap_reason = reason; M.begin_session(st, clock)
    rt = R.Runtime(st, clock, open_port=lambda: FakePort([])).start(); rt.load_open(); hub = None; CUR.append(rt)
    if wire:
        port = HostPort.from_startup(st, rt.ingest); hub = Hub(); rt.port = port; rt.wire = Wire(port, hub).attach()
    return st, rt, hub

def send(rt, clock, node=1, seq=0, dt=1000, key=None, **kw):
    clock.advance(dt); raw = P(seq=seq, node=node, **kw) if key is None else P(seq=seq, node=node, key=key, **kw)
    return rt.ingest.frame(Frame(raw, 'OK', -68.5, 9.2, 1, 1000))

def process_a(h, script=None):
    """The previous process: three quiet nodes, six frames each; script(rt, clock) may add more. Returns the wall time of its last write."""
    clock = FakeClock(NOW, 1000); st, rt, _ = boot(h, clock)
    for i in range(6):
        for n in (1, 2, 3): send(rt, clock, n, seq=i, co_x10=20)
    if script: script(rt, clock)
    last = clock.wall_ms(); rt.stop(); st.close(); return last

def process_b(h, last, gap_ms, **kw):
    clock = FakeClock(last + gap_ms, 500); st, rt, hub = boot(h, clock, wire=True, **kw); return st, rt, hub, clock

def rows(st, sql, args=()):
    settle(); c = sqlite3.connect(str(st.db_path)); out = c.execute(sql, args).fetchall(); c.close(); return out

def recover(rt): return asyncio.run(rt.recover())

def finish(rt, st): rt.stop(); st.close()

def kinds(st): return [k for (k,) in rows(st, "SELECT kind FROM system_events WHERE kind IN ('HOST_START','RECOVERING_ENTER','RECOVERING_EXIT','HOST_GAP','INTEGRITY_OK','INTEGRITY_FAIL','SESSION_ABANDONED') ORDER BY event_seq")]

# ---- exit rows, flags, gap ----
def test_recovering_exit_and_host_gap_are_logged_in_order_and_the_flags_are_cleared(tmp_path):
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 60_000)
    assert st.recovering and rt.port.recovering and rt.port.host_gap is None
    rep = recover(rt)
    assert kinds(st)[-5:] == ['HOST_START', 'RECOVERING_ENTER', 'RECOVERING_EXIT', 'HOST_GAP', 'INTEGRITY_OK'] and kinds(st).count('HOST_START') == 2
    assert (st.recovering, rt.port.recovering) == (False, False) and rep.done and rep.integrity == 'ok'
    assert rep.gap_ms == 60_000 and rt.port.host_gap == dict(gap_s=60.0, reason=None) and rep.gap_from_ts == last
    gap = json.loads(rows(st, "SELECT detail FROM system_events WHERE kind = 'HOST_GAP'")[0][0]); assert gap == dict(gap_s=60.0, from_ts=last, to_ts=last + 60_000)
    ex = json.loads(rows(st, "SELECT detail FROM system_events WHERE kind = 'RECOVERING_EXIT'")[0][0])
    assert ex['frames'] == 18 and ex['nodes'] == [1, 2, 3] and ex['error'] is None and ex['rearmed'] == [1, 2, 3]
    sysmsg = [b for n, b in hub.msgs if n == 'publish_system'][-1]; assert sysmsg['recovering'] is False and sysmsg['host_gap'] == dict(gap_s=60.0, reason=None)
    finish(rt, st)

def test_the_gap_starts_at_the_last_row_of_the_previous_process_whatever_kind_it_is(tmp_path):
    def script(rt, clock): clock.advance(5_000); rt.ingest.system_event('BASE_OFFLINE', 'x'); clock.advance(7_000)      # a later system row; the clock then runs on without a row
    h = home(tmp_path); process_a(h, script); c = sqlite3.connect(str(h / 'data' / 'ppe_test.db')); ts = c.execute("SELECT ts FROM system_events WHERE kind = 'BASE_OFFLINE'").fetchone()[0]; c.close()
    st, rt, hub, clock = process_b(h, ts, 10_000); rep = recover(rt)
    assert rep.gap_from_ts == ts and rep.gap_ms == 10_000; finish(rt, st)

def test_rows_of_this_start_up_never_count_not_even_the_session_abandoned_row(tmp_path):
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 40 * 60_000)           # older than session_resume_max_min: begin_session closes A's session ABANDONED
    assert 'SESSION_ABANDONED' in kinds(st); rep = recover(rt)
    assert rep.gap_ms == 40 * 60_000 and rep.gap_from_ts == last; finish(rt, st)

def test_a_new_database_has_no_earlier_row_and_so_no_host_gap(tmp_path):
    h = home(tmp_path); clock = FakeClock(NOW, 500); st, rt, hub = boot(h, clock, wire=True); rep = recover(rt)
    assert rep.gap_ms is None and rep.gap_from_ts is None and rt.port.host_gap is None and 'HOST_GAP' not in kinds(st) and 'RECOVERING_EXIT' in kinds(st) and st.recovering is False; finish(rt, st)

def test_a_restored_database_keeps_its_reason_and_gets_the_measured_gap(tmp_path):
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 90_000, reason='db_restored')
    assert rt.port.host_gap == dict(gap_s=0.0, reason='db_restored'); recover(rt)
    assert rt.port.host_gap == dict(gap_s=90.0, reason='db_restored'); finish(rt, st)

# ---- counters ----
def test_rejected_frames_are_restored_from_the_last_counters_row_plus_the_bad_frames_after_it(tmp_path):
    def script(rt, clock):
        rt.ingest.system_event('COUNTERS', json.dumps({'rejected_frames': 7}))
        for i in (10, 11): send(rt, clock, 1, seq=i, key=WRONG_KEY)                       # BAD_MAC: stored, verify != OK
        send(rt, clock, 1, seq=12, co_x10=20)
    h = home(tmp_path); last = process_a(h, script); st, rt, hub, clock = process_b(h, last, 5_000); assert rt.ingest.counters['rejected_frames'] == 0
    rep = recover(rt); assert rep.rejected_restored == 9 and rt.ingest.counters['rejected_frames'] == 9 and rt.health.counters.snapshot()['rejected_frames'] == 9
    finish(rt, st)

def test_without_a_counters_row_every_stored_bad_frame_counts(tmp_path):
    def script(rt, clock):
        for i in (10, 11, 12): send(rt, clock, 2, seq=i, key=WRONG_KEY)
    h = home(tmp_path); last = process_a(h, script); st, rt, hub, clock = process_b(h, last, 5_000); rep = recover(rt)
    assert rep.rejected_restored == 3 and rt.ingest.counters['rejected_frames'] == 3; finish(rt, st)

def test_an_unusable_counters_row_is_ignored_and_never_stops_recovery(tmp_path):
    def script(rt, clock): rt.ingest.system_event('COUNTERS', 'not json'); send(rt, clock, 1, seq=10, key=WRONG_KEY)
    h = home(tmp_path); last = process_a(h, script); st, rt, hub, clock = process_b(h, last, 5_000); rep = recover(rt)
    assert rep.rejected_restored == 1 and rep.done and st.recovering is False; finish(rt, st)

# ---- silence clocks and the unconfirmed state ----
def tick(rt, clock, secs):
    clock.advance(secs * 1000); fx, u = rt.ingest.tick()
    if u is not None: rt.writer.wait(u, 2000)
    return fx

def test_the_gap_alone_raises_nothing_but_a_node_that_died_during_the_outage_gets_signal_lost(tmp_path):
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 25 * 60_000); recover(rt)
    assert all(n.last_fresh_mono == clock.mono_ms() for n in rt.ingest.st.nodes.values()) and sorted(rt.ingest.st.nodes) == [1, 2, 3]      # started at RECOVERING_EXIT
    assert not tick(rt, clock, 14) and not rt.ingest.st.alerts                                                                              # 14 s after the exit: nothing, from the gap alone
    send(rt, clock, 1, seq=6, dt=500, co_x10=20); send(rt, clock, 2, seq=6, dt=500, co_x10=20)                                              # nodes 1 and 2 are alive, node 3 died in the outage
    tick(rt, clock, 2); assert {k for k in rt.ingest.st.alerts} == {(3, 'signal_lost')}; finish(rt, st)

def test_an_adverse_last_frame_gives_link_lost_after_link_lost_adverse_s_from_the_exit(tmp_path):
    def script(rt, clock): send(rt, clock, 3, seq=6, flags=0x01, co_x10=20)                                                                 # node 3's last frame reported WARNING
    h = home(tmp_path); last = process_a(h, script); st, rt, hub, clock = process_b(h, last, 60_000); recover(rt)
    adverse = rt.ingest.st.nodes[3].last_fresh_adverse; tick(rt, clock, 14); before = set(rt.ingest.st.alerts); tick(rt, clock, 40)
    assert adverse and (3, 'link_lost') not in before and (3, 'link_lost') in rt.ingest.st.alerts; finish(rt, st)

def test_unconfirmed_nodes_show_not_connected_until_their_first_fresh_frame_and_a_lost_link_still_wins(tmp_path):
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 60_000); w = rt.wire; recover(rt)
    assert [w.link_state(n) for n in (1, 2, 3)] == ['not_connected'] * 3 and w.unconfirmed == {1, 2, 3}
    assert {n['node_id']: n['link_state'] for n in w.snapshot()['nodes']} == {1: 'not_connected', 2: 'not_connected', 3: 'not_connected'}
    clock.advance(1000); rt.gate.on_item('frame', Frame(P(seq=3, node=2, co_x10=20), 'OK', -68.5, 9.2, 1, 1000))                         # a repeat of seq 3: suspect, not fresh
    assert w.link_state(2) == 'not_connected'
    clock.advance(1000); rt.gate.on_item('frame', Frame(P(seq=6, node=1, co_x10=20), 'OK', -68.5, 9.2, 1, 1000))
    assert w.link_state(1) == 'ok' and w.unconfirmed == {2, 3} and ('publish_link', dict(node_id=1, state='ok', since_ts=clock.wall_ms(), last_state='not_connected')) in hub.msgs
    tick(rt, clock, 20); assert w.link_state(3) == 'signal_lost' and w.link_state(2) == 'signal_lost'; finish(rt, st)

# ---- the queue ----
def test_a_frame_that_arrives_during_recovery_is_queued_and_processed_first_after_the_exit(tmp_path):
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 60_000)
    clock.advance(1000); rt.gate.on_item('frame', Frame(P(seq=6, node=3, flags=0x04 | 0x02), 'OK', -68.5, 9.2, 1, 1000))                  # a man-down edge, during RECOVERING
    n0 = rows(st, 'SELECT COUNT(*) FROM frames')[0][0]; assert rt.gate.depth() == 1 and rt.ingest.st.episodes == {}
    rep = recover(rt)
    assert rep.released == 1 and rt.gate.live and rt.gate.depth() == 0 and rows(st, 'SELECT COUNT(*) FROM frames')[0][0] == n0 + 1
    exit_seq = rows(st, "SELECT event_seq FROM system_events WHERE kind = 'RECOVERING_EXIT'")[0][0]; assert rows(st, 'SELECT MIN(event_seq) FROM frames WHERE node_id = 3 AND seq = 6')[0][0] > exit_seq
    assert rows(st, "SELECT COUNT(*), MIN(kind) FROM episodes WHERE node_id = 3 AND state = 'OPEN'")[0] == (1, 'MAN_DOWN'); finish(rt, st)

# ---- failures never keep the host in RECOVERING ----
def test_a_failed_rebuild_still_leaves_recovering_releases_the_queue_and_says_so(tmp_path, monkeypatch):
    def boom(self): raise RuntimeError('boom')
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 60_000)
    clock.advance(1000); rt.gate.on_item('frame', Frame(P(seq=6, node=1, co_x10=20), 'OK', -68.5, 9.2, 1, 1000))
    monkeypatch.setattr(RC.Rebuilder, 'step_chunk', boom); rep = recover(rt)
    ex = json.loads(rows(st, "SELECT detail FROM system_events WHERE kind = 'RECOVERING_EXIT'")[0][0])
    assert 'boom' in rep.error and 'boom' in ex['error'] and st.recovering is False and rt.port.recovering is False and rep.released == 1 and rt.gate.live and 'HOST_GAP' in kinds(st); finish(rt, st)

def test_a_step_12_failure_still_ends_recovering_and_releases_the_queue(tmp_path, monkeypatch):
    def boom(*a): raise RuntimeError('no database')
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 60_000); monkeypatch.setattr(RR, '_finish', boom); rep = recover(rt)
    assert st.recovering is False and rt.port.recovering is False and rep.done and rt.gate.live; finish(rt, st)

def test_a_failed_integrity_check_is_logged_as_integrity_fail(tmp_path, monkeypatch):
    class Proxy:
        def __init__(self, c): self.c = c
        def execute(self, q, *a): return iter([('*** in database main ***',), ('Page 3: btree error',)]) if 'integrity_check' in q else self.c.execute(q, *a)
        def close(self): self.c.close()
        def interrupt(self): pass
    real = RR._readonly; monkeypatch.setattr(RR, '_readonly', lambda rt: Proxy(real(rt)))
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 60_000); rep = recover(rt)
    assert rep.integrity.startswith('*** in database main ***; Page 3') and kinds(st)[-1] == 'INTEGRITY_FAIL' and rows(st, "SELECT detail FROM system_events WHERE kind = 'INTEGRITY_FAIL'")[0][0].startswith('integrity_check: ***'); finish(rt, st)

# ---- chunks and liveness ----
def test_the_chunk_is_500_rows_at_most_and_the_loop_stamp_is_touched_after_every_chunk(tmp_path, monkeypatch):
    seen = []
    class Spy(RC.Rebuilder):
        def __init__(self, *a, **k): seen.append(k.get('chunk')); super().__init__(*a, **k)
    monkeypatch.setattr(RC, 'Rebuilder', Spy)
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 60_000); stamps = []
    monkeypatch.setattr(rt.liveness, 'stamp', lambda name: stamps.append(name))
    recover(rt); assert seen == [500] and RR.STEP_CHUNK_ROWS == 500 and stamps == []                 # 18 rows: one chunk, nothing to beat
    rt2 = NS(**{k: getattr(rt, k) for k in ('ingest', 'st', 'clock', 'wire', 'port', 'liveness', 'offer_tick', 'audio_refresh', 'release')}); rt2.st = st
    st.recovering = True; asyncio.run(RR.run(rt2, chunk=4))
    assert seen[-1] == 4 and stamps == ['loop'] * 4; finish(rt, st)                                    # 18 rows in chunks of 4: 5 chunks, 4 of them have more to come

# ---- Runtime.recover, audio item, serve ----
def test_recover_runs_once_and_only_while_the_host_is_recovering(tmp_path):
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 60_000); a = recover(rt); b = recover(rt)
    assert a is b and a.done and kinds(st).count('RECOVERING_EXIT') == 1 and kinds(st).count('HOST_GAP') == 1
    st2 = NS(recovering=False); rt3 = R.Runtime.__new__(R.Runtime); rt3.st, rt3._recovery_started, rt3.recovery_report = st2, False, None; assert asyncio.run(rt3.recover()) is None; finish(rt, st)

def test_recovering_is_a_one_beep_audio_item_until_the_exit(tmp_path):
    h = home(tmp_path); last = process_a(h); st, rt, hub, clock = process_b(h, last, 60_000)
    assert dict(alert_type='recovering', level='NONE', acknowledged=False) in rt.audio_items(); recover(rt)
    assert [i for i in rt.audio_items() if i['alert_type'] == 'recovering'] == []; finish(rt, st)

def test_run_server_starts_recovery_after_the_driver_and_cancels_it_on_shutdown():
    from test_serve import FakeServer, arun
    from ppe_host import serve as S
    ev = []
    async def recover():
        ev.append('recover'); 
        try: await asyncio.sleep(30)
        finally: ev.append('cancelled')
    rt = NS(tick=lambda: ev.append('tick'), recover=recover); arun(S.run_server(rt, 'h', 1, app_factory=lambda r, l: (None, None), make_server=lambda a: FakeServer(delay=0.05, run_for=0.3)))
    assert ev[0] in ('tick', 'recover') and 'recover' in ev and ev[-1] == 'cancelled' and 'tick' in ev

def test_run_server_without_a_recover_method_still_works():
    from test_serve import FakeServer, arun
    from ppe_host import serve as S
    arun(S.run_server(NS(tick=lambda: None), 'h', 1, app_factory=lambda r, l: (None, None), make_server=lambda a: FakeServer(delay=0.05, run_for=0.1)))

def test_run_server_with_a_real_runtime_recovers_while_it_serves(tmp_path):
    """The whole of start-up step 10 to 13 with a real Runtime, Wire, 1 Hz driver and a fake Uvicorn: recovery starts after the driver, the ticks go on during it, and RECOVERING ends."""
    from test_serve import FakeServer, arun
    from ppe_host import serve as S
    h = home(tmp_path); last = process_a(h); clock = FakeClock(last + 60_000, 500); st = run(h, 'SIMULATOR'); M.begin_session(st, clock)
    rt = R.Runtime(st, clock, open_port=lambda: FakePort([])).start(); rt.load_open(); box = {}
    def factory(r, loop):
        port = HostPort.from_startup(st, r.ingest); hub = Hub(); r.port = port; r.wire = Wire(port, R.LoopHub(hub, loop)).attach(); box['hub'] = hub; return None, hub
    srv = FakeServer(delay=0.05, run_for=1.5); arun(S.run_server(rt, 'h', 1, app_factory=factory, make_server=lambda a: srv))
    assert rt.ticks >= 1 and st.recovering is False and rt.port.recovering is False and rt.recovery_report.done and rt.recovery_report.integrity == 'ok'
    assert kinds(st)[-3:] == ['RECOVERING_EXIT', 'HOST_GAP', 'INTEGRITY_OK'] and [b for n, b in box['hub'].msgs if n == 'publish_system'][-1]['recovering'] is False; finish(rt, st)
