"""P24-3c-3 part 2: start-up step 10 (serve.py): LoopHub, Runtime.tick, the 1 Hz driver, run_server, the exit codes of main(), and build_app. Timing tests use margins of several times the period."""
import asyncio, socket, threading, time
from types import SimpleNamespace as NS
import pytest
from ppe_host import main as M, runtime as R, serve as S
from test_startup import home
from test_runtime import started

def arun(coro): return asyncio.run(coro)

# ---- LoopHub ----
def test_loophub_runs_publishes_from_another_thread_on_the_loop_in_order():
    got = []
    class Hub:
        def publish_reading(self, b): got.append((b, threading.current_thread().name))
        def publish_alert(self, b): got.append((b, threading.current_thread().name))
    async def go():
        lh = R.LoopHub(Hub(), asyncio.get_running_loop())
        t = threading.Thread(target=lambda: [lh.publish_reading(1), lh.publish_alert(2), lh.publish_reading(3)], name='worker'); t.start(); t.join()
        assert got == []                                            # nothing ran on the worker thread
        await asyncio.sleep(0.05)
    arun(go()); assert [b for b, _ in got] == [1, 2, 3] and {n for _, n in got} == {'MainThread'}

def test_loophub_passes_other_attributes_through_and_a_missing_method_stays_missing():
    class Hub:
        queue_max = 64
        def connected_tabs(self): return 3
    async def go():
        lh = R.LoopHub(Hub(), asyncio.get_running_loop())
        assert lh.queue_max == 64 and lh.connected_tabs() == 3
        assert getattr(lh, 'publish_advisory', None) is None       # Wire._pub skips a hub that lacks the method
    arun(go())

def test_loophub_drops_a_publish_after_the_loop_has_closed():
    class Hub:
        def publish_reading(self, b): raise AssertionError('must not run')
    loop = asyncio.new_event_loop(); lh = R.LoopHub(Hub(), loop); loop.close()
    lh.publish_reading(1)                                           # no exception: the host is shutting down

# ---- Runtime.tick ----
def stub(order, fail=(), wire=True):
    def part(name):
        def f():
            order.append(name)
            if name in fail: raise RuntimeError(name)
        return f
    return NS(offer_tick=part('host_tick'), health=NS(tick=part('health')), host_health=NS(tick=part('host_health')), audio_refresh=part('audio'), wire=NS(tick=part('wire')) if wire else None, ticks=0)

def test_tick_runs_host_tick_then_health_then_host_health_then_audio_then_wire():
    order = []; s = stub(order); R.Runtime.tick(s); R.Runtime.tick(s)
    assert order == ['host_tick', 'health', 'host_health', 'audio', 'wire'] * 2 and s.ticks == 2

def test_one_failing_part_is_logged_and_the_others_still_run(caplog):
    for bad in ('host_tick', 'health', 'host_health', 'audio', 'wire'):
        order = []; s = stub(order, fail=(bad,)); R.Runtime.tick(s)
        assert order == ['host_tick', 'health', 'host_health', 'audio', 'wire'] and s.ticks == 1
    assert 'failed' in caplog.text

def test_tick_without_a_wire_still_sends_the_host_tick_and_runs_health():
    order = []; s = stub(order, wire=False); R.Runtime.tick(s); assert order == ['host_tick', 'health', 'host_health', 'audio']

def test_tick_of_a_real_runtime_sends_one_host_tick_line_and_one_engine_tick(tmp_path):
    sent = []
    st, rt = started(tmp_path, 'SIMULATOR'); rt.serial = True; rt.serial_writer = NS(offer=sent.append, counters={'ticks_dropped': 0})
    rt.wire = NS(tick=lambda: sent.append('engine tick'))
    rt.tick(); assert len(sent) == 2 and sent[0].startswith(b'{') and sent[1] == 'engine tick' and rt.ticks == 1
    rt.writer.conn.close(); st.close()

