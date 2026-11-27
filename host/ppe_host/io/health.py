"""io/health.py (P12b): host health for the 1 Hz tick: BASE_OFFLINE and BASE_BACK (design 1 and Section 5: no base heartbeat for base_offline_s = 5 s) and the periodic COUNTERS row
(counters_interval_s). A parsed heartbeat or frame line from the base counts as a sign of life (beacons are sent by the base, so the host never sees one). The base is
treated as seen at start-up, so a base that never speaks is offline 5 s after the host starts. Call tick() once per second from the event loop; seen() is called by Ingest.on_item.
emit(kind, detail) is Ingest.system_event.
P24b adds HostHealth: QUEUE_OVERFLOW, HOST_BATTERY and DISK_LOW, and the host_power string for the snapshot banner."""
import json, shutil, threading
from .. import constants as K

class Counters:
    """Named counters read from their owners when a COUNTERS row is made. `restored` holds totals read from the latest COUNTERS row at start-up (recovery, P24): they are added to the live values."""
    def __init__(self, sources, restored=None): self.sources, self.restored = dict(sources), dict(restored or {})
    @classmethod
    def for_host(cls, ingest, writer, reader=None, serial_writer=None, restored=None, extra=None):
        s = {'rejected_frames': lambda: ingest.counters['rejected_frames'], 'bad_frames_not_stored': lambda: ingest.counters['bad_frames_not_stored'],
             'mac_disagree': lambda: ingest.counters['mac_disagree'], 'write_rejected': lambda: writer.counters['write_rejected'],
             'retry_buffer_dropped': lambda: writer.counters['retry_buffer_dropped'], 'queue_overflow': lambda: writer.counters['queue_overflow'],
             'pre_replay_dropped': lambda: 0}                                     # P24's recovery buffer replaces this source
        if reader is not None: s.update(serial_framing_errors=lambda: reader.counters['serial_framing_errors'], serial_bad_lines=lambda: reader.counters['serial_bad_lines'])
        if serial_writer is not None: s['serial_ticks_dropped'] = lambda: serial_writer.counters['ticks_dropped']
        s.update(extra or {}); return cls(s, restored)
    def snapshot(self): return {k: self.restored.get(k, 0) + int(f()) for k, f in self.sources.items()}
    def detail(self): return json.dumps(self.snapshot(), sort_keys=True, separators=(',', ':'))

class Health:
    def __init__(self, clock, emit, counters, offline_s=K.BASE_OFFLINE_S, interval_s=60):
        self.clock, self.emit, self.counters, self.offline_s, self.interval_s = clock, emit, counters, offline_s, interval_s
        self.last_seen = self.last_counters = clock.mono_ms(); self.offline = False; self._lock = threading.Lock()
    def seen(self):
        with self._lock:
            self.last_seen = self.clock.mono_ms()
            if self.offline: self.offline = False; self.emit('BASE_BACK', None)
    def tick(self):
        with self._lock:
            m = self.clock.mono_ms()
            if not self.offline and m - self.last_seen >= self.offline_s * 1000:
                self.offline = True; self.emit('BASE_OFFLINE', 'no base heartbeat for %d s' % self.offline_s)
            if m - self.last_counters >= self.interval_s * 1000:
                self.last_counters = m; self.emit('COUNTERS', self.counters.detail())


def disk_free_gb(path):
    """Free space in GB on the disk that holds `path` (stdlib). None if it cannot be read."""
    try: return shutil.disk_usage(path).free / 1e9
    except OSError: return None

def default_battery():
    """(on_battery, percent) of the laptop. The standard library cannot read a battery, so this uses psutil if it is installed; without it, or on a machine with no battery, the answer is (False, None): unknown is never reported as 'on battery'."""
    try:
        import psutil
        b = psutil.sensors_battery()
        return (False, None) if b is None else (b.power_plugged is False, None if b.percent is None else int(b.percent))
    except Exception: return False, None

