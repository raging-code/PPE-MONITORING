"""services/recovery_run.py (P25-2, ADR 0037): start-up steps 11 to 13 of design 14.5, the part of recovery that wires services/recovery.py (P25-1) into a running host.
Runtime.recover() calls run(); serve.run_server starts it as a task after the 1 Hz driver, so the server and host_tick are up while it works (design: "the server and host_tick run during recovery").
Step 11 (event loop, in chunks): the Rebuilder of P25-1 replays the 30-minute window, STEP_CHUNK_ROWS rows per yield, and the 'loop' liveness stamp is touched after every chunk.
  500 rows, not the 2,000 of recovery.py and settings.json: a 2,000-row chunk blocks the loop for about 0.7 s on a fast machine, which is too close to the 3 s task_stall_s on a slower laptop (a stall is os._exit(1)).
  A lower replay_chunk_rows in settings.json is honoured; a higher one is not.
Step 12 (worker thread, no event-loop time): in this order
  (a) rejected_frames is restored: the latest COUNTERS row of the whole database plus the frames stored after it with verify != 'OK' (the 20/min storage cap would otherwise undercount);
  (b) the silence clock of every node of the rebuild is re-armed: P25-1 reset every timer, so without this a node that died during the outage has no clock, the engine never raises SIGNAL LOST or LINK LOST for it,
      and it would show 'unconfirmed' for ever. The clock starts at RECOVERING_EXIT: a node gets its full signal_lost_s (or link_lost_adverse_s) from there, so the gap alone still raises nothing;
  (c) RECOVERING_EXIT and, when an earlier row exists, HOST_GAP are logged, and the gap is measured from the last row the PREVIOUS process wrote (rows of this start-up, which begin_session wrote with the restart time, are excluded);
  (d) recovering=false (Startup, HostPort), the host_gap banner is set, and the next host_tick sends recovering=0 (offered at once as well).
  A rebuild that failed does not keep the host in RECOVERING: that would hold every live frame in a queue that never drains. The error is in the detail of RECOVERING_EXIT.
Step 13 (worker thread): the pre-replay queue is released in arrival order through the normal pipeline (PreReplayGate.release); live frames queue behind it.
Afterwards (worker thread, off the event loop): PRAGMA integrity_check on a read-only connection, logged as INTEGRITY_OK or INTEGRITY_FAIL.
Nodes that have no fresh frame yet show 'not_connected' (Wire.unconfirmed): the wire contract has no 'unconfirmed (host gap)' link state (open point of ADR 0037).
Nothing here is allowed to leave the host stuck: every stage is guarded and RECOVERING always ends. Only cancellation (shutdown) passes through."""
import asyncio, json, logging
from dataclasses import dataclass, replace
from . import recovery as RC
from ..io.db_writer import connect_db

log = logging.getLogger('ppe.recovery_run')
STEP_CHUNK_ROWS = 500


@dataclass
class RunReport:
    rebuild: object = None            # services.recovery.RebuildReport
    error: str = None                 # the failure of the rebuild, if any (the host leaves RECOVERING anyway)
    rejected_restored: int = 0        # added to the Ingest's rejected_frames
    rearmed: tuple = ()               # nodes whose silence clock was started at RECOVERING_EXIT
    gap_from_ts: int = None           # rx or row timestamp of the last row of the previous process (None: no earlier row, no HOST_GAP)
    gap_ms: int = None
    released: int = 0                 # queued frames fed to the pipeline (step 13)
    integrity: str = None             # 'ok', or the first lines of a failed integrity_check
    done: bool = False


def _json(d): return json.dumps(d, sort_keys=True, separators=(',', ':'))


def restored_rejects(conn):
    """Design section 1 (e): rejected_frames = the value in the latest COUNTERS row (system_events, every session) + the frames stored after that row with verify != 'OK'. The frames after the row are found
    from the newest frame older than it, walking back from the end by frame_id (a minute of rows, not the table); with no COUNTERS row (or an unusable one) every stored non-OK frame counts."""
    base, seq = 0, 0
    r = conn.execute("SELECT event_seq, detail FROM system_events WHERE kind = 'COUNTERS' ORDER BY id DESC LIMIT 1").fetchone()
    if r is not None:
        try: base, seq = max(0, int(json.loads(r[1])['rejected_frames'])), r[0]
        except (TypeError, ValueError, KeyError): log.warning('latest COUNTERS row has no usable rejected_frames: counting every stored non-OK frame'); base, seq = 0, 0
    f = conn.execute('SELECT frame_id FROM frames WHERE event_seq < ? ORDER BY frame_id DESC LIMIT 1', (seq,)).fetchone()
    after = conn.execute("SELECT COUNT(*) FROM frames WHERE frame_id > ? AND verify != 'OK'", (f[0] if f else 0,)).fetchone()[0]
    return base + after


