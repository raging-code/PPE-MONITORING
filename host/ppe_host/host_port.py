"""host_port.py (P24-3b-1): the host's side of the REST Port (api/api_rest.py) and of the audit and drop hooks of the WebSocket Source (api/ws_hub.py).
Not in the 14.5 file list: ADR 0031 (Proposed) explains why it is a new top-level module next to main.py. It owns no thread and no socket; every method runs on the event loop
(end_session, which the route awaits in a worker thread, is P25-3: close_session('ENDED'), then the backup). Every database write goes through Ingest (one ordered writer queue, one event_seq counter); the reads are
short indexed look-ups on a read-only connection. Acknowledge and Resolve go through step() (Ingest.operator), so the engine and the rows never disagree.
The snapshot and the WebSocket messages are wire.py (P24-3b-2a), which plugs into publish. Loading open alerts and episodes into the engine is Runtime.load_open (P24-3c); close_session is services/sessions.py (P25-3)."""
import threading
from pathlib import Path
from .api import pin_auth, security as sec
from .core.rule_engine import AckAlertEvent, AckEpisodeEvent, AlertAcknowledged, EpisodeAcknowledged, EpisodeResolved, ResolveEpisodeEvent
from .io.db_writer import Stmt, connect_db, load_scba_corrections

END_COMMIT_WAIT_MS = 10_000   # P25-3: how long End shift waits for the ENDED unit to commit (a worker thread waits, not the event loop)
BANNERS = ('host_gap', 'logging_fault')   # the two banners an operator may acknowledge (design 3.8)

