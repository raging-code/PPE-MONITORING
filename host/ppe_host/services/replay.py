"""services/replay.py (S7-3, ADR 0059): the REPLAY source of design 3.10 and 1 (Operating mode isolation, Clock abstraction).
REPLAY feeds the stored frames (and the stored base heartbeats) of one session of db_path through the normal pipeline at 1x, 4x or 16x, into a new session labelled REPLAY in test_db_path.
The source is read through a separate READ-ONLY connection (sqlite mode=ro): this module can never write to the original database. Nothing here writes at all: the items go to the callback the
SerialReader uses (Runtime.gate.on_item), so they are verified again with this host's key, classified, run through the rules and stored in test_db_path like live frames.
Pieces: open_source (checks the session and says what it holds), items (the merged, ordered stream with its time offsets), ReplayThread (delivers each item when the ScaledClock reaches its offset).
Time. An item's offset is the stored rx_ts (frames) or ts (heartbeats) minus the first one, taken in stored order: a step back in the stored time counts as no time, and one gap is cut to MAX_GAP_S, so
an outage of the source (a host restart, a laptop asleep) does not freeze the replay; every real silence of up to MAX_GAP_S, which covers the 15 s and 60 s link rules, is kept as it was.
The thread starts its time at the moment the gate goes live (RECOVERING_EXIT), not at Runtime.start, so the recovery of the test host does not bunch the first frames. When the data ends the clock stops (no
silence alert is made from the end of the data) and `finished` is set. Pause and resume stop and start the ScaledClock, so every timer pauses with the replay."""
import heapq, logging, sqlite3, threading
from pathlib import Path
from typing import NamedTuple, Optional
from ..io.serial_reader import Frame, Heartbeat

log = logging.getLogger('ppe.replay')
SPEEDS = (1, 4, 16)
MAX_GAP_S = 300

class ReplayError(Exception):
    """The source cannot be replayed (no database, no such session, no frames). main turns it into exit code 2."""

class SourceInfo(NamedTuple):
    session_id: int
    mode: str
    started_ts: int
    ended_ts: Optional[int]
    frames: int
    heartbeats: int
    first_ts: int
    last_ts: int

def connect_readonly(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=5, check_same_thread=False)

def open_source(db_path, session_id):
    """Checks the source and returns SourceInfo. Raises ReplayError for a missing database, a session that is not there, or a session with no frame to replay. Opens and closes its own connection."""
    p = Path(db_path)
    if not p.is_file(): raise ReplayError('no database at %s: REPLAY reads the session it replays from db_path' % p)
    try: c = connect_readonly(p)
    except sqlite3.Error as e: raise ReplayError('cannot open %s read-only: %s' % (p, e)) from None
    try:
        s = c.execute('SELECT mode, started_ts, ended_ts FROM sessions WHERE session_id = ?', (session_id,)).fetchone()
        if s is None: raise ReplayError('session %s is not in %s' % (session_id, p))
        nf, f0, f1 = c.execute('SELECT COUNT(*), MIN(rx_ts), MAX(rx_ts) FROM frames WHERE session_id = ?', (session_id,)).fetchone()
        nh, h0, h1 = c.execute('SELECT COUNT(*), MIN(ts), MAX(ts) FROM base_health WHERE session_id = ?', (session_id,)).fetchone()
        if not nf: raise ReplayError('session %s has no stored frame to replay' % session_id)
        return SourceInfo(session_id, s[0], s[1], s[2], nf, nh, min(x for x in (f0, h0) if x is not None), max(x for x in (f1, h1) if x is not None))
    except sqlite3.Error as e: raise ReplayError('cannot read %s: %s' % (p, e)) from None
    finally: c.close()

def label_of(info):
    """The session_label of the REPLAY session (the snapshot carries it): which session it replays and when that one started (UTC)."""
    from datetime import datetime, timezone
    return 'REPLAY of session %d (%s, started %s UTC)' % (info.session_id, info.mode, datetime.fromtimestamp(info.started_ts / 1000, timezone.utc).strftime('%Y-%m-%d %H:%M'))

def stale_test_items(conn):
    """What a replay must not start on: (open alerts, unresolved episodes) in the test database, read from its start-up connection. Alerts and episodes of an earlier test session stay open across sessions
    (2.11) and the open-alert index allows one open alert per node and type, so a stale one would hide the alert the replay is meant to raise."""
    return (conn.execute('SELECT COUNT(*) FROM alerts WHERE cleared_ts IS NULL').fetchone()[0], conn.execute("SELECT COUNT(*) FROM episodes WHERE state != 'RESOLVED'").fetchone()[0])