def last_committed_ts(conn):
    """The newest timestamp among the rows the PREVIOUS process wrote, or None when there is none (a new database). Same sources as main.last_row_ts (frames, alerts raised and cleared,
    audit_events, system_events, session start), over all sessions. Rows of this start-up are left out by event_seq: begin_session wrote HOST_START (and before it SESSION_ABANDONED when it closed a session)
    with the restart time, so counting them would make every gap zero."""
    h = conn.execute("SELECT event_seq, ts FROM system_events WHERE kind = 'HOST_START' ORDER BY id DESC LIMIT 1").fetchone()
    if h is None: return None
    bound, start_ts = h
    if conn.execute("SELECT 1 FROM system_events WHERE event_seq = ? AND kind = 'SESSION_ABANDONED' AND ts = ?", (bound - 1, start_ts)).fetchone(): bound -= 1
    qs = ('SELECT COALESCE((SELECT rx_ts FROM frames WHERE event_seq < ? ORDER BY frame_id DESC LIMIT 1), 0)',            # frame_id grows with arrival: the newest frame is one step from the end
          'SELECT COALESCE(MAX(raised_ts), 0) FROM alerts WHERE event_seq < ?',
          'SELECT COALESCE(MAX(cleared_ts), 0) FROM alerts WHERE cleared_event_seq < ?',
          'SELECT COALESCE(MAX(ts), 0) FROM audit_events WHERE event_seq < ?',
          'SELECT COALESCE((SELECT ts FROM system_events WHERE event_seq < ? ORDER BY id DESC LIMIT 1), 0)')
    best = max(conn.execute(q, (bound,)).fetchone()[0] for q in qs)
    best = max(best, conn.execute('SELECT COALESCE(MAX(started_ts), 0) FROM sessions WHERE started_ts < ?', (start_ts,)).fetchone()[0])
    return best or None


def rearm_silence(ingest, nodes, now_mono):
    """Start the silence clock (last_fresh_mono) of each of `nodes` that has none. Returns the node ids changed. Under the Ingest's lock, so a tick sees the old or the new state, never half."""
    with ingest._lock:
        st = ingest.st; changed = {nid: replace(n, last_fresh_mono=now_mono) for nid, n in st.nodes.items() if nid in nodes and n.last_fresh_mono is None}
        if changed: ingest.st = replace(st, nodes={**st.nodes, **changed})
    return tuple(sorted(changed))


def _readonly(rt): return connect_db(rt.st.db_path, readonly=True)