# ---- the driver ----
def test_the_driver_ticks_on_a_fixed_grid_in_a_worker_thread():
    stamps, threads = [], set()
    rt = NS(tick=lambda: (stamps.append(time.monotonic()), threads.add(threading.current_thread().name)))
    async def go():
        d = asyncio.ensure_future(S.tick_driver(rt, 0.05)); await asyncio.sleep(0.52); d.cancel(); await asyncio.gather(d, return_exceptions=True)
    arun(go())
    assert 8 <= len(stamps) <= 11 and 'MainThread' not in threads
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]; assert max(gaps) < 0.12 and abs(sum(gaps) / len(gaps) - 0.05) < 0.015

def test_a_slow_tick_does_not_cause_a_burst_of_catch_up_ticks():
    stamps = []
    def tick():
        stamps.append(time.monotonic())
        if len(stamps) == 2: time.sleep(0.25)                     # five periods
    async def go():
        d = asyncio.ensure_future(S.tick_driver(NS(tick=tick), 0.05)); await asyncio.sleep(0.8); d.cancel(); await asyncio.gather(d, return_exceptions=True)
    arun(go()); gaps = [b - a for a, b in zip(stamps[2:], stamps[3:])]
    assert gaps and min(gaps) > 0.005                           # after the overrun the ticks are one period apart again, never back to back

def test_cancelling_the_driver_stops_the_ticks():
    n = []
    async def go():
        d = asyncio.ensure_future(S.tick_driver(NS(tick=lambda: n.append(1)), 0.02)); await asyncio.sleep(0.1); d.cancel(); await asyncio.gather(d, return_exceptions=True)
        c = len(n); await asyncio.sleep(0.1); return c
    c = arun(go()); assert c >= 2 and len(n) == c

# ---- run_server with a fake Uvicorn ----
class FakeServer:
    def __init__(self, delay=0.05, run_for=0.3, fail=None): self.started, self.delay, self.run_for, self.fail, self.events = False, delay, run_for, fail, []
    async def serve(self):
        await asyncio.sleep(self.delay)
        if self.fail: raise self.fail
        self.started = True; self.events.append('started'); await asyncio.sleep(self.run_for); self.events.append('stopped')

def test_the_driver_starts_only_after_the_server_accepts_and_stops_with_it():
    srv = FakeServer(delay=0.2, run_for=0.3); seen = []
    rt = NS(tick=lambda: seen.append((srv.started, time.monotonic())))
    arun(S.run_server(rt, 'h', 1, app_factory=lambda r, l: (None, None), make_server=lambda a: srv))
    assert seen and all(started for started, _ in seen)           # never a tick before Uvicorn was up
    n = len(seen); time.sleep(0.1); assert len(seen) == n         # the driver ended with run_server

def test_run_server_passes_the_app_and_the_loop_to_the_factory():
    got = {}
    def factory(rt, loop): got['rt'], got['loop'] = rt, loop; return 'APP', 'HUB'
    def make(app): got['app'] = app; return FakeServer(run_for=0.05)
    rt = NS(tick=lambda: None); arun(S.run_server(rt, 'h', 1, app_factory=factory, make_server=make))
    assert got['rt'] is rt and got['app'] == 'APP' and got['loop'] is not None

def test_a_bind_failure_becomes_serveerror():
    class Bad(FakeServer):
        async def serve(self): raise SystemExit(1)                  # what uvicorn does after a failed bind
    with pytest.raises(S.ServeError, match='port in use'): arun(S.run_server(NS(tick=lambda: None), 'h', 1, app_factory=lambda r, l: (None, None), make_server=lambda a: Bad()))

def test_a_server_that_ends_before_it_started_is_a_serveerror():
    class Quick(FakeServer):
        async def serve(self): return
    with pytest.raises(S.ServeError): arun(S.run_server(NS(tick=lambda: None), 'h', 1, app_factory=lambda r, l: (None, None), make_server=lambda a: Quick()))

# ---- main(): step 10 and the exit codes ----
def test_main_calls_serve_with_the_bind_settings_after_steps_8_and_9(tmp_path, capsys):
    h = home(tmp_path); seen = {}
    async def serve(rt, host, port):
        seen.update(host=host, port=port, started=rt.started, writer_alive=rt.writer._thread.is_alive(), out=capsys.readouterr().out)
    assert M.main(['--home', str(h)], serve=serve) == 0
    assert seen['host'] == '127.0.0.1' and seen['port'] == 8420 and seen['started'] and seen['writer_alive'] and 'steps 1 to 9 done' in seen['out']
    assert not (h / M.LOCK_NAME).exists()