FRAME_Q = 'SELECT rx_ts, raw_hex, base_verify, rssi, snr FROM frames WHERE session_id = ? ORDER BY event_seq'
HB_Q = 'SELECT ts, uptime_ms, bat_pct, rx_ok, rx_bad_len, rx_bad_crc, rx_bad_mac FROM base_health WHERE session_id = ? ORDER BY id'

def items(conn, session_id, base_id=1, max_gap_ms=MAX_GAP_S * 1000):
    """(offset_ms, 'frame'|'hb', Frame|Heartbeat) in time order, offsets from the first item (0), never going back. Reads lazily with two cursors. A frame comes before a heartbeat of the same ms."""
    fr = ((ts, 0, i, Frame(bytes.fromhex(raw), bv, rssi, snr, base_id, 0), 'frame') for i, (ts, raw, bv, rssi, snr) in enumerate(conn.execute(FRAME_Q, (session_id,))))
    hb = ((ts, 1, i, Heartbeat(base_id, up, bat, ok, bl, bc, bm, 0), 'hb') for i, (ts, up, bat, ok, bl, bc, bm) in enumerate(conn.execute(HB_Q, (session_id,))))
    prev, off = None, 0
    for ts, _, _, payload, kind in heapq.merge(fr, hb, key=lambda t: t[:3]):
        if prev is not None: off += min(max(ts - prev, 0), max_gap_ms)
        prev = ts
        yield off, kind, payload

class ReplayThread:
    """Delivers the items of `info.session_id` to on_item(kind, payload) when the ScaledClock reaches their offsets. clock must be a ScaledClock (pause and resume go to it). ready() says the host may take frames
    (the gate is live); the thread's time 0 is the first poll after it. A failing handler is counted and never stops the thread. On the end of the data the clock stops and `finished` is set; on_done() is called when the thread ends for any reason."""
    def __init__(self, clock, on_item, db_path, session_id, base_id=1, ready=None, poll_s=0.1, on_alive=None, on_done=None):
        self.clock, self.on_item, self.db_path, self.session_id, self.base_id = clock, on_item, db_path, session_id, base_id
        self.ready, self.poll_s, self.on_alive, self.on_done = ready or (lambda: True), poll_s, on_alive or (lambda: None), on_done or (lambda: None)
        self.counters = {'replay_frames': 0, 'replay_heartbeats': 0, 'replay_handler_errors': 0}
        self.polls, self.last_error, self.error, self.started_at = 0, None, None, None
        self.finished = threading.Event(); self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name='ReplayThread', daemon=True)
    @property
    def paused(self): return self.clock.paused
    def pause(self): self.clock.pause()
    def resume(self):
        """A finished replay stays frozen (ADR 0059): a resume that races with the end of the data is undone."""
        if self.finished.is_set(): return
        self.clock.resume()
        if self.finished.is_set(): self.clock.pause()
    def start(self): self._thread.start(); return self
    def alive(self): return self._thread.is_alive()
    def stop(self, timeout_s=2): self._stop.set(); self._thread.join(timeout_s)
    def _run(self):
        conn = None
        try:
            conn = connect_readonly(self.db_path); it = items(conn, self.session_id, self.base_id); nxt = next(it, None); t0 = None
            while not self._stop.is_set():
                self.on_alive()
                if t0 is None and self.ready(): t0 = self.clock.mono_ms(); self.started_at = t0
                if t0 is not None:
                    now = self.clock.mono_ms() - t0
                    while nxt is not None and nxt[0] <= now and not self._stop.is_set():
                        try: self.on_item(nxt[1], nxt[2])
                        except Exception as e: self.counters['replay_handler_errors'] += 1; self.last_error = repr(e)
                        else: self.counters['replay_frames' if nxt[1] == 'frame' else 'replay_heartbeats'] += 1
                        nxt = next(it, None)
                    if nxt is None: self.finished.set(); self.clock.pause(); log.info('replay of session %d finished: %d frames, %d heartbeats', self.session_id, self.counters['replay_frames'], self.counters['replay_heartbeats']); self.polls += 1; return
                self.polls += 1; self._stop.wait(self.poll_s)
        except Exception as e:
            self.error = repr(e); log.exception('replay stopped by an error')
        finally:
            if conn is not None: conn.close()
            self.on_done()                                              # the end of the data, a stop or an error: the thread no longer stamps its liveness, so the owner retires the stamp
