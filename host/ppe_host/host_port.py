"""host_port.py (P24-3b-1): the host's side of the REST Port (api/api_rest.py) and of the audit and drop hooks of the WebSocket Source (api/ws_hub.py).
Not in the 14.5 file list: ADR 0031 (Proposed) explains why it is a new top-level module next to main.py. It owns no thread and no socket; every method runs on the event loop
(end_session, which the route awaits in a worker thread, is P25). Every database write goes through Ingest (one ordered writer queue, one event_seq counter); the reads are
short indexed look-ups on a read-only connection. Acknowledge and Resolve go through step() (Ingest.operator), so the engine and the rows never disagree.
Not here: the snapshot and the WebSocket messages (P24-3b-2, which plugs into publish), end_session and close_session (P25), loading open alerts and episodes into the engine (P24-3c)."""
from .api import security as sec
from .core.rule_engine import AckAlertEvent, AckEpisodeEvent, AlertAcknowledged, EpisodeAcknowledged, EpisodeResolved, ResolveEpisodeEvent
from .io.db_writer import Stmt, connect_db, load_scba_corrections

BANNERS = ('host_gap', 'logging_fault')   # the two banners an operator may acknowledge (design 3.8)

class HostPort:
    def __init__(self, ingest, db_path, settings, auth, publish=None, recovering=True, host_gap=None):
        """publish(effects, unit, committed) is called after the commit wait of every operator action (committed: True, False, or None when nothing was written); P24-3b-2 turns it into messages.
        host_gap is None or {'gap_s': float, 'reason': str or None}; P25 sets the real gap with set_host_gap."""
        self.ing, self.writer, self.db_path, self.settings, self.auth, self.publish = ingest, ingest.writer, db_path, settings, auth, publish
        self.recovering, self.host_gap, self.banner_ack = recovering, host_gap, {}
        c = connect_db(db_path, readonly=True)
        try:
            self.monitoring_active = bool(c.execute('SELECT monitoring_active FROM sessions WHERE session_id = ?', (ingest.session_id,)).fetchone()[0])
            self.scba = load_scba_corrections(c)   # {node_id: (recorded_ts, operator name)}, display state only
        finally: c.close()

    @classmethod
    def from_startup(cls, st, ingest, **kw):
        """The Port of a started host (main.Startup after begin_session). A restored database shows the host_gap banner with reason db_restored; its gap_s is 0.0 until P25 measures it."""
        salt = sec.load_or_create_salt(st.settings.home, True)   # start-up step 5 already created or checked it
        gap = {'gap_s': 0.0, 'reason': st.host_gap_reason} if st.host_gap_reason else None
        return cls(ingest, st.db_path, st.settings, sec.Authenticator(st.db_path, salt, st.settings['login_backoff_cap_s']), host_gap=gap, recovering=st.recovering, **kw)

    def _q(self, sql, args=()):
        c = connect_db(self.db_path, readonly=True)
        try: return c.execute(sql, args).fetchall()
        finally: c.close()
    def _done(self, effects, unit):
        ok = self.writer.wait(unit, self.ing.commit_wait_ms) if unit is not None else None   # commit before broadcast, within commit_wait_ms (design 1)
        if self.publish and effects: self.publish(effects, unit, ok)
        return ok
    def _conflict(self, why):
        from .api.api_rest import ApiError
        return ApiError(409, 'STATE_CONFLICT', why)

    # ---- Source and Port: identity, audit, drops ----
    def authenticate(self, token): return self.auth.authenticate(token)
    def login_failed(self): return self.auth.login_failed()
    def login_ok(self): self.auth.login_ok()
    def session_id(self): return self.ing.session_id
    def recovering_retry_s(self): return self.settings['recovering_target_s'] if self.recovering else None
    def set_recovering(self, on): self.recovering = bool(on)
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None):
        """One audit_events row in the current session. A row with an operator is an operator action and commits with synchronous=FULL."""
        self.ing.audit(action, operator_id, node_id, episode_id, reason, durable=operator_id is not None)
    def client_dropped(self, detail): self.ing.system_event('CLIENT_DROPPED', detail)

    # ---- sessions ----
    def start_monitoring(self, operator_id, session_label):
        """Idempotent: the first call sets monitoring_active, the operator and the label (each only while NULL); a second call changes nothing and returns changed=False."""
        from .api.api_rest import SessionRow
        sid = self.ing.session_id; started, mode = self._q('SELECT started_ts, mode FROM sessions WHERE session_id = ?', (sid,))[0]; row = SessionRow(sid, started, mode)
        if self.monitoring_active: return row, False
        self.monitoring_active = True
        self._done((), self.ing.write([Stmt('UPDATE sessions SET monitoring_active = 1, operator_id = COALESCE(operator_id, ?), session_label = COALESCE(session_label, ?) WHERE session_id = ?',
                                            (operator_id, session_label, sid))], durable=True))
        return row, True
    def end_session(self, session_id, operator_id): raise NotImplementedError('close_session(ENDED) and the backup are P25 (design 2.11)')

    # ---- Acknowledge and Resolve ----
    def ack_alert(self, alert_id, operator_id):
        """An alert the engine still holds goes through step() (an unauth_alert closes with it, GV-10); a cleared alert, or one the engine does not hold, gets a direct row update.
        A repeat returns the first acknowledgement. None for an unknown id."""
        from .api.api_rest import AlertAck
        r = self._q('SELECT node_id, type, event_seq, acknowledged_ts, acknowledged_by FROM alerts WHERE alert_id = ?', (alert_id,))
        if not r: return None
        node, typ, eseq, ts, by = r[0]
        if ts is not None: return AlertAck(alert_id, node, ts, by)
        live = self.ing.st.alerts.get((node, typ))
        if live is not None and live.event_seq == eseq:
            fx, u = self.ing.operator(AckAlertEvent(node, typ, operator_id)); self._done(fx, u)
            ts = next((e.ts for e in fx if isinstance(e, AlertAcknowledged) and e.raised_event_seq == eseq), live.acknowledged_ts or self.ing.clock.wall_ms())
        else:
            ts = self.ing.clock.wall_ms()
            self._done((), self.ing.write([Stmt('UPDATE alerts SET acknowledged_ts = ?, acknowledged_by = ? WHERE alert_id = ? AND acknowledged_ts IS NULL', (ts, operator_id, alert_id))], durable=True))
        return AlertAck(alert_id, node, ts, operator_id)

    def _episode(self, episode_id):
        r = self._q('SELECT node_id, state, acknowledged_ts, acknowledged_by FROM episodes WHERE episode_id = ?', (episode_id,))
        if r and r[0][1] == 'RESOLVED': raise self._conflict('episode is already resolved')
        return r[0] if r else None
    def ack_episode(self, episode_id, operator_id):
        from .api.api_rest import EpisodeAck
        r = self._episode(episode_id)
        if r is None: return None
        node, state, ts, by = r
        if state == 'ACKNOWLEDGED': return EpisodeAck(episode_id, node, ts, by)
        fx, u = self.ing.operator(AckEpisodeEvent(node, operator_id)); self._done(fx, u)
        e = next((x for x in fx if isinstance(x, EpisodeAcknowledged)), None)
        if e is not None: return EpisodeAck(episode_id, node, e.ts, operator_id)
        live = self.ing.st.episodes.get(node)   # acknowledged a moment ago and not committed yet: the engine already knows
        if live is not None and live.state == 'ACKNOWLEDGED': return EpisodeAck(episode_id, node, live.acknowledged_ts, live.acknowledged_by)
        raise self._conflict('episode is not live in the engine')   # P24-3c loads the open episodes at start-up
    def resolve_episode(self, episode_id, reason, operator_id):
        from .api.api_rest import EpisodeResolve
        r = self._episode(episode_id)
        if r is None: return None
        node = r[0]; fx, u = self.ing.operator(ResolveEpisodeEvent(node, reason, operator_id)); self._done(fx, u)
        e = next((x for x in fx if isinstance(x, EpisodeResolved)), None)
        if e is None: raise self._conflict('episode is not live in the engine')
        latched = bool(getattr(self.ing.st.nodes.get(node), 'mandown_prev', False))   # the jacket latch is cleared only on the jacket (14.1)
        return EpisodeResolve(episode_id, node, e.ts, reason, operator_id, latched)

    # ---- SCBA correction and banners ----
    def set_scba_correction(self, node_id, note, operator_id):
        """Live display state only (never an engine input). None for a node outside the roster. The audit row is written by the route."""
        from .api.api_rest import ScbaRecord
        if node_id not in self.ing.roster: return None
        name = (self._q('SELECT display_name FROM operators WHERE operator_id = ?', (operator_id,)) or [('',)])[0][0]
        self.scba[node_id] = (self.ing.clock.wall_ms(), name); return ScbaRecord(*self.scba[node_id])
    def set_host_gap(self, gap_s, reason=None):
        self.host_gap = {'gap_s': gap_s, 'reason': reason}; self.banner_ack.pop('host_gap', None)   # a new gap is a new banner
    def banner_state(self, kind):
        """(active, acknowledged_ts). host_gap is active while a gap is recorded, logging_fault while the writer is in fault; an acknowledgement ends with the condition."""
        active = self.host_gap is not None if kind == 'host_gap' else bool(self.writer.logging_fault) if kind == 'logging_fault' else False
        if not active: self.banner_ack.pop(kind, None)
        return active, self.banner_ack.get(kind)
    def ack_banner(self, kind, operator_id):
        from .api.api_rest import BannerAck
        active, ts = self.banner_state(kind)
        if not active: raise self._conflict('banner is not active')
        if ts is not None: raise self._conflict('banner is already acknowledged')   # design 3.8 error-code list (ADR 0011)
        self.banner_ack[kind] = self.ing.clock.wall_ms(); return BannerAck(kind, self.banner_ack[kind])