def _finish(rt, rep, t0):
    """Step 12 (a to d). Runs in a worker thread. The flags are set in a finally: nothing above may keep the host in RECOVERING."""
    ing, port, wire, rb = rt.ingest, rt.port, rt.wire, rep.rebuild
    conn = None
    try:
        try: conn = _readonly(rt)
        except Exception: log.exception('step 12: cannot open the database to read the totals'); conn = None
        if conn is not None:
            try:                                                                          # (a)
                n = restored_rejects(conn)
                with ing._lock: ing.counters['rejected_frames'] += n
                rep.rejected_restored = n
            except Exception: log.exception('step 12: rejected_frames not restored')
            try: rep.gap_from_ts = last_committed_ts(conn)
            except Exception: log.exception('step 12: the start of the gap is unknown'); rep.gap_from_ts = None
        exit_ts, mono = rt.clock.wall_ms(), rt.clock.mono_ms()
        try: rep.rearmed = rearm_silence(ing, rb.nodes if rb is not None else (), mono)    # (b)
        except Exception: log.exception('step 12: silence clocks not re-armed')
        detail = dict(frames=rb.frames if rb else 0, skipped=rb.skipped if rb else 0, chunks=rb.chunks if rb else 0, nodes=sorted(rb.nodes) if rb else [], rearmed=list(rep.rearmed),
                      rejected_restored=rep.rejected_restored, ms=max(0, mono - t0), error=rep.error)
        try:                                                                              # (c)
            ing.system_event('RECOVERING_EXIT', _json(detail), droppable=False)
            if rep.gap_from_ts is not None:
                rep.gap_ms = max(0, exit_ts - rep.gap_from_ts)
                ing.system_event('HOST_GAP', _json(dict(gap_s=rep.gap_ms / 1000.0, from_ts=rep.gap_from_ts, to_ts=exit_ts)), droppable=False)
        except Exception: log.exception('step 12: RECOVERING_EXIT or HOST_GAP not logged')
    finally:                                                                              # (d)
        if conn is not None: conn.close()
        if port is not None:
            if rep.gap_ms is not None: port.set_host_gap(rep.gap_ms / 1000.0, (port.host_gap or {}).get('reason'))       # a restored database keeps its reason (db_restored)
            port.set_recovering(False)
        rt.st.recovering = False
        for name, fn in (('host_tick', rt.offer_tick), ('audio', rt.audio_refresh), ('wire', (lambda: (wire._links(), wire._system(), wire._changed())) if wire is not None else (lambda: None))):
            try: fn()
            except Exception: log.exception('step 12: %s not refreshed', name)
    log.info('step 12: RECOVERING_EXIT, gap %s, %d silence clock(s) re-armed, %d rejected frame(s) restored', 'none' if rep.gap_ms is None else '%.1f s' % (rep.gap_ms / 1000.0), len(rep.rearmed), rep.rejected_restored)


async def run(rt, chunk=None):
    """Steps 11 to 13 for a Runtime that has finished steps 1 to 10 (Runtime.recover). Returns the RunReport. Cancellation (shutdown) is passed on; any other failure is logged and the host still leaves RECOVERING."""
    rep, t0, wire = RunReport(), rt.clock.mono_ms(), rt.wire
    if chunk is None:
        try: chunk = max(1, min(int(rt.st.settings['replay_chunk_rows']), STEP_CHUNK_ROWS))
        except Exception: chunk = STEP_CHUNK_ROWS
    if wire is not None and hasattr(wire, 'unconfirmed'): wire.unconfirmed.update(rt.ingest.roster)       # every node is grey until its first fresh frame (design: 'unconfirmed (host gap)')
    lv = getattr(rt, 'liveness', None)
    try:
        rb = RC.Rebuilder(rt.ingest, rt.st.conn, rt.clock, chunk=chunk); rep.rebuild = rb.report
        await rb.run_async(on_chunk=(lambda: lv.stamp('loop')) if lv is not None else None)               # step 11
    except asyncio.CancelledError: raise
    except Exception as e: rep.error = '%s: %s' % (type(e).__name__, e); log.exception('step 11: the rebuild failed; leaving RECOVERING without it')
    try: await asyncio.to_thread(_finish, rt, rep, t0)                                                     # step 12
    except asyncio.CancelledError: raise
    except Exception:
        log.exception('step 12 failed'); rt.st.recovering = False
        if rt.port is not None: rt.port.set_recovering(False)
    try: rep.released = await asyncio.to_thread(rt.release)                                                # step 13
    except asyncio.CancelledError: raise
    except Exception: log.exception('step 13: the queue could not be released')
    rep.done = True
    box = []
    def check():
        conn = _readonly(rt); box.append(conn)
        try: res = [r[0] for r in conn.execute('PRAGMA integrity_check')]
        finally: conn.close()
        return 'ok' if res == ['ok'] else '; '.join(str(x) for x in res[:3])
    try:
        rep.integrity = await asyncio.to_thread(check)
        rt.ingest.system_event('INTEGRITY_OK' if rep.integrity == 'ok' else 'INTEGRITY_FAIL', 'integrity_check: ' + rep.integrity, droppable=False)
    except asyncio.CancelledError:
        for c in box:
            try: c.interrupt()                                                                              # shutdown must not wait for a long integrity_check
            except Exception: pass
        raise
    except Exception: log.exception('integrity_check could not run')
    return rep