def host_power_str(on_battery, pct, warn_pct):
    """The string Wire sends as host_power (the dashboard's parseHostPower): 'ac' on mains; 'battery' on battery (notice banner, no sound); 'battery N%' only at or below warn_pct (warning banner, beep), because the dashboard shows the warning whenever a number is present."""
    if not on_battery: return 'ac'
    return 'battery %d%%' % pct if pct is not None and pct <= warn_pct else 'battery'

class HostHealth:
    """P24b host checks, called once a second from Runtime.tick. QUEUE_OVERFLOW: when the writer's queue_overflow counter has grown, one event per overflow_log_s (the event itself goes through the same queue). Once a minute (check_interval_s) the battery and the free disk are read:
    HOST_BATTERY is logged when the laptop goes on battery and again when it falls to warn_pct or below; DISK_LOW when free space falls below disk_min_gb. Each is logged once at onset and again only after the condition has cleared (the schema has no 'back' kind; the banner just stops). Readers are injectable (None means the real ones, looked up at call time); a reader that raises is treated as unknown."""
    def __init__(self, clock, emit, writer, disk_path, read_battery=None, read_disk_gb=None, warn_pct=30, disk_min_gb=1.0, check_interval_s=60, overflow_log_s=60):
        self.clock, self.emit, self.writer, self.disk_path = clock, emit, writer, disk_path
        self._read_battery, self._read_disk_gb, self.warn_pct, self.disk_min_gb = read_battery, read_disk_gb, warn_pct, disk_min_gb
        self.check_ms, self.overflow_ms = check_interval_s * 1000, overflow_log_s * 1000
        self.on_battery, self.pct, self.disk_gb = False, None, None
        self._bat_level, self._disk_low = 0, False                              # _bat_level: 0 mains, 1 on battery, 2 at or below warn_pct
        self._last_check = None; self._seen_overflow = 0; self._last_overflow_log = None
    def tick(self):
        self._overflow(); m = self.clock.mono_ms()
        if self._last_check is None or m - self._last_check >= self.check_ms: self._last_check = m; self.check()
    def _overflow(self):
        n = self.writer.counters['queue_overflow']
        if n <= self._seen_overflow: return
        m = self.clock.mono_ms()
        if self._last_overflow_log is not None and m - self._last_overflow_log < self.overflow_ms: return    # counted, logged at the next allowed time
        self.emit('QUEUE_OVERFLOW', '%d unit(s) over the writer queue limit since the last report (total %d)' % (n - self._seen_overflow, n))
        self._seen_overflow, self._last_overflow_log = n, m
    def check(self):
        """Read the battery and the disk now (also called by tests)."""
        try: self.on_battery, self.pct = (self._read_battery or default_battery)()
        except Exception: self.on_battery, self.pct = False, None
        level = 0 if not self.on_battery else 2 if self.pct is not None and self.pct <= self.warn_pct else 1
        if level > self._bat_level: self.emit('HOST_BATTERY', 'on battery' + ('' if self.pct is None else ' %d%%' % self.pct) + ('' if level == 1 else ' (at or below %d%%)' % self.warn_pct))
        self._bat_level = level
        try: self.disk_gb = (self._read_disk_gb or disk_free_gb)(self.disk_path)
        except Exception: self.disk_gb = None
        low = self.disk_gb is not None and self.disk_gb < self.disk_min_gb
        if low and not self._disk_low: self.emit('DISK_LOW', 'free %.2f GB, minimum %.2f GB' % (self.disk_gb, self.disk_min_gb))
        self._disk_low = low
    def host_power(self): return host_power_str(self.on_battery, self.pct, self.warn_pct)
    def audio_level(self):
        """None on mains; 'NONE' on battery (no sound); 'WARNING' at or below warn_pct (the beep, rank 5)."""
        return None if self._bat_level == 0 else 'WARNING' if self._bat_level == 2 else 'NONE'
