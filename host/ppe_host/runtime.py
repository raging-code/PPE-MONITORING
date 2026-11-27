"""runtime.py (P24-3c-1): start-up step 8 of design 14.5: the DBWriterThread, the SerialReaderThread with the bounded pre-replay queue, and the SerialWriterThread.
Runtime(st) wires Ingest, DBWriter, SerialReader, SerialWriter, LinkMonitor and Health from a Startup (main.py, steps 1 to 7) and starts the threads in the design's order.
P24-3c-3 adds the AudioThread (Runtime.audio, started in step 8 and fed by Runtime.audio_items()). P24b adds the OSWatchdogThread (Runtime.watchdog, started first in step 8) and the liveness stamps. Not here: step 9 is load_open() (P24-3c-2, ADR 0034); step 10 is serve.py (P24-3c-3: Uvicorn and the 1 Hz driver, which calls Runtime.tick()),
steps 11 to 13 (P25: recovery, then release()). SIMULATOR and REPLAY have no serial port: only the writer and the gate exist there.
Pre-replay queue (design 1, recovery rule a): frames that arrive while recovering wait in a queue of at most pre_replay_queue_max. When it overflows, the oldest frame with node level
NORMAL and no event bit is dropped first and counted (pre_replay_dropped); a frame with a non-NORMAL node level, mandown, mayday, fault or check-in is never dropped, so the queue may
then exceed its bound (pre_replay_overflow counts that). No rule runs and no alert is raised from a queued frame: release() feeds them to Ingest.frame in arrival order, then goes live."""
import logging, threading
from pathlib import Path
from collections import deque
from . import abi
from .clock import RealClock
from .io.audio_watchdog import SOUNDS_DIR, AudioThread
from .io.db_writer import DBWriter
from .io.health import Counters, Health
from .io.os_watchdog import MARKER_NAME, Liveness, OSWatchdogThread
from .io.ingest import Ingest
from .io.serial_reader import SerialReader, open_serial
from .io.serial_writer import LinkMonitor, SerialWriter, host_tick_line

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
    def __init__(self, st, clock=None, open_port=None, audio_backend=None, watchdog_exit=None):
        """audio_backend: the sound card object for the AudioThread (io/audio_watchdog.WinsoundBackend, or a fake). None means no AudioThread, as in the tests that do not care about sound.
        watchdog_exit: the function the OSWatchdogThread calls on a stall (main passes os._exit); None means no watchdog thread, as in most tests. The stamps are always kept."""
        s, self.st, self.clock = st.settings, st, clock or RealClock()
        self.serial = st.mode == 'LIVE'
        self.writer = DBWriter(st.db_path, self.clock)
        roster = [r[0] for r in st.conn.execute('SELECT node_id FROM roster WHERE active = 1 ORDER BY node_id')]
        self.ingest = Ingest.from_settings(s, roster, self.writer, self.clock, st.session_id, event_seq_start=st.event_seq - 1)    # st.event_seq is the next free value
        self.gate = PreReplayGate(self.ingest, s['pre_replay_queue_max'])
        self.link = LinkMonitor(self.ingest.system_event)                         # one SERIAL_LOST or SERIAL_BACK per outage, whichever thread notices first
        port = open_port or (lambda: open_serial(s['serial_port'], write_timeout_s=s['serial_write_timeout_ms'] / 1000.0))
        self.liveness = Liveness(self.clock)
        self.reader = SerialReader(port, self.gate.on_item, self.link.on_link, on_alive=self.liveness.stamper('serial'))
        self.serial_writer = SerialWriter(lambda: None if self.reader.lost else self.reader.port, self.link)
        counters = Counters.for_host(self.ingest, self.writer, self.reader, self.serial_writer,
                                     extra={'pre_replay_dropped': lambda: self.gate.dropped, 'pre_replay_overflow': lambda: self.gate.overflow})
        self.health = self.ingest.health = Health(self.clock, self.ingest.system_event, counters, interval_s=s['counters_interval_s'])
        self.started, self.wire, self.port, self.ticks = False, None, None, 0   # wire and port are set by serve.build_app (step 10)
        self.watchdog = None if watchdog_exit is None else OSWatchdogThread(self.liveness, self.clock, Path(s['log_dir']) / MARKER_NAME, stall_s=s['task_stall_s'], exit_fn=watchdog_exit)
        self.audio = None if audio_backend is None else AudioThread(audio_backend, self.clock, sounds_dir=SOUNDS_DIR, check_interval_s=s['audio_check_interval_s'],
                                                                    chime_interval_min=s['host_chime_interval_min'], on_event=self._audio_event)   # sockets_fn and monitoring_fn come with the hub (serve.build_app)
    def start(self):
        """Step 8, in the design's order: DBWriterThread, SerialReaderThread, SerialWriterThread, then the first host_tick (recovering=1, the Base OLED shows HOST RECOVERING)."""
        if self.watchdog is not None: self.watchdog.start()                        # design 14.5 step 8: the OS watchdog first
        self.writer.start()
        if self.serial: self.reader.start(); self.serial_writer.start()
        if self.audio is not None: self.audio.start(); self.audio_refresh()
        self.started = True; self.offer_tick(); return self
    def offer_tick(self):
        """One host_tick line to the SerialWriter (never blocks). Runtime.tick() calls this at 1 Hz."""
        if self.serial: self.serial_writer.offer(host_tick_line(self.clock.wall_ms(), self.st.recovering, self.st.mode))
    def tick(self):
        """The 1 Hz body (step 10): host_tick to the base first, then Health.tick (BASE_OFFLINE, COUNTERS), then the audio feed (a once-a-second safety net next to Wire.on_change), then Wire.tick (engine tick, held messages, unauth repeats, links, system), and last the 'tick' liveness stamp of the OS watchdog (stamped even when a part failed: it says the timer is alive).
        Wire.tick waits for the commit (commit_wait_ms), so the driver runs this in a worker thread, never on the event loop. Each part is guarded: one failure is logged and the others still run."""
        for name, fn in (('host_tick', self.offer_tick), ('health', self.health.tick), ('audio', self.audio_refresh), ('wire', lambda: self.wire.tick() if self.wire is not None else None), ('stamp', lambda: self.liveness.stamp('tick'))):
            try: fn()
            except Exception: log.exception('1 Hz tick: %s failed', name)
        self.ticks += 1
    def audio_items(self):
        """What the host may sound now, for AudioThread.set_items(): every open alert of the engine state (type, level, acknowledged) plus the banners that have a host sound:
        BASE OFFLINE (the Health flag; it cannot be acknowledged), LOGGING FAULT and HOST GAP (acknowledgeable). Not here yet: RECOVERING (P25 ends it, so it is added there), HOST BATTERY (P24b).
        Reads only immutable engine state and flags, so any thread may call it."""
        items = [dict(alert_type=a.type, level=a.level, acknowledged=a.acknowledged_ts is not None) for a in list(self.ingest.st.alerts.values())]
        if getattr(self.health, 'offline', False): items.append(dict(alert_type='base_offline', level='DANGER', acknowledged=False))
        if self.port is not None:
            for kind, level in (('logging_fault', 'WARNING'), ('host_gap', 'NONE')):
                on, ack = self.port.banner_state(kind)
                if on: items.append(dict(alert_type=kind, level=level, acknowledged=ack is not None))
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
    def release(self):
        """Step 13 (P25 calls this after RECOVERING_EXIT)."""
        return self.gate.release()
    def stop(self):
        if self.watchdog is not None: self.watchdog.stop()                          # first: a clean shutdown (draining the writer takes seconds) must never look like a stall
        if self.audio is not None and self.audio.is_alive(): self.audio.stop(); self.audio.join(2)
        if self.serial: self.reader.stop(); self.serial_writer.stop()
        self.writer.stop(drain=True)
