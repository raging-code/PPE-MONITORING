"""io/health.py (P12b): host health for the 1 Hz tick: BASE_OFFLINE and BASE_BACK (design 1 and Section 5: no base heartbeat for base_offline_s = 5 s) and the periodic COUNTERS row
(counters_interval_s). A parsed heartbeat or frame line from the base counts as a sign of life (beacons are sent by the base, so the host never sees one). The base is
treated as seen at start-up, so a base that never speaks is offline 5 s after the host starts. Call tick() once per second from the event loop; seen() is called by Ingest.on_item.
emit(kind, detail) is Ingest.system_event."""
import json, threading
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
