"""runtime.py (P24-3c-1): start-up step 8 of design 14.5: the DBWriterThread, the SerialReaderThread with the bounded pre-replay queue, and the SerialWriterThread.
Runtime(st) wires Ingest, DBWriter, SerialReader, SerialWriter, LinkMonitor and Health from a Startup (main.py, steps 1 to 7) and starts the threads in the design's order.
P24-3c-3 adds the AudioThread (Runtime.audio, started in step 8 and fed by Runtime.audio_items()). P24b adds the OSWatchdogThread (Runtime.watchdog, started first in step 8) and the liveness stamps. Not here: step 9 is load_open() (P24-3c-2, ADR 0034); step 10 is serve.py (P24-3c-3: Uvicorn and the 1 Hz driver, which calls Runtime.tick()),
steps 11 to 13 (P25: services/recovery.py and services/recovery_run.py through Runtime.recover(), then release()). SIMULATOR and REPLAY have no serial writer and nothing from the port is ingested there; S7-2 (ADR 0058) adds the read-only drain (Runtime(drain=True)).
S7-1 (ADR 0057): in SIMULATOR mode Runtime(st, simulator=(scenario, seed)) adds the SimulatorThread (services/simulator.py), which feeds Runtime.gate.on_item as the SerialReader does, so simulated frames wait for RECOVERING_EXIT like live ones.
Pre-replay queue (design 1, recovery rule a): frames that arrive while recovering wait in a queue of at most pre_replay_queue_max. When it overflows, the oldest frame with node level
NORMAL and no event bit is dropped first and counted (pre_replay_dropped); a frame with a non-NORMAL node level, mandown, mayday, fault or check-in is never dropped, so the queue may
then exceed its bound (pre_replay_overflow counts that). No rule runs and no alert is raised from a queued frame: release() feeds them to Ingest.frame in arrival order, then goes live."""
import json, logging, threading
from collections import deque
from . import abi
from .clock import RealClock, ScaledClock
from .io.audio_watchdog import SOUNDS_DIR, AudioThread
from .io.db_writer import DBWriter
from .io.health import Counters, Health, HostHealth
from .io.os_watchdog import MARKER_NAME, Liveness, OSWatchdogThread
from .io.ingest import Ingest
from .io.serial_reader import SerialReader, open_serial
from .io.serial_writer import LinkMonitor, SerialWriter, host_tick_line
from .services.replay import ReplayThread
from .services.serial_drain import LiveTrafficDetector
from .services.simulator import SimulatorThread

log = logging.getLogger('ppe.runtime')

def _mask(field, *names): return sum(((1 << abi.BITS[field][n][1]) - 1) << abi.BITS[field][n][0] for n in names)
FLAG_EVENT_MASK = _mask('flags', 'node_level', 'mandown', 'fault', 'checkin')      # any of these set: the frame is never dropped
STATUS4_EVENT_MASK = _mask('status4', 'mayday')

def protected(raw):
    """True if a queued frame must never be dropped. Frames that are not 23 bytes are diagnostics only (BAD_LEN): they carry no event and can be dropped first."""
    return len(raw) == 23 and bool(raw[11] & FLAG_EVENT_MASK or raw[16] & STATUS4_EVENT_MASK)

class PreReplayGate:
    """The SerialReader callback. Heartbeats always go straight to Ingest. Frames go to the queue until release() has emptied it; a live frame never overtakes a queued one."""
    def __init__(self, ingest, max_frames):
        self.ingest, self.max, self.live = ingest, max_frames, False
        self.dropped = self.overflow = 0
        self._q, self._lock = deque(), threading.Lock()
    def on_item(self, kind, payload):
        if kind == 'frame':
            with self._lock:
                queued = not self.live or bool(self._q)
                if queued: self._add(payload)
            if queued:
                if self.ingest.health is not None: self.ingest.health.seen()       # a queued frame is still a sign of life from the base
                return
        self.ingest.on_item(kind, payload)
    def _add(self, frame):
        self._q.append(frame)
        if len(self._q) > self.max:
            victim = next((f for f in self._q if not protected(f.raw)), None)      # the oldest droppable frame
            if victim is None: self.overflow += 1
            else: self._q.remove(victim); self.dropped += 1
    def depth(self):
        with self._lock: return len(self._q)
    def release(self):
        """Step 13: feed the queue in arrival order through the normal pipeline, then accept live frames directly. Returns the number of frames fed. live is set only when the queue is
        empty and the last frame has been processed, so frames that arrive meanwhile queue behind it."""
        n = 0
        while True:
            with self._lock:
                if not self._q: self.live = True; return n
                f = self._q.popleft()
            try: self.ingest.frame(f)
            except Exception: log.exception('queued frame failed')                 # one bad frame must not strand the rest
            n += 1