def test_main_stops_the_runtime_and_releases_the_lock_after_serve(tmp_path):
    h = home(tmp_path); box = {}
    async def serve(rt, host, port): box['rt'] = rt
    assert M.main(['--home', str(h)], serve=serve) == 0 and not box['rt'].writer._thread.is_alive() and not (h / M.LOCK_NAME).exists()

def test_a_port_that_cannot_be_bound_exits_with_code_2_and_cleans_up(tmp_path, capsys):
    h = home(tmp_path); box = {}
    async def serve(rt, host, port): box['rt'] = rt; raise S.ServeError('Uvicorn could not start on %s:%s (port in use?)' % (host, port))
    assert M.main(['--home', str(h)], serve=serve) == 2
    assert 'step 10 failed' in capsys.readouterr().err and not box['rt'].writer._thread.is_alive() and not (h / M.LOCK_NAME).exists()

def test_any_other_failure_in_step_10_exits_with_code_1_and_cleans_up(tmp_path):
    h = home(tmp_path); box = {}
    async def serve(rt, host, port): box['rt'] = rt; raise ValueError('boom')
    assert M.main(['--home', str(h)], serve=serve) == 1 and not box['rt'].writer._thread.is_alive() and not (h / M.LOCK_NAME).exists()

def test_the_database_has_a_host_start_row_when_serve_fails(tmp_path):
    h = home(tmp_path)
    async def serve(rt, host, port): raise S.ServeError('x')
    M.main(['--home', str(h)], serve=serve)
    import sqlite3; assert sqlite3.connect(str(h / 'data' / 'ppe.db')).execute("SELECT COUNT(*) FROM system_events WHERE kind = 'HOST_START'").fetchone()[0] == 1

# ---- build_app and the real Uvicorn (need fastapi and uvicorn, as the rest of the API tests do) ----
def test_build_app_wires_port_hub_wire_and_advisory(tmp_path):
    st, rt = started(tmp_path, 'SIMULATOR'); rt.start()
    async def go():
        app, hub = S.build_app(rt, asyncio.get_running_loop())
        assert rt.port is hub.src and rt.wire.port is rt.port and app.state.ws_hub is hub and app.state.port is rt.port
        assert rt.ingest.broadcast == rt.wire.on_frame and rt.port.wire is rt.wire and rt.ingest.adv_cfg is not None
        assert hub.bind_port == 8420 and hub.queue_max == 64 and isinstance(rt.wire.hub, R.LoopHub)
    arun(go()); rt.stop(); st.close()

def free_port():
    with socket.socket() as s: s.bind(('127.0.0.1', 0)); return s.getsockname()[1]

def test_real_uvicorn_accepts_connections_ticks_and_stops_on_request(tmp_path):
    import uvicorn
    st, rt = started(tmp_path, 'SIMULATOR'); rt.start(); port = free_port(); box = {}
    def make(app): box['s'] = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='warning', lifespan='on')); box['s'].install_signal_handlers = lambda: None; return box['s']
    async def go():
        job = asyncio.ensure_future(S.run_server(rt, '127.0.0.1', port, make_server=make))
        for _ in range(100):
            if rt.ticks: break
            await asyncio.sleep(0.05)
        r, w = await asyncio.open_connection('127.0.0.1', port); w.close()
        box['s'].should_exit = True; await asyncio.wait_for(job, 5)
    arun(go()); assert rt.ticks >= 1
    rt.stop(); st.close()

def test_a_taken_port_raises_serveerror_with_real_uvicorn(tmp_path):
    st, rt = started(tmp_path, 'SIMULATOR'); rt.start()
    with socket.socket() as blocker:
        blocker.bind(('127.0.0.1', 0)); blocker.listen(1); port = blocker.getsockname()[1]
        with pytest.raises(S.ServeError): arun(S.run_server(rt, '127.0.0.1', port))
    rt.stop(); st.close()
