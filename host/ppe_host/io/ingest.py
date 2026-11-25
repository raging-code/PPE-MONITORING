"""io/ingest.py (P12-2): the per-frame path of design 1 (Per-frame order) from a parsed serial Frame to one frames row in the writer queue.
Order: host re-verify (length, CRC, MAC, roster) -> MAC_DISAGREE check against the base's own result -> sequence classifier (verify OK only) -> allocate the
frame's event_seq -> step() (which allocates the event_seq of any effect after it) -> one ordered writer Unit -> wait up to commit_wait_ms -> broadcast hook.
Calls are serialised by a lock so event_seq is allocated and submitted in the same order; P24 calls frame() from the event loop.
Not here (P24): turning effects into alerts, episodes and audit rows. They come back in Ingested.effects, with event_seq values already allocated.
Not here (P12b): the real clock, base_health rows, COUNTERS rows, SERIAL_LOST and SERIAL_BACK."""
import logging, threading, time
from collections import deque
from typing import NamedTuple, Optional
from .. import abi, constants as K
from ..clock import now_of
from ..core import crypto_abi as ca
from ..core.rule_engine import EngineState, FrameEvent, RANK, next_seq, step
from ..core.seq_classifier import SeqState, classify
from .db_writer import Stmt, Unit

log = logging.getLogger('ppe.ingest')
BAD_FRAMES_KEPT_PER_MIN = 20          # design 2.1: the first 20 diagnostic frames per minute are stored, the rest only counted (no settings key exists: module constant, like ADR 0001)
LEVELS = ('NORMAL', 'WARNING', 'DANGER')
COLS = ('event_seq, session_id, node_id, rx_ts, rx_mono, seq, boot_ctr, uptime_s, co_x10, co_over_range, temp_x100, hum, hr, motion_x100, bat, status2, flags, id_mode, status3, status4, '
        'node_level, backend_level, final_level, reasons, rssi, snr, verify, base_verify, seq_class, frames_lost, raw_hex, backend_ms')
FRAME_SQL = 'INSERT INTO frames(%s) VALUES (%s)' % (COLS, ','.join('?' * 32))
SYS_SQL = 'INSERT INTO system_events(session_id, event_seq, ts, kind, detail) VALUES (?, ?, ?, ?, ?)'

class Ingested(NamedTuple):
    verify: str                  # OK | BAD_LEN | BAD_CRC | BAD_MAC | REJECT_ROSTER (REJECT_ROSTER is never stored)
    seq_class: Optional[str]
    event_seq: Optional[int]     # the frame row's event_seq (None for REJECT_ROSTER)
    effects: tuple               # step() effects, event_seq already allocated
    stored: bool                 # a frames unit was queued (False: roster reject or diagnostic over the per-minute limit)
    committed: Optional[bool]    # True or False after the commit wait; None when no wait was made
    backend_ms: float
    unit: Optional[Unit]

class RateWindow:
    def __init__(self, limit, window_ms=60_000): self.limit, self.window, self.q = limit, window_ms, deque()
    def allow(self, mono_ms):
        while self.q and mono_ms - self.q[0] >= self.window: self.q.popleft()
        if len(self.q) < self.limit: self.q.append(mono_ms); return True
        return False

def _bit(v, field, name): s, w = abi.BITS[field][name]; return (v >> s) & ((1 << w) - 1)

