"""wire.py (P24-3b-2a): the dashboard messages of design 3.8 built from what the engine and the writer did, and the snapshot. Not in the 14.5 file list: ADR 0032 (Proposed).
Wire turns Ingested frames and operator effects into reading, alert and episode bodies and hands them to the Hub (api/ws_hub.py: publish_reading, publish_alert, publish_episode;
the hub adds v, srv_seq and srv_ts). Commit before broadcast (design 1): an alert or episode message is built only after its unit committed, and its body is read back from the
committed row, so the alert_id is always the database id the REST Acknowledge uses. A unit that did not commit within commit_wait_ms is held in pending and sent by flush();
a row the writer rejected has no id, so no message is sent and its event_seq goes into unpersisted (ADR 0032 and ADR 0033: the wire has no unpersisted field yet, which needs a decision).
P24-3b-2b-i: link and system messages (Wire.link_state, _links, _system, on_banner_ack). P24-3b-2b-ii: the advisory message (Wire.enable_advisory, _advisory), sent straight from the
AdvisoryRow effect (it has a passage_ids field but no database id of its own to read back, unlike an alert or episode). No thread, no socket; every method runs on the event loop."""
import logging, sqlite3
from collections import deque
from . import abi, constants as K
from .core.advisory import AdvisoryRow
from .core.rule_engine import (AlertAcknowledged, ChangeAlertLevel, ClearAlert, EpisodeAcknowledged, EpisodeEscalated, EpisodeLabelChanged, EpisodeOpened, EpisodeResolved,
                               NodeState, RaiseAlert)
from .io.db_writer import connect_db

log = logging.getLogger('ppe.wire')
CO_HISTORY_S = 1800   # co_history_30m of the snapshot (design 3.8): the last 30 minutes
POSTURES = {v: k for k, v in abi.ENUMS['posture'].items()}
ALERT_FX = (RaiseAlert, ChangeAlertLevel, ClearAlert, AlertAcknowledged)
EPISODE_FX = (EpisodeOpened, EpisodeEscalated, EpisodeLabelChanged, EpisodeAcknowledged, EpisodeResolved)
ALERT_SQL = 'SELECT alert_id, event_seq, node_id, type, level, authenticated, reasons, episode_id, raised_ts, cleared_ts, acknowledged_ts, acknowledged_by FROM alerts '
EPISODE_SQL = ("SELECT episode_id, node_id, kind, state, resolve_reason, opened_ts, (SELECT display_name FROM operators WHERE operator_id = CASE state WHEN 'RESOLVED' THEN resolved_by "
               "WHEN 'ACKNOWLEDGED' THEN acknowledged_by END) AS operator FROM episodes ")
FRAME_SQL = ("SELECT rx_ts, co_x10, temp_x100, hum, motion_x100, bat, status2, flags, id_mode, status3, status4 FROM frames WHERE node_id = ? AND verify = 'OK' AND seq_class != 'duplicate' "
             "ORDER BY rx_ts DESC, frame_id DESC LIMIT 1")   # v_readings semantics; uses idx_frames_node_ts
HIST_SQL = ("SELECT rx_ts, co_x10 FROM frames WHERE node_id = ? AND rx_ts >= ? AND verify = 'OK' AND seq_class != 'duplicate' AND (status2 & 16) = 0 AND co_x10 IS NOT NULL ORDER BY rx_ts")

def bit(v, field, name): s, w = abi.BITS[field][name]; return (v >> s) & ((1 << w) - 1)

def reading_body(c, alias):
    """ReadingMsg fields (no envelope) from Ingested.ctx. co_ppm is raw and un-clamped; stillness_s is the host's estimate from the shadow run (design 3.2)."""
    d, ns = c['d'], c['ns'] or NodeState(); still = ns.shadow_still_since_mono
    return dict(node_id=c['node'], alias=alias, rx_ts=c['rx_ts'], co_ppm=d['co_x10'] / 10, co_over_range=int(c['over']), co_validity=ns.co_validity, co_reason=ns.co_reason,
                temp_c=d['temp_x100'] / 100, hum_pct=d['hum'], motion_g=d['motion_x100'] / 100, posture=POSTURES[bit(d['id_mode'], 'id_mode', 'posture')],
                stillness_s=0.0 if still is None else max(0, c['rx_mono'] - still) / 1000, bat_pct=d['bat'], scba=bit(d['id_mode'], 'id_mode', 'scba_on'),
                mandown=bit(d['flags'], 'flags', 'mandown'), level=ns.level, reasons=list(c['reasons']), seq_class=c['seq_class'], rssi=c['rssi'], snr=c['snr'],
                status2=d['status2'], flags=d['flags'], id_mode=d['id_mode'], status3=d['status3'], status4=d['status4'])

