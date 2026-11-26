"""io/ingest.py (P12-2): the per-frame path of design 1 (Per-frame order) from a parsed serial Frame to one frames row in the writer queue.
Order: host re-verify (length, CRC, MAC, roster) -> MAC_DISAGREE check against the base's own result -> sequence classifier (verify OK only) -> allocate the
frame's event_seq -> step() (which allocates the event_seq of any effect after it) -> one ordered writer Unit -> wait up to commit_wait_ms -> broadcast hook.
Calls are serialised by a lock so event_seq is allocated and submitted in the same order; P24 calls frame() from the event loop.
P24-3a: effect_stmts() turns the effects of step() into alert, episode and EPISODE_ESCALATED rows that commit in the same unit as the frame (design 1, commit paragraph); tick() and operator() do the
same for the 1 Hz TickEvent and for Acknowledge and Resolve. Effects also come back in Ingested.effects, with event_seq values already allocated; the committed ids are in unit._ids.
P24-3b-1: audit() and write() give the Port (host_port.py) ordered units of its own. P24-3b-2a: Ingested.ctx carries the reading's inputs; the messages themselves are built in wire.py. The audit rows of ACK_EPISODE, RESOLVE_EPISODE and the like are written by the REST routes through the Port, not here.
P24-3b-2b-ii: advisory_step (core/advisory.py, P9) runs after step() on every frame() and tick() when adv_cfg is set (None until a Wire turns it on: the advisory table needs no reader until the
dashboard does); its AdvisoryRow effects get one advisory_summaries row each, in the same unit as the frame or tick, and come back in Ingested.effects so wire.py can build the advisory message.
Not here (P12b): the real clock, base_health rows, COUNTERS rows, SERIAL_LOST and SERIAL_BACK."""
import logging, threading, time
from collections import deque
from typing import NamedTuple, Optional
from .. import abi, constants as K
from ..clock import now_of
from ..core import crypto_abi as ca
from ..core.advisory import AdvisoryConfig, AdvisoryRow, AdvisoryState, advisory_step
from ..core.rule_engine import (AlertAcknowledged, ChangeAlertLevel, ClearAlert, EPISODE_ALERT_TYPES, EngineState, EpisodeAcknowledged, EpisodeEscalated, EpisodeOpened, EpisodeResolved,
                                FrameEvent, RANK, RaiseAlert, TickEvent, next_seq, step)
from ..core.seq_classifier import SeqState, classify
from .db_writer import Ref, Stmt, Unit

log = logging.getLogger('ppe.ingest')
BAD_FRAMES_KEPT_PER_MIN = 20          # design 2.1: the first 20 diagnostic frames per minute are stored, the rest only counted (no settings key exists: module constant, like ADR 0001)
LEVELS = ('NORMAL', 'WARNING', 'DANGER')
COLS = ('event_seq, session_id, node_id, rx_ts, rx_mono, seq, boot_ctr, uptime_s, co_x10, co_over_range, temp_x100, hum, hr, motion_x100, bat, status2, flags, id_mode, status3, status4, '
        'node_level, backend_level, final_level, reasons, rssi, snr, verify, base_verify, seq_class, frames_lost, raw_hex, backend_ms')
FRAME_SQL = 'INSERT INTO frames(%s) VALUES (%s)' % (COLS, ','.join('?' * 32))
SYS_SQL = 'INSERT INTO system_events(session_id, event_seq, ts, kind, detail) VALUES (?, ?, ?, ?, ?)'
AUDIT_SQL = 'INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, node_id, episode_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
ACTIVE_EP = "(SELECT episode_id FROM episodes WHERE node_id = ? AND state IN ('OPEN', 'ACKNOWLEDGED'))"   # one active episode per node (idx_episodes_one_active), so the node finds it
IN_ACTIVE = "node_id = ? AND state IN ('OPEN', 'ACKNOWLEDGED')"

