"""serve.py (P24-3c-3, ADR 0035): start-up step 10 of design 14.5: Uvicorn with the REST app and the WebSocket hub, then the 1 Hz driver of Runtime.tick().
build_app wires HostPort, Hub and Wire to the Runtime (Wire gets the Hub through LoopHub, because frames arrive on the SerialReader thread). run_server starts Uvicorn, waits until it
accepts connections, and only then starts the driver, so the first tick never runs before the API is up. The driver keeps a fixed 1 s grid: a slow tick does not shift the next one, and a
tick that overran is not made up by a burst. It stops first on shutdown, then Uvicorn closes the sockets. Not here: the OS watchdog liveness stamp (Hub.on_tick, P24b)."""
import asyncio, logging, time

log = logging.getLogger('ppe.serve')

class ServeError(RuntimeError):
    """Uvicorn could not start (the port is taken or cannot be bound). main.py exits with code 2 for it: retrying at once cannot help, so it counts toward the crash-loop guard."""

def tab_counter(hub):
    """Hub.connected_tabs for another thread. The loop adds and removes sockets while the AudioThread counts them, and iterating a set that changes raises RuntimeError: try again, and if it
    keeps failing assume a tab is connected, because a wrong count must not raise a false zero-socket warning."""
    def count():
        for _ in range(3):
            try: return hub.connected_tabs()
            except RuntimeError: continue
        return 1
    return count

def build_app(rt, loop):
    """The FastAPI app of a started Runtime. Sets rt.port and rt.wire, turns the Tier 1 advisory on (advisory_heartbeat_s) and connects the AudioThread (alarm feed, AUDIO FAULT banner flag, socket count, monitoring flag). Returns (app, hub)."""
    from .api.api_rest import create_app
    from .api.ws_hub import Hub, install
    from .host_port import HostPort
    from .runtime import LoopHub
    from .wire import Wire
    s = rt.st.settings
    port = HostPort.from_startup(rt.st, rt.ingest)
    hub = Hub(port, bind_port=s['bind_port'], queue_max=s['ws_send_queue_max'], send_timeout_s=s['ws_send_timeout_s'], auth_timeout_s=s['ws_auth_timeout_s'])
    app = create_app(port, str(rt.st.db_path), s['bind_port']); install(app, hub)
    rt.port = port
    wire = Wire(port, LoopHub(hub, loop), audio_fault=lambda: bool(rt.audio is not None and rt.audio.audio_fault)).attach(); wire.enable_advisory(s['advisory_heartbeat_s'])
    rt.wire, wire.on_change = wire, rt.audio_refresh                           # a new alarm reaches the AudioThread as soon as the engine has decided it
    if rt.audio is not None:
        rt.audio.sockets_fn, rt.audio.monitoring_fn = tab_counter(hub), lambda: bool(port.monitoring_active)     # the zero-socket warning (ADR 0026) is armed only now that the hub exists
    rt.audio_refresh()
    return app, hub

async def tick_driver(rt, period_s=1.0, mono=time.monotonic):
    """Call rt.tick() every period_s in a worker thread. Cancel it to stop."""
    nxt = mono()
    while True:
        await asyncio.to_thread(rt.tick)
        now = mono(); nxt += period_s
        if nxt < now: nxt = now                                                   # overran: no burst of catch-up ticks
        await asyncio.sleep(nxt - now)

async def loop_beat(liveness, period_s=0.25):
    """The 'loop' liveness stamp: a coroutine on the event loop. It stops being stamped when the loop is blocked, which the OS watchdog then notices."""
    while True:
        liveness.stamp('loop'); await asyncio.sleep(period_s)

async def run_server(rt, host, port, app_factory=build_app, make_server=None):
    """Step 10. Returns when Uvicorn has stopped (SIGINT or SIGTERM). Raises ServeError when Uvicorn could not start (for example the port is taken)."""
    loop = asyncio.get_running_loop(); app, _hub = app_factory(rt, loop)
    if make_server is None:
        import uvicorn
        make_server = lambda a: uvicorn.Server(uvicorn.Config(a, host=host, port=port, log_level='warning', lifespan='on'))
    server = make_server(app)
    async def _serve():
        try: await server.serve()
        except SystemExit: raise ServeError('Uvicorn could not start on %s:%s (port in use?)' % (host, port)) from None    # uvicorn exits with sys.exit(1) after a bind failure
    serving = asyncio.ensure_future(_serve())
    while not server.started and not serving.done(): await asyncio.sleep(0.02)
    if serving.done(): await serving; raise ServeError('Uvicorn stopped before it started')
    log.info('step 10: Uvicorn listening on %s:%s, 1 Hz driver started', host, port)
    lv = getattr(rt, 'liveness', None); beat = asyncio.ensure_future(loop_beat(lv)) if lv is not None else None
    driver = asyncio.ensure_future(tick_driver(rt))
    try: await serving
    finally:
        tasks = [driver] + ([beat] if beat is not None else []); [t.cancel() for t in tasks]; await asyncio.gather(*tasks, return_exceptions=True)
        if lv is not None: lv.retire('loop'); lv.retire('tick')                 # shutdown is not a stall