def alert_body(r, ns=None):
    """AlertBody fields from an alerts row. unauth_count and last_seen_ts come from the node's engine state and exist only for unauth_alert."""
    u = r['type'] == 'unauth_alert'
    return dict(alert_id=r['alert_id'], node_id=r['node_id'], alert_type=r['type'], level=r['level'], reasons=r['reasons'], authenticated=r['authenticated'], episode_id=r['episode_id'],
                raised_ts=r['raised_ts'], cleared_ts=r['cleared_ts'], acknowledged_ts=r['acknowledged_ts'], acknowledged_by=r['acknowledged_by'],
                unauth_count=(ns.unauth_count if ns else 0) if u else None, last_seen_ts=((ns.unauth_last_seen_ts if ns else None) or r['raised_ts']) if u else None)

def advisory_body(e):
    """AdvisoryMsg fields (no envelope) from an AdvisoryRow effect. No database id: Tier 1 never acknowledges or re-reads an advisory row (design 14.3), so unlike alert_body and
    episode_body this is built straight from the effect, with no read-back and nothing added by _send."""
    return dict(node_id=e.node_id, risk=e.risk, reasons=e.reasons, action=e.action, quality=e.quality, source=e.source)

def episode_body(r, label):
    """EpisodeBody fields from an episodes row. The motion label exists only for an unresolved MAN_DOWN."""
    return dict(episode_id=r['episode_id'], node_id=r['node_id'], kind=r['kind'], state=r['state'], resolve_reason=r['resolve_reason'], operator=r['operator'],
                man_down_motion_state=None if r['kind'] == 'MAYDAY' or r['state'] == 'RESOLVED' else label)