class Ingest:
    def __init__(self, key, sys_id, roster, writer, clock, session_id, event_seq_start=0, commit_wait_ms=120, broadcast=None, perf=time.perf_counter):
        self.key, self.sys_id, self.roster, self.writer, self.clock, self.session_id = key, sys_id, frozenset(roster), writer, clock, session_id
        self.commit_wait_ms, self.broadcast, self.perf = commit_wait_ms, broadcast, perf
        self.st, self.cs = EngineState(event_seq=event_seq_start), SeqState()
        self.bad_window, self.disagree_window, self.last_hb = RateWindow(BAD_FRAMES_KEPT_PER_MIN), RateWindow(BAD_FRAMES_KEPT_PER_MIN), None
        self.counters = {'rejected_frames': 0, 'rejected_BAD_LEN': 0, 'rejected_BAD_CRC': 0, 'rejected_BAD_MAC': 0, 'rejected_REJECT_ROSTER': 0,
                         'bad_frames_not_stored': 0, 'mac_disagree': 0, 'suspect_logged': 0, 'frames_stored': 0}
        self._lock = threading.Lock()

    @classmethod
    def from_settings(cls, settings, roster, writer, clock, session_id, **kw):
        """key from config/secrets.json, sys_id and commit_wait_ms from settings; nothing secret comes from the repo."""
        return cls(settings.cmac_key(), settings['sys_id'], roster, writer, clock, session_id, commit_wait_ms=settings['commit_wait_ms'], **kw)

    def on_item(self, kind, payload):
        """The SerialReader callback."""
        if kind == 'frame': self.frame(payload)
        elif kind == 'hb': self.last_hb = payload             # base_health rows and BASE_OFFLINE are P12b

    def system_event(self, kind, detail=None, droppable=True):
        with self._lock: return self._sys(kind, detail, droppable)
    def _sys(self, kind, detail, droppable):
        self.st, seq = next_seq(self.st)
        return self.writer.submit(Unit(seq, [Stmt(SYS_SQL, (self.session_id, seq, self.clock.wall_ms(), kind, detail))], droppable=droppable))

    def _reject(self, why): c = self.counters; c['rejected_frames'] += 1; c['rejected_' + why] += 1

    def frame(self, f):
        with self._lock:
            t0, now = self.perf(), now_of(self.clock)
            r = ca.classify_frame(f.raw, self.key, self.sys_id); host, node, d = r.result, r.node_id, r.decoded
            if host == 'OK' and node not in self.roster: host = 'REJECT_ROSTER'
            seen = 'OK' if host == 'REJECT_ROSTER' else host
            disagree = seen != f.base_verify
            if disagree: self.counters['mac_disagree'] += 1
            note = (('node=%s host=%s base=%s' % (node, seen, f.base_verify)) if disagree and self.disagree_window.allow(now.mono_ms) else None)
            if host == 'REJECT_ROSTER':
                self._reject(host); out = Ingested(host, None, None, (), False, None, 0.0, None)
                if note: self._sys('MAC_DISAGREE', note, True)
                return out
            diag = host != 'OK'
            if diag: self._reject(host)
            lost, lvl = 0, (d['flags'] & 3) if d else None
            if diag: cls = 'suspect'
            elif lvl == 3:                                                  # flags node_level INVALID: stored suspect, never classified, baseline untouched
                cls = 'suspect'; self.counters['suspect_logged'] += 1; log.warning('suspect frame: node %s flags node_level INVALID (3)', node)
            else:
                self.cs, res = classify(self.cs, node, f.raw, d, now.mono_ms); cls, lost = res.seq_class, res.frames_lost
                if res.rebaselined: log.info('baseline re-established for node %s', node)
                if cls == 'suspect': self.counters['suspect_logged'] += 1; log.warning('suspect frame: node %s', node)
            self.st, fseq = next_seq(self.st)                              # the frame's own event_seq comes BEFORE the effects of this frame
            fx = ()
            if host != 'BAD_LEN': self.st, fx = step(self.st, FrameEvent(node, host, cls, d), now)
            backend_ms = (self.perf() - t0) * 1000.0
            nl = backend = final = reasons = None
            if host == 'OK' and lvl != 3:
                mine = sorted((a for (nid, _), a in self.st.alerts.items() if nid == node), key=lambda a: a.event_seq)
                top = max((RANK[a.level] for a in mine), default=0)
                nl, backend, final = LEVELS[lvl], LEVELS[top], self.st.nodes[node].level      # final = max(node_level, backend_level); a suspect frame keeps a higher displayed level (14.1)
                reasons = '; '.join(a.reasons for a in mine if a.reasons) or None
            g = (lambda k: d[k]) if d else (lambda k: None)
            over = int(host == 'OK' and not _bit(d['status2'], 'status2', 'co_fault') and d['co_x10'] / 10.0 > K.CO_CLAMP_MAX_PPM)
            row = (fseq, self.session_id, node, now.wall_ms, now.mono_ms, g('seq'), g('boot_ctr'), g('uptime_s'), g('co_x10'), over, g('temp_x100'), g('hum'), g('hr'), g('motion_x100'),
                   g('bat'), g('status2'), g('flags'), g('id_mode'), g('status3'), g('status4'), nl, backend, final, reasons, f.rssi, f.snr, host, f.base_verify, cls, lost,
                   f.raw.hex(), backend_ms)
            drop = diag and not fx
            stored = True
            if drop and not self.bad_window.allow(now.mono_ms): stored = False; self.counters['bad_frames_not_stored'] += 1      # counted, not stored: a flood cannot starve real frames
            unit = None
            if stored:
                unit = self.writer.submit(Unit(fseq, [Stmt(FRAME_SQL, row, tag='frame')], droppable=drop)); self.counters['frames_stored'] += 1
            if note: self._sys('MAC_DISAGREE', note, True)
        committed = self.writer.wait(unit, self.commit_wait_ms) if (stored and not drop) else None       # commit BEFORE broadcast, within commit_wait_ms (design 1)
        out = Ingested(host, cls, fseq, tuple(fx), stored, committed, backend_ms, unit)
        if stored and not drop and self.broadcast: self.broadcast(out)
        return out
