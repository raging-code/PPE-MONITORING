"""io/os_watchdog.py (P24b, ADR 0036): the OSWatchdogThread of design 14.5 and section 1 (stall, watchdog and deduplication timing).
An asyncio coroutine cannot fire while the event loop is blocked, so a dedicated daemon thread checks monotonic liveness stamps every 250 ms. The parts that stamp are the serial reader
thread ('serial'), the asyncio loop ('loop') and the 1 Hz tick ('tick'). A part is judged only after its first stamp, so a part that is not running (no serial port in SIMULATOR,
no server yet during start-up) never counts as stalled. If any stamp is older than task_stall_s (3 s), the thread writes a crash marker file and calls os._exit(1), so the user-session
supervisor restarts the host within 5 s. The marker is written first and atomically (temporary file, fsync, rename); a failure to write it never prevents the exit.
The next start reads the marker (consume_marker) and logs LIVENESS_RESTART (and TICK_STALL when the 1 Hz tick was among the stale parts). The clock, the exit function and the wait are injected, so every rule runs under a FakeClock."""
import json, os, threading
from pathlib import Path

MARKER_NAME, LAST_MARKER_NAME = 'crash_marker.json', 'crash_marker.last.json'
CHECK_S = 0.25           # design: "every 250 ms"
EXIT_CODE = 1            # design: os._exit(1), non-zero so the supervisor respawns

class Liveness:
    """Monotonic liveness stamps by name. stamp() is called from any thread; ages() returns {name: ms since its last stamp}. retire() removes a part that ended on purpose."""
    def __init__(self, clock): self.clock, self._t, self._lock = clock, {}, threading.Lock()
    def stamp(self, name):
        now = self.clock.mono_ms()
        with self._lock: self._t[name] = now
    def stamper(self, name): return lambda: self.stamp(name)
    def retire(self, name):
        with self._lock: self._t.pop(name, None)
    def ages(self):
        now = self.clock.mono_ms()
        with self._lock: return {n: now - t for n, t in self._t.items()}

def write_marker(path, body):
    """Atomic write of the crash marker (JSON). Returns True when it is on disk; never raises, because the exit must follow whatever happens here."""
    try:
        p = Path(path); p.parent.mkdir(parents=True, exist_ok=True); tmp = p.with_name(p.name + '.tmp')
        with open(tmp, 'w', encoding='utf-8') as f: json.dump(body, f, sort_keys=True); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, p); return True
    except Exception: return False

def consume_marker(log_dir):
    """Called at the next start. Returns the marker as a dict (or {'kind': 'unreadable'} for a damaged file) and moves it to crash_marker.last.json, where the supervisor's error window
    can still read it. Returns None when there is no marker. Never raises."""
    d = Path(log_dir); p = d / MARKER_NAME
    try:
        if not p.exists(): return None
    except OSError: return None
    try: body = json.loads(p.read_text(encoding='utf-8')); body = body if isinstance(body, dict) else {'kind': 'unreadable'}
    except (OSError, ValueError): body = {'kind': 'unreadable'}
    try: os.replace(p, d / LAST_MARKER_NAME)
    except OSError: pass
    return body

class OSWatchdogThread(threading.Thread):
    """check() holds all the logic and is called by run() every check_s; tests call it directly with a FakeClock. exit_fn defaults to os._exit."""
    def __init__(self, liveness, clock, marker_path, stall_s=3, exit_fn=os._exit, check_s=CHECK_S, wall_ms=None):
        super().__init__(name='OSWatchdogThread', daemon=True)
        self.liveness, self.clock, self.marker_path, self.exit_fn, self.check_s = liveness, clock, marker_path, exit_fn, check_s
        self.limit_ms, self.wall_ms = int(stall_s * 1000), wall_ms or clock.wall_ms
        self._halt = threading.Event(); self.fired, self.marker_ok, self.errors, self.checks = None, None, 0, 0
    def check(self):
        """One pass. Returns None when every stamp is fresh; otherwise writes the marker, calls exit_fn(1) and returns the marker body (exit_fn does not return in production)."""
        self.checks += 1; ages = self.liveness.ages(); stale = {n: a for n, a in ages.items() if a > self.limit_ms}
        if not stale: return None
        worst = max(stale, key=stale.get)
        body = dict(v=1, kind='stall', ts=self.wall_ms(), pid=os.getpid(), limit_ms=self.limit_ms, stalled=worst, age_ms=stale[worst], stale=stale, ages=ages)
        self.fired = body; self.marker_ok = write_marker(self.marker_path, body); self.exit_fn(EXIT_CODE); return body
    def run(self):
        while not self._halt.is_set():
            try:
                if self.check() is not None: return                 # exit_fn returned (tests): do not fire again
            except Exception: self.errors += 1                      # one bad pass never ends the watchdog
            self._halt.wait(self.check_s)
    def stop(self): self._halt.set()