class LoopHub:
    """Thread bridge between Wire and the Hub (P24-3c-3). The Hub and its asyncio queues belong to the event loop, but Wire.on_frame runs on the SerialReader thread and Wire.tick on a worker
    thread. Every publish_*(body) is handed to the loop with call_soon_threadsafe, in call order; anything else is passed through. After the loop has closed (shutdown) a publish is dropped."""
    def __init__(self, hub, loop): self._hub, self._loop = hub, loop
    def __getattr__(self, name):
        fn = getattr(self._hub, name)                                              # a missing method raises AttributeError, which Wire._pub relies on
        if not name.startswith('publish_'): return fn
        def call(body):
            try: self._loop.call_soon_threadsafe(fn, body)
            except RuntimeError: pass                                              # the loop is closed
        return call

class Runtime:
    def __init__(self, st, clock=None, open_port=None, audio_backend=None, watchdog_exit=None, simulator=None, drain=False, replay=None):
        """audio_backend: the sound card object for the AudioThread (io/audio_watchdog.WinsoundBackend, or a fake). None means no AudioThread, as in the tests that do not care about sound.
        watchdog_exit: the function the OSWatchdogThread calls on a stall (main passes os._exit); None means no watchdog thread, as in most tests. The stamps are always kept.
        simulator: (scenario, seed) for the SimulatorThread (S7-1), or None for no simulated traffic. Only a SIMULATOR host may have one; any other mode raises ValueError before anything is built.
        drain: S7-2 (ADR 0058): True in SIMULATOR and REPLAY (main passes it) starts the SerialDrainThread, which reads the base's port only to write LIVE_FRAME_IN_TEST_MODE when valid live frames arrive. LIVE raises ValueError. Default False, so a test that does not care opens no port.
        replay: S7-3 (ADR 0059): (session_id, speed) of the session of db_path to replay, or None. Only a REPLAY host may have one (ValueError otherwise, before anything is built). Every host timer then reads a ScaledClock
        (speed 1, 4 or 16, pausable); the OS watchdog and its liveness stamps keep the real clock. The ReplayThread feeds Runtime.gate.on_item like the SerialReader and starts its time when the gate goes live."""
        if simulator is not None and st.mode != 'SIMULATOR': raise ValueError('a simulator needs mode SIMULATOR, this host runs %s' % st.mode)
        if replay is not None and st.mode != 'REPLAY': raise ValueError('a replay needs mode REPLAY, this host runs %s' % st.mode)
        if drain and st.mode == 'LIVE': raise ValueError('the serial drain is for SIMULATOR and REPLAY; LIVE reads the port for real')
        s, self.st = st.settings, st; self.real_clock = clock or RealClock()                     # real_clock: the OS watchdog and the liveness stamps (S7-3)
        self.clock = self.real_clock if replay is None else ScaledClock(self.real_clock, replay[1])     # every other timer of the host
        self.serial = st.mode == 'LIVE'
        self.writer = DBWriter(st.db_path, self.clock, on_logging_fault=lambda table, msg: self.ingest.system_event('LOGGING_FAULT', json.dumps({'table': table, 'error': msg}, sort_keys=True, separators=(',', ':'))))   # the lambda reads self.ingest only when a fault happens, after __init__
        roster = [r[0] for r in st.conn.execute('SELECT node_id FROM roster WHERE active = 1 ORDER BY node_id')]
        self.ingest = Ingest.from_settings(s, roster, self.writer, self.clock, st.session_id, event_seq_start=st.event_seq - 1)    # st.event_seq is the next free value
        self.gate = PreReplayGate(self.ingest, s['pre_replay_queue_max'])
        self.link = LinkMonitor(self.ingest.system_event)                         # one SERIAL_LOST or SERIAL_BACK per outage, whichever thread notices first
        port = open_port or (lambda: open_serial(s['serial_port'], write_timeout_s=s['serial_write_timeout_ms'] / 1000.0))
        self.liveness = Liveness(self.real_clock)
        self.reader = SerialReader(port, self.gate.on_item, self.link.on_link, on_alive=self.liveness.stamper('serial'))
        self.serial_writer = SerialWriter(lambda: None if self.reader.lost else self.reader.port, self.link)
        self.sim = None if simulator is None else SimulatorThread(self.clock, self.gate.on_item, s.cmac_key(), s['sys_id'], simulator[0], simulator[1], base_id=s['base_id'], on_alive=self.liveness.stamper('serial'))   # the same stamp the SerialReader gives the OS watchdog
        self.detector = self.drain = None
        if drain:       # nothing from the drain reaches the gate, Ingest or the writer except the one system_event row; it never writes to the port and its link events are only logged
            self.detector = LiveTrafficDetector(self.clock, self.ingest.system_event, s.cmac_key(), s['sys_id'])
            self.drain = SerialReader(port, self.detector.on_item, lambda e, d: log.warning('serial drain: %s %s', e, d or ''), on_alive=self.liveness.stamper('drain'), name='SerialDrainThread')
        self.replay = None if replay is None else ReplayThread(self.clock, self.gate.on_item, st.settings.path('db_path'), replay[0], base_id=s['base_id'], ready=lambda: self.gate.live, on_alive=self.liveness.stamper('replay'), on_done=lambda: self.liveness.retire('replay'))
        counters = Counters.for_host(self.ingest, self.writer, self.reader, self.serial_writer,
                                     extra={'pre_replay_dropped': lambda: self.gate.dropped, 'pre_replay_overflow': lambda: self.gate.overflow})
        self.health = self.ingest.health = Health(self.clock, self.ingest.system_event, counters, interval_s=s['counters_interval_s'])
        self.host_health = HostHealth(self.clock, self.ingest.system_event, self.writer, st.db_path.parent, warn_pct=s['host_bat_warn_pct'], disk_min_gb=s['host_disk_min_gb'])
        self.started, self.wire, self.port, self.ticks = False, None, None, 0   # wire and port are set by serve.build_app (step 10)
        self.recovery_report, self._recovery_started = None, False             # P25-2: the RunReport of services/recovery_run.run, and a guard so steps 11 to 13 run once
        self.watchdog = None if watchdog_exit is None else OSWatchdogThread(self.liveness, self.real_clock, s.path('log_dir') / MARKER_NAME, stall_s=s['task_stall_s'], exit_fn=watchdog_exit)
        self.audio = None if audio_backend is None else AudioThread(audio_backend, self.clock, sounds_dir=SOUNDS_DIR, check_interval_s=s['audio_check_interval_s'],
                                                                    chime_interval_min=s['host_chime_interval_min'], on_event=self._audio_event)   # sockets_fn and monitoring_fn come with the hub (serve.build_app)
    def start(self):
        """Step 8, in the design's order: DBWriterThread, SerialReaderThread, SerialWriterThread, then the first host_tick (recovering=1, the Base OLED shows HOST RECOVERING)."""
        if self.watchdog is not None: self.watchdog.start()                        # design 14.5 step 8: the OS watchdog first
        self.writer.start()
        if self.serial: self.reader.start(); self.serial_writer.start()
        if self.drain is not None: self.drain.start()                              # S7-2: after the writer, so the row of a live frame has a queue to go to
        if self.replay is not None: self.replay.start()                            # its time 0 is the moment the gate goes live (RECOVERING_EXIT)
        if self.sim is not None: self.sim.start()                                  # after the writer: its first frame is queued behind the gate until RECOVERING_EXIT
        if self.audio is not None: self.audio.start(); self.audio_refresh()
        self.started = True; self.offer_tick(); return self
    def offer_tick(self):
        """One host_tick line to the SerialWriter (never blocks). Runtime.tick() calls this at 1 Hz."""
        if self.serial: self.serial_writer.offer(host_tick_line(self.clock.wall_ms(), self.st.recovering, self.st.mode))
    def tick(self):
        """The 1 Hz body (step 10): host_tick to the base first, then Health.tick (BASE_OFFLINE, COUNTERS), then the audio feed (a once-a-second safety net next to Wire.on_change), then Wire.tick (engine tick, held messages, unauth repeats, links, system), and last the 'tick' liveness stamp of the OS watchdog (stamped even when a part failed: it says the timer is alive).
        Wire.tick waits for the commit (commit_wait_ms), so the driver runs this in a worker thread, never on the event loop. Each part is guarded: one failure is logged and the others still run."""
        for name, fn in (('host_tick', self.offer_tick), ('health', self.health.tick), ('host_health', self.host_health.tick), ('audio', self.audio_refresh), ('wire', lambda: self.wire.tick() if self.wire is not None else None), ('stamp', lambda: self.liveness.stamp('tick'))):
            try: fn()
            except Exception: log.exception('1 Hz tick: %s failed', name)
        self.ticks += 1
    def audio_items(self):
        """What the host may sound now, for AudioThread.set_items(): every open alert of the engine state (type, level, acknowledged) plus the banners that have a host sound:
        BASE OFFLINE (the Health flag; it cannot be acknowledged), LOGGING FAULT and HOST GAP (acknowledgeable). HOST BATTERY ('host_power': beep at or below host_bat_warn_pct, silent while only on battery).
        RECOVERING (P25-2): one beep while st.recovering is true; it cannot be acknowledged and ends with RECOVERING_EXIT.
        Reads only immutable engine state and flags, so any thread may call it."""
        items = [dict(alert_type=a.type, level=a.level, acknowledged=a.acknowledged_ts is not None) for a in list(self.ingest.st.alerts.values())]
        if getattr(self.health, 'offline', False): items.append(dict(alert_type='base_offline', level='DANGER', acknowledged=False))
        if self.port is not None:
            for kind, level in (('logging_fault', 'WARNING'), ('host_gap', 'NONE')):
                on, ack = self.port.banner_state(kind)
                if on: items.append(dict(alert_type=kind, level=level, acknowledged=ack is not None))
        if self.st.recovering: items.append(dict(alert_type='recovering', level='NONE', acknowledged=False))       # catalog: recovering, one_beep at level NONE
        lvl = self.host_health.audio_level()
        if lvl is not None: items.append(dict(alert_type='host_power', level=lvl, acknowledged=False))      # not acknowledgeable: it ends when the laptop is plugged in
        return items
    def audio_refresh(self):
        if self.audio is not None: self.audio.set_items(self.audio_items())
    def _audio_event(self, kind, detail): self.ingest.system_event(kind, detail)    # AUDIO_FAULT once per fault, AUDIO_OK once when the last cause clears (the Wire turns the flag into the banner)
    def load_open(self):
        """Step 9 (P24-3c-2): open alerts and open episodes into the engine state by indexed SQL (Ingest.load_open on the start-up connection), before Uvicorn starts, so the first snapshot
        and the first frame agree. Safe to call again: the existing state wins. Returns the OpenReport."""
        rep = self.ingest.load_open(self.st.conn)
        self.audio_refresh()                                                       # a restored open alert sounds from the first moment
        log.info('step 9: %d open alert(s) and %d open episode(s) loaded, %d row(s) skipped', rep.alerts, rep.episodes, len(rep.skipped))
        return rep
    async def recover(self):
        """Steps 11 to 13 (P25-2, services/recovery_run.py): the chunked rebuild on the event loop, then RECOVERING_EXIT and HOST_GAP, then release(). serve.run_server starts this as a task after the 1 Hz driver.
        Runs once: a second call (or a Runtime that never entered RECOVERING) returns the report of the first, or None. Returns the RunReport."""
        if self._recovery_started or not self.st.recovering: return self.recovery_report
        self._recovery_started = True
        from .services import recovery_run
        self.recovery_report = await recovery_run.run(self); return self.recovery_report
    def release(self):
        """Step 13 (recovery_run.run calls this in a worker thread after RECOVERING_EXIT)."""
        return self.gate.release()
    def stop(self, clean=False):
        """clean=True (P25-3, only main() after a server that stopped by itself): close_session('CLEAN_SHUTDOWN') is queued after the last live row and drained with the writer.
        A stop that is not clean leaves the session open, so the next start resumes it (design 2.3)."""
        if self.watchdog is not None: self.watchdog.stop()                          # first: a clean shutdown (draining the writer takes seconds) must never look like a stall
        if self.audio is not None and self.audio.is_alive(): self.audio.stop(); self.audio.join(2)
        if self.serial: self.reader.stop(); self.serial_writer.stop()
        if self.drain is not None: self.drain.stop()                                # before CLEAN_SHUTDOWN and the writer, like the simulator
        if self.replay is not None: self.replay.stop()                              # before CLEAN_SHUTDOWN and the writer, like the simulator
        if self.sim is not None: self.sim.stop()                                   # before CLEAN_SHUTDOWN and the writer: no simulated frame may be queued after the last row
        if clean:
            try: self.ingest.close_session('CLEAN_SHUTDOWN')
            except Exception: log.exception('CLEAN_SHUTDOWN could not be queued')
        self.writer.stop(drain=True)