class Wire:
    def __init__(self, port, hub, base_offline=None, audio_fault=None, host_power=None):
        """port: HostPort; hub: anything with publish_reading, publish_alert and publish_episode (api/ws_hub.Hub). The three callables are the sources of the banner flags that
        belong to threads wired in P24-3c (default: the ingest Health object, no audio fault, 'ac')."""
        self.port, self.ing, self.hub = port, port.ing, hub
        self.base_offline = base_offline or (lambda: bool(getattr(self.ing.health, 'offline', False)))
        self.audio_fault, self.host_power = audio_fault or (lambda: False), host_power or (lambda: 'ac')
        self.pending, self.unpersisted, self.unauth_sent = deque(), set(), {}
        self.on_change = None   # P24-3c-3: called with no argument as soon as the engine state or a banner changed (the AudioThread feed); a failure is logged and never reaches the caller
        with self._conn() as c:
            self.alias = {r['node_id']: r['alias'] for r in c.execute('SELECT node_id, alias FROM roster')}
            self.mode = c.execute('SELECT mode FROM sessions WHERE session_id = ?', (self.ing.session_id,)).fetchone()['mode']
        self.links, self.sys_key, self.sys_rej = {}, None, 0   # P24-3b-2b-i: last link state per node, last system body (without the counter), counter last sent

    def enable_advisory(self, heartbeat_s):
        """P24-3b-2b-ii: turn the Tier 1 advisory table on in the Ingest this Wire is attached to. Call before or after attach(); advisory rows reach the hub through the normal _send path
        either way, since AdvisoryRow effects travel in Ingested.effects / step()'s own fx exactly like alert and episode effects do."""
        self.ing.enable_advisory(heartbeat_s)

    def attach(self):
        """Plug in: operator effects (HostPort.publish), frames (Ingest.broadcast) and HostPort.snapshot (the Hub's Source)."""
        self.port.publish, self.port.wire, self.ing.broadcast = self.on_effects, self, self.on_frame
        now = self.ing.clock.wall_ms(); self.links = {n: (self.link_state(n), now) for n in self.alias}   # what is true now is not news
        b = self._sys_body(); self.sys_key, self.sys_rej = self._key(b), b['rejected_frames']; return self
    def _conn(self):
        c = connect_db(self.port.db_path, readonly=True); c.row_factory = sqlite3.Row; return _Conn(c)

    def _changed(self):
        if self.on_change is not None:
            try: self.on_change()
            except Exception: log.exception('on_change failed')

    # ---- incremental messages ----
    def on_frame(self, out):
        """The Ingest.broadcast hook: one reading for a verified frame, then the alert and episode messages of its effects."""
        if out.ctx is not None: self.hub.publish_reading(reading_body(out.ctx, self.alias.get(out.ctx['node'], '')))
        self.on_effects(out.effects, out.unit, out.committed); self._links()
    def on_effects(self, fx, unit, ok):
        """The HostPort.publish hook. ok is True (committed), False (not within commit_wait_ms: held in pending) or None (nothing was written)."""
        if not fx: return
        self._changed()                                     # first: the host alarm must not wait for the database reads of _send
        if ok is False: self.pending.append((tuple(fx), unit))
        else: self._send(fx)
    def flush(self):
        """Send what was held for a slow commit once its unit has committed. Called every second."""
        for _ in range(len(self.pending)):
            fx, u = self.pending.popleft()
            if u is not None and u.done.is_set(): self._send(fx)
            else: self.pending.append((fx, u))
    def tick(self):
        """The 1 Hz driver for P24-3c: the engine tick and its effects, held messages, and the unauth_alert repeats (the hub sends at most one per second)."""
        fx, u = self.ing.tick(); self.on_effects(fx, u, self.port.writer.wait(u, self.ing.commit_wait_ms) if u is not None else None); self.flush()
        open_ = {a.event_seq: nid for (nid, t), a in self.ing.st.alerts.items() if t == 'unauth_alert'}
        self.unauth_sent = {k: v for k, v in self.unauth_sent.items() if k in open_}
        due = [k for k, nid in open_.items() if self.unauth_sent.get(k) != getattr(self.ing.st.nodes.get(nid), 'unauth_count', 0)]
        if due: self._send([RaiseAlert(k, open_[k], 'unauth_alert', 'NONE', '', 0) for k in due])
        self._links(); self._system(tick=True); self._changed()

    def _send(self, fx):
        with self._conn() as c:
            keys = {(e.event_seq if isinstance(e, RaiseAlert) else e.raised_event_seq) for e in fx if isinstance(e, ALERT_FX)}
            rows = {r['event_seq']: r for r in c.execute(ALERT_SQL + 'WHERE event_seq IN (%s)' % ','.join('?' * len(keys)), tuple(keys))} if keys else {}
            eps = {n: c.execute(EPISODE_SQL + 'WHERE node_id = ? ORDER BY episode_id DESC LIMIT 1', (n,)).fetchone() for n in {e.node_id for e in fx if isinstance(e, EPISODE_FX)}}
        for e in fx:
            if isinstance(e, AdvisoryRow): self._pub('publish_advisory', advisory_body(e)); continue   # no row to read back (design 14.3): send straight from the effect
            if isinstance(e, ALERT_FX):
                k = e.event_seq if isinstance(e, RaiseAlert) else e.raised_event_seq; r = rows.get(k)
                if r is None: self.unpersisted.add(k); continue   # the row was rejected: no id, no message (ADR 0032)
                b = alert_body(r, self.ing.st.nodes.get(r['node_id']))
                if b['alert_type'] == 'unauth_alert': self.unauth_sent[k] = b['unauth_count']
                self.hub.publish_alert(b)
            elif isinstance(e, EPISODE_FX):
                r = eps.get(e.node_id)
                if r is None or (isinstance(e, EpisodeOpened) and r['opened_ts'] != e.opened_ts): continue   # the Opened row was rejected: do not show the previous episode
                ep = self.ing.st.episodes.get(e.node_id)
                self.hub.publish_episode(episode_body(r, e.motion_state if isinstance(e, EpisodeLabelChanged) else (ep.motion_state if ep else 'no_response')))

    # ---- link and system messages (P24-3b-2b-i) ----
    def _pub(self, name, body):
        """Send to the hub only if it has that method: the 3b-2a hub fakes have no publish_link, publish_system or publish_advisory."""
        fn = getattr(self.hub, name, None)
        if fn is not None: fn(body)
    def link_state(self, nid):
        """The LinkMsg state of a node from the engine (design 3.8), shared by the link message and the snapshot. Precedence: link_lost, signal_lost, recovered (the recovery frame and the next
        rebaseline_clean_frames frames are still counted down in shadow_rebaseline_left), weak_signal (open notice), ok. A node the engine has not heard is not_connected."""
        ns, al = self.ing.st.nodes.get(nid), self.ing.st.alerts
        if ns is None: return 'not_connected'
        if (nid, 'link_lost') in al: return 'link_lost'
        if (nid, 'signal_lost') in al: return 'signal_lost'
        if ns.shadow_rebaseline_left > 0: return 'recovered'
        return 'weak_signal' if (nid, 'weak_signal') in al else 'ok'
    def _links(self):
        """One link message per node whose state changed since the last one. It has no database id, so it is not held for a slow commit."""
        now = self.ing.clock.wall_ms()
        for nid in sorted(self.alias):
            s, prev = self.link_state(nid), self.links.get(nid, ('not_connected', None))[0]
            if s != prev: self.links[nid] = (s, now); self._pub('publish_link', dict(node_id=nid, state=s, since_ts=now, last_state=prev))
    def _sys_body(self, banner=None, ack=None):
        port = self.port; on, got = port.banner_state('host_gap'); g = port.host_gap
        return dict(base='offline' if self.base_offline() else 'ok', recovering=bool(port.recovering), session_id=self.ing.session_id, session_mode=self.mode,
                    rejected_frames=self.ing.counters['rejected_frames'], logging_fault=bool(port.writer.logging_fault),
                    host_gap=dict(gap_s=float(g['gap_s']), reason=g['reason']) if on and got is None else None,
                    host_power=str(self.host_power()), audio_fault=bool(self.audio_fault()), banner=banner, acknowledged_ts=ack)
    @staticmethod
    def _key(b): return {k: v for k, v in b.items() if k not in ('rejected_frames', 'banner', 'acknowledged_ts')}
    def _system(self, tick=False, banner=None, ack=None):
        """A system message when a banner source changed, or with the tick when the rejected-frame count moved (3.8: not more often), or at once for a banner acknowledgement."""
        b = self._sys_body(banner, ack)
        if banner is None and self._key(b) == self.sys_key and not (tick and b['rejected_frames'] != self.sys_rej): return
        self.sys_key, self.sys_rej = self._key(b), b['rejected_frames']; self._pub('publish_system', b)
    def on_banner_acknowledged(self, kind, ts): self._changed(); self._system(banner=kind, ack=ts)

    # ---- snapshot ----
    def snapshot(self):
        """Every SnapshotMsg field except v, type, srv_seq, srv_ts and epoch (the Hub adds those). Read from the committed rows plus the engine state, on the event loop."""
        ing, port = self.ing, self.port; nodes, hist, now = [], {}, ing.clock.wall_ms()
        with self._conn() as c:
            s = c.execute('SELECT session_id, started_ts, mode, session_label FROM sessions WHERE session_id = ?', (ing.session_id,)).fetchone()
            roster = c.execute('SELECT node_id, alias, active FROM roster ORDER BY node_id').fetchall()
            for r in roster:
                nid = r['node_id']; f = c.execute(FRAME_SQL, (nid,)).fetchone(); ns = ing.st.nodes.get(nid); heard = f is not None
                link = self.link_state(nid)
                sc = port.scba.get(nid)
                nodes.append(dict(node_id=nid, alias=r['alias'], last_rx_ts=f['rx_ts'] if heard else None, co_ppm=f['co_x10'] / 10 if heard and f['co_x10'] is not None else None,
                                  temp_c=f['temp_x100'] / 100 if heard else None, hum_pct=f['hum'] if heard else None, motion_g=f['motion_x100'] / 100 if heard else None,
                                  bat_pct=f['bat'] if heard else None, scba=bit(f['id_mode'], 'id_mode', 'scba_on') if heard else None, mandown=bit(f['flags'], 'flags', 'mandown') if heard else None,
                                  level=ns.level if ns else None, link_state=link, status2=f['status2'] if heard else None, flags=f['flags'] if heard else None,
                                  id_mode=f['id_mode'] if heard else None, status3=f['status3'] if heard else None, status4=f['status4'] if heard else None,
                                  co_validity=ns.co_validity if ns else 'VALID', co_reason=ns.co_reason if ns else None,
                                  scba_correction=dict(recorded_ts=sc[0], operator=sc[1]) if sc else None))
                hist[str(nid)] = [[t, x / 10] for t, x in c.execute(HIST_SQL, (nid, now - CO_HISTORY_S * 1000))]
            alerts = [alert_body(r, ing.st.nodes.get(r['node_id'])) for r in c.execute(ALERT_SQL + 'WHERE cleared_ts IS NULL ORDER BY event_seq')]
            eps = [episode_body(r, (ing.st.episodes[r['node_id']].motion_state if r['node_id'] in ing.st.episodes else 'no_response'))
                   for r in c.execute(EPISODE_SQL + "WHERE state IN ('OPEN', 'ACKNOWLEDGED') ORDER BY episode_id")]
        gap_on, gap_ack = port.banner_state('host_gap'); g = port.host_gap
        return dict(recovering=bool(port.recovering), monitoring_active=bool(port.monitoring_active),
                    session=dict(session_id=s['session_id'], started_ts=s['started_ts'], mode=s['mode'], session_label=s['session_label']),
                    roster=[dict(node_id=r['node_id'], alias=r['alias'], active=r['active']) for r in roster], nodes=nodes, open_alerts=alerts, open_episodes=eps, co_history_30m=hist,
                    banners=dict(base_offline=bool(self.base_offline()), logging_fault=bool(port.writer.logging_fault), host_gap=dict(gap_s=float(g['gap_s']), reason=g['reason']) if gap_on and gap_ack is None else None,
                                 host_power=str(self.host_power()), audio_fault=bool(self.audio_fault())), constants=dict(K.CONSTANTS))

class _Conn:
    """A read-only connection that closes at the end of a with block (sqlite3's own context manager commits and keeps the connection open)."""
    def __init__(self, c): self.c = c
    def __enter__(self): return self.c
    def __exit__(self, *a): self.c.close()