def effect_stmts(fx, session_id):
    """The rows of a tuple of step() effects, in effect order. An alert is identified by the event_seq of the effect that raised it (unique over the whole database, also across sessions);
    an episode by its node while it is active. Tags: alert:<event_seq> and episode:<event_seq> give the new row id after the commit. A frame in the same unit supplies frame_id through Ref('frame').
    EpisodeLabelChanged has no row: it is a WebSocket message only. A one-shot notice is stored already closed (cleared_ts = raised_ts, 14.1b)."""
    out = []
    for e in fx:
        if isinstance(e, RaiseAlert):
            ep = e.type in EPISODE_ALERT_TYPES
            out.append(Stmt('INSERT INTO alerts(event_seq, session_id, frame_id, episode_id, node_id, type, level, authenticated, reasons, raised_ts, cleared_ts) VALUES (?, ?, ?, %s, ?, ?, ?, ?, ?, ?, ?)' % (ACTIVE_EP if ep else 'NULL'),
                            (e.event_seq, session_id, Ref('frame'), *((e.node_id,) if ep else ()), e.node_id, e.type, e.level, int(e.type != 'unauth_alert'), e.reasons or None, e.raised_ts, e.raised_ts if e.one_shot else None), tag='alert:%d' % e.event_seq))
        elif isinstance(e, ClearAlert): out.append(Stmt('UPDATE alerts SET cleared_ts = ?, cleared_event_seq = ? WHERE event_seq = ?', (e.cleared_ts, e.event_seq, e.raised_event_seq)))
        elif isinstance(e, ChangeAlertLevel):   # escalation clears the acknowledgement (the siren sounds again), lowering keeps it (14.1)
            out.append(Stmt('UPDATE alerts SET level = ?, reasons = ?, acknowledged_ts = CASE WHEN ? THEN NULL ELSE acknowledged_ts END, acknowledged_by = CASE WHEN ? THEN NULL ELSE acknowledged_by END WHERE event_seq = ?',
                            (e.level, e.reasons or None, int(e.acknowledged_reset), int(e.acknowledged_reset), e.raised_event_seq)))
        elif isinstance(e, AlertAcknowledged): out.append(Stmt('UPDATE alerts SET acknowledged_ts = ?, acknowledged_by = ? WHERE event_seq = ?', (e.ts, e.operator_id, e.raised_event_seq)))
        elif isinstance(e, EpisodeOpened):
            out.append(Stmt("INSERT INTO episodes(session_id, node_id, kind, opened_ts, state) VALUES (?, ?, ?, ?, 'OPEN')", (session_id, e.node_id, e.kind, e.opened_ts), tag='episode:%d' % e.event_seq))
        elif isinstance(e, EpisodeEscalated):
            out.append(Stmt('UPDATE episodes SET kind = ? WHERE ' + IN_ACTIVE, (e.kind, e.node_id)))
            out.append(Stmt("INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, node_id, episode_id, reason) VALUES (?, ?, ?, NULL, 'EPISODE_ESCALATED', ?, %s, ?)" % ACTIVE_EP,
                            (session_id, e.event_seq, e.ts, e.node_id, e.node_id, '%s to %s' % (e.old_kind, e.kind))))
        elif isinstance(e, EpisodeAcknowledged):
            out.append(Stmt("UPDATE episodes SET state = 'ACKNOWLEDGED', acknowledged_ts = ?, acknowledged_by = ? WHERE node_id = ? AND state = 'OPEN'", (e.ts, e.operator_id, e.node_id)))
        elif isinstance(e, EpisodeResolved):
            out.append(Stmt("UPDATE episodes SET state = 'RESOLVED', resolved_ts = ?, resolve_reason = ?, resolved_by = ? WHERE " + IN_ACTIVE, (e.ts, e.reason, e.operator_id, e.node_id)))
        elif isinstance(e, AdvisoryRow):   # P24-3b-2b-ii: advisory_summaries has no row for passage_ids yet (Tier 1: source is always 'table', passage_ids stays NULL)
            out.append(Stmt('INSERT INTO advisory_summaries(session_id, event_seq, ts, node_id, window_s, risk, reasons, action, source, passage_ids, quality) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                            (session_id, e.event_seq, e.ts, e.node_id, e.window_s, e.risk, e.reasons, e.action, e.source, e.passage_ids, e.quality)))
    return out

class Ingested(NamedTuple):
    verify: str                  # OK | BAD_LEN | BAD_CRC | BAD_MAC | REJECT_ROSTER (REJECT_ROSTER is never stored)
    seq_class: Optional[str]
    event_seq: Optional[int]     # the frame row's event_seq (None for REJECT_ROSTER)
    effects: tuple               # step() effects, event_seq already allocated
    stored: bool                 # a frames unit was queued (False: roster reject or diagnostic over the per-minute limit)
    committed: Optional[bool]    # True or False after the commit wait; None when no wait was made
    backend_ms: float
    unit: Optional[Unit]
    ctx: Optional[dict] = None   # P24-3b-2a: what the reading message needs, captured under the lock (None unless verify is OK); see wire.reading_body

class RateWindow:
    def __init__(self, limit, window_ms=60_000): self.limit, self.window, self.q = limit, window_ms, deque()
    def allow(self, mono_ms):
        while self.q and mono_ms - self.q[0] >= self.window: self.q.popleft()
        if len(self.q) < self.limit: self.q.append(mono_ms); return True
        return False

def _bit(v, field, name): s, w = abi.BITS[field][name]; return (v >> s) & ((1 << w) - 1)

class Ingest:
    def __init__(self, key, sys_id, roster, writer, clock, session_id, event_seq_start=0, commit_wait_ms=120, broadcast=None, perf=time.perf_counter, health=None):
        self.key, self.sys_id, self.roster, self.writer, self.clock, self.session_id = key, sys_id, frozenset(roster), writer, clock, session_id
        self.commit_wait_ms, self.broadcast, self.perf, self.health = commit_wait_ms, broadcast, perf, health   # health: io/health.Health, set by the owner (P12b)
        self.st, self.cs, self.adv = EngineState(event_seq=event_seq_start), SeqState(), AdvisoryState()
        self.adv_cfg = None   # P24-3b-2b-ii: off until a Wire calls enable_advisory(); advisory_step is skipped while this is None
        self.bad_window, self.disagree_window, self.last_hb = RateWindow(BAD_FRAMES_KEPT_PER_MIN), RateWindow(BAD_FRAMES_KEPT_PER_MIN), None
        self.counters = {'rejected_frames': 0, 'rejected_BAD_LEN': 0, 'rejected_BAD_CRC': 0, 'rejected_BAD_MAC': 0, 'rejected_REJECT_ROSTER': 0,
                         'bad_frames_not_stored': 0, 'mac_disagree': 0, 'suspect_logged': 0, 'frames_stored': 0}
        self._lock = threading.Lock()

    @classmethod
    def from_settings(cls, settings, roster, writer, clock, session_id, **kw):
        """key from config/secrets.json, sys_id and commit_wait_ms from settings; nothing secret comes from the repo."""
        return cls(settings.cmac_key(), settings['sys_id'], roster, writer, clock, session_id, commit_wait_ms=settings['commit_wait_ms'], **kw)

    def enable_advisory(self, heartbeat_s):
        """P24-3b-2b-ii: turn the Tier 1 advisory table on (settings key advisory_heartbeat_s). Idempotent; a second call with a different heartbeat_s replaces cfg without resetting AdvisoryState."""
        self.adv_cfg = AdvisoryConfig(heartbeat_s=heartbeat_s)

    def on_item(self, kind, payload):
        """The SerialReader callback."""
        if self.health is not None: self.health.seen()          # any heartbeat or frame line from the base is a sign of life (BASE_BACK is logged here)
        if kind == 'frame': self.frame(payload)
        elif kind == 'hb': self.heartbeat(payload)

    def heartbeat(self, hb):
        """One base_health row per heartbeat (design 2.3). The row has no event_seq column, but its unit takes one so the single ordered queue stays ordered; it is routine and droppable."""
        self.last_hb = hb
        with self._lock:
            self.st, seq = next_seq(self.st)
            self.writer.submit(Unit(seq, [Stmt('INSERT INTO base_health(session_id, ts, uptime_ms, bat_pct, rx_ok, rx_bad_len, rx_bad_crc, rx_bad_mac) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (self.session_id, self.clock.wall_ms(), hb.uptime_ms, hb.bat_pct, hb.rx_ok, hb.rx_bad_len, hb.rx_bad_crc, hb.rx_bad_mac))], droppable=True))

    def system_event(self, kind, detail=None, droppable=True):
        with self._lock: return self._sys(kind, detail, droppable)
    def _sys(self, kind, detail, droppable):
        self.st, seq = next_seq(self.st)
        return self.writer.submit(Unit(seq, [Stmt(SYS_SQL, (self.session_id, seq, self.clock.wall_ms(), kind, detail))], droppable=droppable))

    def _fx_unit(self, fx, durable):
        stmts = effect_stmts(fx, self.session_id)
        return self.writer.submit(Unit(fx[0].event_seq, stmts, durable=durable)) if stmts else None   # an effect with no row (a label change) still used its event_seq: a gap is allowed

    def tick(self):
        """The 1 Hz TickEvent (silence rules and the 10 s timers). Returns (effects, unit); the owner broadcasts after the commit."""
        with self._lock:
            now = now_of(self.clock); self.st, fx = step(self.st, TickEvent(), now); event = TickEvent()
            if self.adv_cfg is not None:
                self.st, self.adv, afx = advisory_step(self.st, self.adv, event, now, self.adv_cfg); fx = tuple(fx) + afx
            return tuple(fx), self._fx_unit(fx, False)

    def operator(self, event):
        """Acknowledge or Resolve (AckAlertEvent, AckEpisodeEvent, ResolveEpisodeEvent) through step(). The unit is durable (synchronous=FULL). Returns (effects, unit); a repeat gives ((), None).
        A bad Resolve reason raises ValueError and changes nothing."""
        with self._lock:
            self.st, fx = step(self.st, event, now_of(self.clock)); return tuple(fx), self._fx_unit(fx, True)

    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None, durable=False):
        """P24-3b-1: one audit_events row for the Port (the REST routes and the WebSocket hub), in the current session, with its own event_seq. Returns the Unit."""
        with self._lock:
            self.st, seq = next_seq(self.st)
            return self.writer.submit(Unit(seq, [Stmt(AUDIT_SQL, (self.session_id, seq, self.clock.wall_ms(), operator_id, action, node_id, episode_id, reason))], durable=durable))

    def write(self, stmts, durable=False):
        """P24-3b-1: rows the host itself writes (a session update, the acknowledgement of a cleared alert) as one ordered unit with its own event_seq. Returns the Unit."""
        with self._lock:
            self.st, seq = next_seq(self.st)
            return self.writer.submit(Unit(seq, list(stmts), durable=durable))

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
            if host != 'BAD_LEN':
                event = FrameEvent(node, host, cls, d); self.st, fx = step(self.st, event, now)
                if self.adv_cfg is not None:
                    self.st, self.adv, afx = advisory_step(self.st, self.adv, event, now, self.adv_cfg); fx = tuple(fx) + afx
            backend_ms = (self.perf() - t0) * 1000.0
            nl = backend = final = reasons = None; rlist = []
            if host == 'OK' and lvl != 3:
                mine = sorted((a for (nid, _), a in self.st.alerts.items() if nid == node), key=lambda a: a.event_seq)
                top = max((RANK[a.level] for a in mine), default=0)
                nl, backend, final = LEVELS[lvl], LEVELS[top], self.st.nodes[node].level      # final = max(node_level, backend_level); a suspect frame keeps a higher displayed level (14.1)
                reasons = '; '.join(a.reasons for a in mine if a.reasons) or None; rlist = [a.reasons for a in mine if a.reasons]
            g = (lambda k: d[k]) if d else (lambda k: None)
            over = int(host == 'OK' and not _bit(d['status2'], 'status2', 'co_fault') and d['co_x10'] / 10.0 > K.CO_CLAMP_MAX_PPM)
            row = (fseq, self.session_id, node, now.wall_ms, now.mono_ms, g('seq'), g('boot_ctr'), g('uptime_s'), g('co_x10'), over, g('temp_x100'), g('hum'), g('hr'), g('motion_x100'),
                   g('bat'), g('status2'), g('flags'), g('id_mode'), g('status3'), g('status4'), nl, backend, final, reasons, f.rssi, f.snr, host, f.base_verify, cls, lost,
                   f.raw.hex(), backend_ms)
            ctx = dict(node=node, d=d, rx_ts=now.wall_ms, rx_mono=now.mono_ms, rssi=f.rssi, snr=f.snr, over=over, ns=self.st.nodes.get(node), reasons=rlist, seq_class=cls) if host == 'OK' else None
            drop = (diag and not fx)
            stored = True
            if drop and not self.bad_window.allow(now.mono_ms): stored = False; self.counters['bad_frames_not_stored'] += 1      # counted, not stored: a flood cannot starve real frames
            unit = None
            if stored:
                unit = self.writer.submit(Unit(fseq, [Stmt(FRAME_SQL, row, tag='frame'), *effect_stmts(fx, self.session_id)], droppable=drop)); self.counters['frames_stored'] += 1
            if note: self._sys('MAC_DISAGREE', note, True)
        committed = self.writer.wait(unit, self.commit_wait_ms) if (stored and not drop) else None       # commit BEFORE broadcast, within commit_wait_ms (design 1)
        out = Ingested(host, cls, fseq, tuple(fx), stored, committed, backend_ms, unit, ctx)   # fx may now include AdvisoryRow effects (P24-3b-2b-ii)
        if stored and not drop and self.broadcast: self.broadcast(out)
        return out