class HostPort:
    wire = None   # set by wire.Wire.attach() (P24-3b-2a)
    replay = None   # S7-5a: the ReplayThread of a REPLAY host (serve.build_app sets it), else None
    def __init__(self, ingest, db_path, settings, auth, publish=None, recovering=True, host_gap=None):
        """publish(effects, unit, committed) is called after the commit wait of every operator action (committed: True, False, or None when nothing was written); P24-3b-2 turns it into messages.
        host_gap is None or {'gap_s': float, 'reason': str or None}; P25 sets the real gap with set_host_gap."""
        self.ing, self.writer, self.db_path, self.settings, self.auth, self.publish = ingest, ingest.writer, db_path, settings, auth, publish
        self.recovering, self.host_gap, self.banner_ack = recovering, host_gap, {}
        self._end_lock = threading.Lock()   # P25-3: two End shift calls (two tabs) run one after the other; the second finds a different open session and gets STATE_CONFLICT
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
        return cls(ingest, st.db_path, st.settings, sec.Authenticator(st.db_path, salt, st.settings['login_backoff_cap_s'], now_ms=ingest.clock.wall_ms), host_gap=gap, recovering=st.recovering, **kw)

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
    # ---- P28-4a (ADR 0056): PIN login, login sessions, logout. They block (scrypt, the commit wait): the routes run them in a worker thread. api/pin_auth.py plans the statements, Ingest.write queues them in order. ----
    def pin_login(self, display_name, pin):
        """The PinResult for display name + PIN. The failure count and the lock go through the writer as one durable unit that is committed before the answer, so a restart does not forget a failure."""
        row = self._q(pin_auth.LOGIN_SQL, (display_name,)) if isinstance(display_name, str) else []
        r, stmts = pin_auth.plan_login(row[0] if row else None, pin, self.ing.clock.wall_ms())
        if stmts: self._done(None, self.ing.write([Stmt(s, p) for s, p in stmts], durable=True))   # a failed write is counted by the writer (write_rejected); the answer stands
        return r
    def start_login_session(self, operator_id, remember):
        """(session_token, expires_ts). The row is committed before the token leaves the host, so the next request with it is accepted; RuntimeError (a 500) if it could not be written."""
        token, expires, stmt = pin_auth.plan_session(self.auth.salt, operator_id, remember, self.ing.clock.wall_ms(), self.settings.get('session_hours', sec.DEFAULT_SESSION_HOURS))
        if self._done(None, self.ing.write([Stmt(*stmt)], durable=True)) is not True: raise RuntimeError('the login session could not be written')
        return token, expires
    def logout(self, token):
        """True if a login session was revoked; False for an operator token, an unknown token or a session that is already revoked (nothing is written then)."""
        if not self._q('SELECT 1 FROM login_sessions WHERE token_hash = ? AND revoked_ts IS NULL', (sec.hash_token(self.auth.salt, token),)): return False
        self._done(None, self.ing.write([Stmt(*pin_auth.revoke_stmt(self.auth.salt, token, self.ing.clock.wall_ms()))], durable=True)); return True
    def session_id(self): return self.ing.session_id
    def snapshot(self):
        """The hub's Source.snapshot (P24-3b-2a): built by wire.Wire, which attach() plugs in."""
        if self.wire is None: raise RuntimeError('no Wire attached: build wire.Wire(port, hub).attach() first')
        return self.wire.snapshot()
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
    def end_session(self, session_id, operator_id):
        """POST /api/session/end (design 3.8, 2.3, 2.11), run in a worker thread by the route. close_session('ENDED') is one atomic unit: the END_SHIFT audit row in the old session (its reason lists the open alerts, open episodes
        and latched nodes), then ended_ts and end_kind='ENDED', then the new session with monitoring_active carried. Open alerts and episodes are not touched: same ids, no clone, no new chime.
        Then the online backup (io/backup.py) and a BACKUP_OK or BACKUP_FAIL system row in the new session; with second_drive_dir set, the verified backup is copied there (P26-3, ADR 0040) with a second row whose detail starts
        'second drive: '; the full integrity_check of the live database follows (INTEGRITY_OK or INTEGRITY_FAIL, detail 'integrity_check at session end: ...'). backup_ok is False when the backup, its verification or the second copy
        failed (an integrity failure has its own row); the shift is closed anyway.
        STATE_CONFLICT when session_id is not the open session (a second tab) changes nothing and makes no backup. 500 INTERNAL_ERROR when the unit was rolled back (the old session stays open) or did not commit in time."""
        from .api.api_rest import ApiError, EndResult
        from .io import backup as bk
        from .services import sessions as ses
        with self._end_lock:
            old = self.ing.session_id
            if session_id != old: raise self._conflict('session_id is not the open session')
            new = ses.next_session_id(self._q)
            latched = [n for n, s in sorted(self.ing.st.nodes.items()) if getattr(s, 'mandown_prev', False)]
            unit = self.ing.close_session('ENDED', operator_id, ses.end_shift_detail(self._q, latched), new)
            committed = self.writer.wait(unit, END_COMMIT_WAIT_MS)
            if unit.failed: self.ing.undo_end(old, new)
        if unit.failed: raise ApiError(500, 'INTERNAL_ERROR', 'End shift was rolled back; the shift is still open')
        if not committed: raise ApiError(500, 'INTERNAL_ERROR', 'End shift is queued but has not committed yet; reload the page')   # the unit stays queued and commits when the disk answers
        now = self.ing.clock.wall_ms()
        try:
            dest = bk.online_backup(self.db_path, Path(self.settings.path('backup_dir')) / bk.backup_name('end-shift', now)); good, why = bk.verify_backup(dest)
        except Exception as e: dest, good, why = None, False, '%s: %s' % (type(e).__name__, e)
        self.ing.system_event('BACKUP_OK' if good else 'BACKUP_FAIL', dest.name if good else why, droppable=False)
        drive = bk.second_drive_dir(self.settings); both = good
        if drive is not None:
            try:
                if not good: raise OSError('no verified local backup to copy')
                copy = bk.copy_to_second_drive(dest, drive, Path(self.settings.path('backup_dir'))); self.ing.system_event('BACKUP_OK', 'second drive: %s' % copy, droppable=False)
            except Exception as e: both = False; self.ing.system_event('BACKUP_FAIL', 'second drive: %s: %s' % (type(e).__name__, e), droppable=False)
        try: ok, detail = bk.integrity_check(self.db_path)
        except Exception as e: ok, detail = False, '%s: %s' % (type(e).__name__, e)
        self.ing.system_event('INTEGRITY_OK' if ok else 'INTEGRITY_FAIL', 'integrity_check at session end: ' + detail, droppable=False)
        return EndResult(old, new, both)

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
            self._done((AlertAcknowledged(0, node, typ, eseq, operator_id, ts),), self.ing.write([Stmt('UPDATE alerts SET acknowledged_ts = ?, acknowledged_by = ? WHERE alert_id = ? AND acknowledged_ts IS NULL', (ts, operator_id, alert_id))], durable=True))   # the effect only tells the Wire which row to send (event_seq 0 is never stored)
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
    # ---- REPLAY pause (S7-5a, ADR 0061) ----
    def replay_set_paused(self, paused):
        """Pause or resume the replay. Not a toggle: asking for the state it has changes nothing (changed False). STATE_CONFLICT on a host that is not replaying and on a replay that has
        finished (its clock stays frozen). Runs on the event loop and never blocks; the audit row is written by the route."""
        from .api.api_rest import ReplayState
        r = self.replay
        if r is None: raise self._conflict('this host is not replaying a session')
        if r.finished.is_set(): raise self._conflict('the replay has finished')
        paused = bool(paused); changed = r.paused != paused
        if changed:
            r.pause() if paused else r.resume()
            if self.wire is not None: self.wire.on_replay_changed()   # the system message, at once
        return ReplayState(r.paused, r.finished.is_set(), changed)
    def ack_banner(self, kind, operator_id):
        from .api.api_rest import BannerAck
        active, ts = self.banner_state(kind)
        if not active: raise self._conflict('banner is not active')
        if ts is not None: raise self._conflict('banner is already acknowledged')   # design 3.8 error-code list (ADR 0011)
        self.banner_ack[kind] = self.ing.clock.wall_ms()
        if self.wire is not None: self.wire.on_banner_acknowledged(kind, self.banner_ack[kind])   # P24-3b-2b-i: the BANNER_ACK system message
        return BannerAck(kind, self.banner_ack[kind])
