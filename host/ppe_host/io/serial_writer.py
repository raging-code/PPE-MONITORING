"""io/serial_writer.py (P12b): the host-to-base side of the serial port (design 1, Host-to-Base host_tick, Rev 3.21).
host_tick_line builds the frozen 1 Hz line. SerialWriter owns a one-slot queue and a dedicated SerialWriterThread: the event loop calls offer() (never blocks, a newer
tick replaces an unsent one) and only the thread touches the port, with the write timeout the port was opened with (serial_write_timeout_ms). A failed or timed-out write drops
that tick without retrying it. LinkMonitor is the one place that decides when SERIAL_LOST and SERIAL_BACK are logged, so the reader and the writer share one outage:
no second row for an outage the other side already logged. The writer thread is not in the watchdog liveness set."""
import json, threading
from .. import constants as K

SESSION_MODES = ('LIVE', 'SIMULATOR', 'REPLAY')

def host_tick_line(srv_ts, recovering, session_mode):
    """{"v":1,"type":"host_tick","srv_ts":...,"recovering":0|1,"session_mode":"LIVE"} + LF, key order as in the frozen example."""
    if session_mode not in SESSION_MODES: raise ValueError('unknown session_mode: %r' % (session_mode,))
    if isinstance(srv_ts, bool) or not isinstance(srv_ts, int) or srv_ts < 0: raise ValueError('srv_ts must be a non-negative int (UTC ms)')
    return (json.dumps({'v': 1, 'type': 'host_tick', 'srv_ts': srv_ts, 'recovering': 1 if recovering else 0, 'session_mode': session_mode}, separators=(',', ':')) + '\n').encode()

class LinkMonitor:
    """emit(kind, detail) is called with 'SERIAL_LOST' once per outage and 'SERIAL_BACK' when it ends, whichever side (reader or writer) noticed first.
    Use on_link as the SerialReader callback; the writer calls writer_lost / writer_ok."""
    def __init__(self, emit): self.emit, self.lost, self._lock = emit, False, threading.Lock()
    def on_link(self, event, detail=None):
        with self._lock:
            if event == 'SERIAL_LOST' and not self.lost: self.lost = True; self.emit(event, detail)
            elif event == 'SERIAL_BACK' and self.lost: self.lost = False; self.emit(event, detail)
    def writer_lost(self, detail='write'): self.on_link('SERIAL_LOST', detail)
    def writer_ok(self): self.on_link('SERIAL_BACK', None)

class SerialWriter:
    """get_port() returns the port the reader currently holds (None while it is lost: the tick is dropped and nothing extra is logged, the reader owns that outage)."""
    def __init__(self, get_port, link):
        self.get_port, self.link, self.last_error = get_port, link, None
        self.counters = {'ticks_offered': 0, 'ticks_written': 0, 'ticks_dropped': 0, 'ticks_replaced': 0}
        self._cv, self._slot, self._stop = threading.Condition(), None, False
        self._thread = threading.Thread(target=self._run, name='SerialWriterThread', daemon=True)
    def start(self): self._thread.start(); return self
    def offer(self, line):
        """Called by the 1 Hz timer on the event loop. Returns at once whatever the port is doing."""
        with self._cv:
            if self._slot is not None: self.counters['ticks_replaced'] += 1; self.counters['ticks_dropped'] += 1
            self._slot = line; self.counters['ticks_offered'] += 1; self._cv.notify()
    def stop(self, timeout_s=2):
        with self._cv: self._stop = True; self._cv.notify_all()
        self._thread.join(timeout_s)
    def _run(self):
        while True:
            with self._cv:
                while self._slot is None and not self._stop: self._cv.wait()
                if self._slot is None: return
                line, self._slot = self._slot, None
            port = self.get_port()
            if port is None: self.counters['ticks_dropped'] += 1; continue
            try: port.write(line)
            except Exception as e:                                          # timeout, unplugged or any port error: drop this tick, never retry it
                self.counters['ticks_dropped'] += 1; self.last_error = repr(e); self.link.writer_lost('write'); continue
            self.counters['ticks_written'] += 1; self.link.writer_ok()
