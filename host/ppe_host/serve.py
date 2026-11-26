"""serve.py (P24-3c-3): start-up step 10 of design 14.5: Uvicorn with the REST app and the WebSocket hub, then the 1 Hz driver of Runtime.tick().
build_app wires HostPort, Hub and Wire to the Runtime (Wire gets the Hub through LoopHub, because frames arrive on the SerialReader thread). run_server starts Uvicorn, waits until it
accepts connections, and only then starts the driver, so the first tick never runs before the API is up. The driver keeps a fixed 1 s grid: a slow tick does not shift the next one, and a
tick that overran is not made up by a burst. It stops first on shutdown, then Uvicorn closes the sockets. Not here: the OS watchdog liveness stamp (Hub.on_tick, P24b) and the AudioThread."""
import asyncio, logging, time

log = logging.getLogger('ppe.serve')

class ServeError(RuntimeError):
    """Uvicorn could not start (the port is taken or cannot be bound). main.py exits with code 2 for it: retrying at once cannot help, so it counts toward the crash-loop guard."""

def build_app(rt, loop):
    """The FastAPI app of a started Runtime. Sets rt.port and rt.wire and turns the Tier 1 advisory on (advisory_heartbeat_s). Returns (app, hub)."""
    from .api.api_rest import create_app
    from .api.ws_hub import Hub, install
    from .host_port import HostPort
    from .runtime import LoopHub
    from .wire import Wire
    s = rt.st.settings
    port = HostPort.from_startup(rt.st, rt.ingest)
    hub = Hub(port, bind_port=s['bind_port'], queue_max=s['ws_send_queue_max'], send_timeout_s=s['ws_send_timeout_s'], auth_timeout_s=s['ws_auth_timeout_s'])
    app = create_app(port, str(rt.st.db_path), s['bind_port']); install(app, hub)
    wire = Wire(port, LoopHub(hub, loop)).attach(); wire.enable_advisory(s['advisory_heartbeat_s'])
    rt.port, rt.wire = port, wire
    return app, hub

async def tick_driver(rt, period_s=1.0, mono=time.monotonic):
    """Call rt.tick() every period_s in a worker thread. Cancel it to stop."""
    nxt = mono()
    while True:
        await asyncio.to_thread(rt.tick)
        now = mono(); nxt += period_s
        if nxt < now: nxt = now                                                   # overran: no burst of catch-up ticks
        await asyncio.sleep(nxt - now)

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
    driver = asyncio.ensure_future(tick_driver(rt))
    try: await serving
    finally:
        driver.cancel(); await asyncio.gather(driver, return_exceptions=True)
