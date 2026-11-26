// patches/part24_3b2a_wire.mjs  (run from repo root: node patches/part24_3b2a_wire.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
const putB64 = (p, b64) => put(p, Buffer.from(b64, 'base64').toString('utf8'));
const replace = (p, oldStr, newStr) => plan.push({ op: 'replace', p, oldStr, newStr });
const append = (p, text) => plan.push({ op: 'append', p, text });
function apply() {
  const state = new Map(), log = [];
  const get = (p) => state.has(p) ? state.get(p) : (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && cur !== s.content && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : cur === s.content ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) {
      throw new Error(`MISSING file: ${s.p}`);
    } else if (s.op === 'replace') {
      const n = cur.split(s.oldStr).length - 1;
      if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
      else if (n === 0 && cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else throw new Error(`ANCHOR found ${n} times in ${s.p}: ${s.oldStr.slice(0, 60)}`);
    } else if (s.op === 'append') {
      if (cur.includes(s.text)) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : '\n') + s.text); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : `OK: ${state.size} file(s) written`);
}
try { await run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }

// ---- write only this part below ----
async function run() {
  put("host/ppe_host/wire.py", String.raw`"""wire.py (P24-3b-2a): the dashboard messages of design 3.8 built from what the engine and the writer did, and the snapshot. Not in the 14.5 file list: ADR 0032 (Proposed).
Wire turns Ingested frames and operator effects into reading, alert and episode bodies and hands them to the Hub (api/ws_hub.py: publish_reading, publish_alert, publish_episode;
the hub adds v, srv_seq and srv_ts). Commit before broadcast (design 1): an alert or episode message is built only after its unit committed, and its body is read back from the
committed row, so the alert_id is always the database id the REST Acknowledge uses. A unit that did not commit within commit_wait_ms is held in pending and sent by flush();
a row the writer rejected has no id, so no message is sent and its event_seq goes into unpersisted (ADR 0032: the wire has no unpersisted field yet, which needs a decision).
Not here (P24-3b-2b): link, system and advisory messages. No thread, no socket; every method runs on the event loop."""
import sqlite3
from collections import deque
from . import abi, constants as K
from .core.rule_engine import (AlertAcknowledged, ChangeAlertLevel, ClearAlert, EpisodeAcknowledged, EpisodeEscalated, EpisodeLabelChanged, EpisodeOpened, EpisodeResolved,
                               NodeState, RaiseAlert)
from .io.db_writer import connect_db

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
        with self._conn() as c: self.alias = {r['node_id']: r['alias'] for r in c.execute('SELECT node_id, alias FROM roster')}

    def attach(self):
        """Plug in: operator effects (HostPort.publish), frames (Ingest.broadcast) and HostPort.snapshot (the Hub's Source)."""
        self.port.publish, self.port.wire, self.ing.broadcast = self.on_effects, self, self.on_frame; return self
    def _conn(self):
        c = connect_db(self.port.db_path, readonly=True); c.row_factory = sqlite3.Row; return _Conn(c)

    # ---- incremental messages ----
    def on_frame(self, out):
        """The Ingest.broadcast hook: one reading for a verified frame, then the alert and episode messages of its effects."""
        if out.ctx is not None: self.hub.publish_reading(reading_body(out.ctx, self.alias.get(out.ctx['node'], '')))
        self.on_effects(out.effects, out.unit, out.committed)
    def on_effects(self, fx, unit, ok):
        """The HostPort.publish hook. ok is True (committed), False (not within commit_wait_ms: held in pending) or None (nothing was written)."""
        if not fx: return
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

    def _send(self, fx):
        with self._conn() as c:
            keys = {(e.event_seq if isinstance(e, RaiseAlert) else e.raised_event_seq) for e in fx if isinstance(e, ALERT_FX)}
            rows = {r['event_seq']: r for r in c.execute(ALERT_SQL + 'WHERE event_seq IN (%s)' % ','.join('?' * len(keys)), tuple(keys))} if keys else {}
            eps = {n: c.execute(EPISODE_SQL + 'WHERE node_id = ? ORDER BY episode_id DESC LIMIT 1', (n,)).fetchone() for n in {e.node_id for e in fx if isinstance(e, EPISODE_FX)}}
        for e in fx:
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

    # ---- snapshot ----
    def snapshot(self):
        """Every SnapshotMsg field except v, type, srv_seq, srv_ts and epoch (the Hub adds those). Read from the committed rows plus the engine state, on the event loop."""
        ing, port = self.ing, self.port; nodes, hist, now = [], {}, ing.clock.wall_ms()
        with self._conn() as c:
            s = c.execute('SELECT session_id, started_ts, mode, session_label FROM sessions WHERE session_id = ?', (ing.session_id,)).fetchone()
            roster = c.execute('SELECT node_id, alias, active FROM roster ORDER BY node_id').fetchall()
            for r in roster:
                nid = r['node_id']; f = c.execute(FRAME_SQL, (nid,)).fetchone(); ns = ing.st.nodes.get(nid); heard = f is not None
                link = 'not_connected' if ns is None else 'link_lost' if (nid, 'link_lost') in ing.st.alerts else 'signal_lost' if (nid, 'signal_lost') in ing.st.alerts else 'ok'
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
`);
  put("host/tests/test_wire.py", String.raw`"""P24-3b-2a: wire.Wire (host/ppe_host/wire.py): reading, alert and episode messages built after the commit, held messages, unauth_alert repeats, and the snapshot (design 3.8).
Real DBWriter, database, HostPort and engine, a fake hub. Every body is checked against the WsMessage contract: with the real models when pydantic is installed, else against shared/ws.schema.json.
The REST routes and the real Hub are not run here (P24-3c wires them)."""
import json, threading, types, uuid
from pathlib import Path
import pytest
from ppe_host import constants as K
from ppe_host.core.rule_engine import EpisodeOpened, RaiseAlert
from ppe_host.wire import Wire
from test_effect_rows import by_type, wait
from test_gv_bytes import WRONG_KEY, pack
from test_host_port import port
from test_ingest import rows, send

SCHEMA = json.loads((Path(__file__).resolve().parents[2] / 'shared' / 'ws.schema.json').read_text(encoding='utf8'))['$defs']
def _ok(v, s):
    if '$ref' in s: return _ok(v, SCHEMA[s['$ref'].split('/')[-1]])
    if 'anyOf' in s: return any(_ok(v, x) for x in s['anyOf'])
    if 'const' in s and v != s['const']: return False
    if 'enum' in s and v not in s['enum']: return False
    t = s.get('type'); num = isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == 'integer' and not (isinstance(v, int) and not isinstance(v, bool)): return False
    if t == 'number' and not num: return False
    if t == 'string' and not isinstance(v, str): return False
    if t == 'boolean' and not isinstance(v, bool): return False
    if t == 'null' and v is not None: return False
    if num and (v < s.get('minimum', v) or v > s.get('maximum', v)): return False
    if t == 'array': return isinstance(v, list) and all(_ok(x, s['items']) for x in v) if 'items' in s else isinstance(v, list)
    if t == 'object':
        if not isinstance(v, dict): return False
        props, extra = s.get('properties', {}), s.get('additionalProperties', True)
        if any(k not in v for k in s.get('required', ())): return False
        return all(_ok(x, props[k]) if k in props else (extra is True or (isinstance(extra, dict) and _ok(x, extra))) for k, x in v.items())
    return True
def check(kind, body):
    """The body with its envelope must be a valid server message of that type."""
    msg = dict(body, v=1, type=kind, srv_seq=0, srv_ts=1, **({'epoch': str(uuid.uuid4())} if kind == 'snapshot' else {}))
    try: from ppe_host.api import models as M
    except ImportError: M = None
    if M is not None: M.parse_server(msg)
    else: assert _ok(msg, SCHEMA[{'reading': 'ReadingMsg', 'alert': 'AlertMsg', 'episode': 'EpisodeMsg', 'snapshot': 'SnapshotMsg'}[kind]]), (kind, msg)

class Hub:
    def __init__(self): self.sent = []
    def publish_reading(self, b): check('reading', b); self.sent.append(('reading', b))
    def publish_alert(self, b): check('alert', b); self.sent.append(('alert', b))
    def publish_episode(self, b): check('episode', b); self.sent.append(('episode', b))
def got(h, k): return [b for kk, b in h.sent if kk == k]
def wired(tmp_path, **kw):
    c, w, clock, ing, p = port(tmp_path); h = Hub(); return c, w, clock, ing, p, h, Wire(p, h, **kw).attach()

def test_a_verified_frame_gives_one_reading_with_raw_co_the_bits_and_the_engine_level(tmp_path):         # GV-01 (F-01)
    c, w, clock, ing, p, h, wire = wired(tmp_path); r = send(ing, clock, pack(seq=100, co_x10=520, flags=1, scba=1, posture=2, bat=77, motion_x100=4)); wait(w, r.unit)
    (b,) = got(h, 'reading'); assert r.ctx is not None and r.ctx['node'] == 1
    assert (b['node_id'], b['alias'], b['co_ppm'], b['temp_c'], b['hum_pct'], b['motion_g'], b['posture'], b['bat_pct'], b['scba'], b['mandown'], b['level'], b['seq_class']) == \
           (1, rows(c, 'SELECT alias FROM roster WHERE node_id = 1')[0]['alias'], 52.0, 25.0, 50, 0.04, 'HORIZONTAL', 77, 1, 0, 'WARNING', 'fresh')
    assert (b['rssi'], b['snr'], b['co_over_range'], b['co_validity'], b['co_reason'], b['stillness_s'], b['status2'], b['flags'], b['id_mode']) == (-68.5, 9.2, 0, 'VALID', None, 0.0, 0, 1, 0x49 | 0x20)
    assert isinstance(b['reasons'], list) and b['rx_ts'] == clock.wall_ms(); w.stop()

def test_a_duplicate_still_gives_a_reading_but_a_frame_that_fails_its_mac_with_no_claim_gives_nothing(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); raw = pack(seq=7); wait(w, send(ing, clock, raw).unit); r2 = send(ing, clock, raw); wait(w, r2.unit)
    assert [b['seq_class'] for b in got(h, 'reading')] == ['fresh', 'duplicate']
    n = len(h.sent); r3 = send(ing, clock, pack(seq=8, key=WRONG_KEY), base='BAD_MAC'); assert r3.ctx is None and len(h.sent) == n; w.stop()

def test_the_alert_message_carries_the_database_id_and_every_change_is_sent_after_its_commit(tmp_path):      # GV-01, GV-09
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1, co_x10=520, flags=1)).unit)
    (a,) = got(h, 'alert'); row = by_type(c, 'co_threshold')[0]
    assert (a['alert_id'], a['alert_type'], a['level'], a['authenticated'], a['cleared_ts'], a['acknowledged_ts'], a['unauth_count']) == (row['alert_id'], 'co_threshold', 'WARNING', 1, None, None, None)
    p.ack_alert(row['alert_id'], 1); a2 = got(h, 'alert')[-1]; assert (a2['alert_id'], a2['acknowledged_by']) == (row['alert_id'], 1) and a2['acknowledged_ts']
    wait(w, send(ing, clock, pack(seq=2, co_x10=2500, flags=2)).unit); a3 = got(h, 'alert')[-1]; assert (a3['alert_id'], a3['level'], a3['acknowledged_ts']) == (row['alert_id'], 'DANGER', None)   # escalation clears the acknowledgement
    w.stop()

def test_acknowledging_a_cleared_alert_sends_its_message_too(tmp_path):                                       # 3.8: also for an alert that already cleared
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1, co_x10=520, flags=1)).unit)
    for s in range(2, 20): wait(w, send(ing, clock, pack(seq=s, co_x10=0)).unit)
    row = by_type(c, 'co_threshold')[0]; assert row['cleared_ts'] is not None; p.ack_alert(row['alert_id'], 1); a = got(h, 'alert')[-1]
    assert (a['alert_id'], a['acknowledged_by']) == (row['alert_id'], 1) and a['cleared_ts'] == row['cleared_ts']; w.stop()

def test_episode_messages_open_acknowledge_and_resolve_with_the_operator_name(tmp_path):                         # GV-02, GV-20
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1, flags=6)).unit); eid = rows(c, 'SELECT episode_id FROM episodes')[0]['episode_id']
    (e,) = got(h, 'episode'); assert (e['episode_id'], e['kind'], e['state'], e['man_down_motion_state'], e['operator'], e['resolve_reason']) == (eid, 'MAN_DOWN', 'OPEN', 'no_response', None, None)
    md = [a for a in got(h, 'alert') if a['alert_type'] == 'man_down']; assert md and md[0]['episode_id'] == eid
    p.ack_episode(eid, 1); e = got(h, 'episode')[-1]; assert (e['state'], e['operator']) == ('ACKNOWLEDGED', 'Ana') and got(h, 'alert')[-1]['acknowledged_by'] == 1
    p.resolve_episode(eid, 'rescued', 1); e = got(h, 'episode')[-1]
    assert (e['state'], e['resolve_reason'], e['operator'], e['man_down_motion_state']) == ('RESOLVED', 'rescued', 'Ana', None) and any(a['alert_type'] == 'man_down' and a['cleared_ts'] for a in got(h, 'alert'))
    n = len(got(h, 'episode')); wire.on_effects([EpisodeOpened(10 ** 6, 1, 'MAN_DOWN', 12345)], None, None); assert len(got(h, 'episode')) == n      # an Opened row that was never stored does not repeat the old episode
    w.stop()

def test_a_mayday_upgrade_sends_the_episode_as_mayday_without_a_label(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1, flags=6)).unit); wait(w, send(ing, clock, pack(seq=2, flags=6, status4=16)).unit)
    e = got(h, 'episode')[-1]; assert (e['kind'], e['state'], e['man_down_motion_state']) == ('MAYDAY', 'OPEN', None); w.stop()

def test_a_unit_that_did_not_commit_in_time_is_held_and_sent_when_it_has_committed(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); r = send(ing, clock, pack(seq=1, co_x10=520, flags=1)); wait(w, r.unit); h.sent.clear()
    slow = types.SimpleNamespace(done=threading.Event()); wire.on_effects(r.effects, slow, False); wire.flush()
    assert got(h, 'alert') == [] and len(wire.pending) == 1
    slow.done.set(); wire.flush(); assert [a['alert_type'] for a in got(h, 'alert')] == ['co_threshold'] and not wire.pending; w.stop()

def test_an_alert_row_that_was_not_stored_sends_no_message_and_is_remembered(tmp_path):                        # Rev 3.36: unpersisted
    c, w, clock, ing, p, h, wire = wired(tmp_path); wire.on_effects([RaiseAlert(10 ** 6, 1, 'co_threshold', 'WARNING', '', 1)], None, True)
    assert got(h, 'alert') == [] and wire.unpersisted == {10 ** 6}; w.stop()

def test_unauth_alert_repeats_are_sent_from_the_tick_once_per_change(tmp_path):                                 # GV-04: a repeat has no effect, so the tick sends it
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=200, flags=6, node=2, key=WRONG_KEY), base='BAD_MAC').unit)
    (a,) = got(h, 'alert'); assert (a['alert_type'], a['node_id'], a['authenticated'], a['level'], a['unauth_count']) == ('unauth_alert', 2, 0, 'NONE', 1)
    wait(w, send(ing, clock, pack(seq=201, flags=6, node=2, key=WRONG_KEY), base='BAD_MAC').unit); assert len(got(h, 'alert')) == 1
    wire.tick(); assert [x['unauth_count'] for x in got(h, 'alert')] == [1, 2] and got(h, 'alert')[-1]['last_seen_ts'] == clock.wall_ms()
    wire.tick(); assert len(got(h, 'alert')) == 2; w.stop()

def test_the_tick_sends_the_alerts_of_the_silence_rules(tmp_path):                                              # GV-08
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1)).unit); clock.advance((K.SIGNAL_LOST_S + 1) * 1000); wire.tick()
    assert 'signal_lost' in [a['alert_type'] for a in got(h, 'alert')] and wire.snapshot()['nodes'][0]['link_state'] == 'signal_lost'; w.stop()

def test_the_snapshot_of_a_host_that_has_heard_nothing_is_valid_and_every_node_is_not_connected(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); s = wire.snapshot(); check('snapshot', s)
    assert [n['node_id'] for n in s['nodes']] == [1, 2, 3] and all(n['level'] is None and n['link_state'] == 'not_connected' and n['co_ppm'] is None and n['last_rx_ts'] is None for n in s['nodes'])
    assert (s['recovering'], s['monitoring_active'], s['open_alerts'], s['open_episodes'], s['co_history_30m']) == (True, False, [], [], {'1': [], '2': [], '3': []})
    assert s['banners'] == {'base_offline': False, 'logging_fault': False, 'host_gap': None, 'host_power': 'ac', 'audio_fault': False} and s['constants'] == K.CONSTANTS
    assert s['session']['session_id'] == 1 and s['session']['mode'] == 'LIVE' and [r['active'] for r in s['roster']] == [1, 1, 1]; w.stop()

def test_the_snapshot_after_traffic_has_values_open_items_chart_points_and_banners(tmp_path):                    # 3.8 snapshot, GV-02, GV-18
    c, w, clock, ing, p, h, wire = wired(tmp_path, base_offline=lambda: True); wait(w, send(ing, clock, pack(seq=1, co_x10=120, scba=1)).unit)
    raw = pack(seq=2, co_x10=130); wait(w, send(ing, clock, raw).unit); wait(w, send(ing, clock, raw).unit)                       # the duplicate adds no point
    wait(w, send(ing, clock, pack(seq=3, co_x10=140, status2=16)).unit)                                                              # a CO fault adds none either
    wait(w, send(ing, clock, pack(seq=4, co_x10=150, flags=6)).unit); p.set_scba_correction(1, 'x', 1); s = wire.snapshot(); check('snapshot', s); n = s['nodes'][0]
    assert (n['co_ppm'], n['temp_c'], n['hum_pct'], n['bat_pct'], n['scba'], n['mandown'], n['level'], n['link_state'], n['flags']) == (15.0, 25.0, 50, 80, 0, 1, 'DANGER', 'ok', 6)
    assert n['scba_correction'] == {'recorded_ts': clock.wall_ms(), 'operator': 'Ana'} and s['nodes'][1]['level'] is None
    assert [pt[1] for pt in s['co_history_30m']['1']] == [12.0, 13.0, 15.0] and s['co_history_30m']['2'] == []
    assert {a['alert_type'] for a in s['open_alerts']} >= {'man_down'} and [(e['kind'], e['state'], e['man_down_motion_state']) for e in s['open_episodes']] == [('MAN_DOWN', 'OPEN', 'no_response')]
    assert s['banners']['base_offline'] is True
    clock.advance(31 * 60 * 1000); assert wire.snapshot()['co_history_30m']['1'] == []; w.stop()

def test_the_host_gap_banner_leaves_the_snapshot_once_acknowledged_and_the_logging_fault_follows_the_writer(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); p.set_host_gap(12.5, 'db_restored'); check('snapshot', wire.snapshot()); assert wire.snapshot()['banners']['host_gap'] == {'gap_s': 12.5, 'reason': 'db_restored'}
    p.ack_banner('host_gap', 1); assert wire.snapshot()['banners']['host_gap'] is None
    w.logging_fault = True; assert wire.snapshot()['banners']['logging_fault'] is True; p.ack_banner('logging_fault', 1); assert wire.snapshot()['banners']['logging_fault'] is True; w.stop()

def test_a_port_with_no_wire_cannot_make_a_snapshot(tmp_path):
    c, w, clock, ing, p = port(tmp_path)
    with pytest.raises(RuntimeError): p.snapshot()
    w.stop()

def test_the_contract_check_refuses_a_body_with_an_extra_key_a_missing_key_or_a_wrong_value(tmp_path):         # the check itself must be able to fail
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1, co_x10=520, flags=1)).unit); a = got(h, 'alert')[0]
    for bad in (dict(a, extra=1), {k: v for k, v in a.items() if k != 'alert_id'}, dict(a, level='LOUD'), dict(a, authenticated=2), dict(a, alert_type='nope')):
        with pytest.raises(Exception): check('alert', bad)
    w.stop()
`);
  putB64("docs/adr/0032.md", "IyBBRFIgMDAzMjogVGhlIGRhc2hib2FyZCBtZXNzYWdlcyBhbmQgdGhlIHNuYXBzaG90IChQMjQtM2ItMmEpIGFuZCB0aGUgc3BsaXQgb2YgUDI0LTNiLTIKClN0YXR1czogUHJvcG9zZWQgKGRlY2lkZWQgaW4gdGhlIFAyNC0zYi0yIHNlc3Npb247IGNvbmZpcm0gYXQgdGhlIG5leHQgZGVzaWduIHJldmlldykuCkRlc2lnbjogUmV2IDMuNDUgaXMgZnJvemVuLiBOb3RoaW5nIGluIHRoZSBmcmFtZSwgdGhlIG1pZ3JhdGlvbiwgYGNvbnN0YW50cy5qc29uYCwgdGhlIHNldHRpbmdzIGtleXMgb3IgYGFwaS9tb2RlbHMucHlgIGNoYW5nZXMuCgotICoqU3BsaXQgb2YgUDI0LTNiLTIgKGRlY2lzaW9uKS4qKiAqKlAyNC0zYi0yYSoqICh0aGlzIG9uZSk6IGByZWFkaW5nYCwgYGFsZXJ0YCBhbmQgYGVwaXNvZGVgIG1lc3NhZ2VzIGFuZCB0aGUgc25hcHNob3QuICoqUDI0LTNiLTJiKio6IGBsaW5rYCwgYHN5c3RlbWAgYW5kIGBhZHZpc29yeWAgbWVzc2FnZXMsIHdob3NlIHNvdXJjZXMgKEhlYWx0aCwgdGhlIGF1ZGlvIHRocmVhZCwgdGhlIGxpbmsgbW9uaXRvciwgYGFkdmlzb3J5X3N0ZXBgKSBhcmUgd2lyZWQgaW4gUDI0LTNjLiBQMjQtM2MsIFAyNC00LCBQMjQtNSBhcmUgdW5jaGFuZ2VkLgotICoqV2hlcmUgKGRlY2lzaW9uLCBwbGVhc2UgY29uZmlybSkuKiogYGhvc3QvcHBlX2hvc3Qvd2lyZS5weWAsIHRvcCBsZXZlbCBuZXh0IHRvIGBob3N0X3BvcnQucHlgIChkZXNpZ24gMTQuNSBsaXN0cyBubyBtb2R1bGUpLiBgV2lyZShwb3J0LCBodWIpLmF0dGFjaCgpYCBzZXRzIGBJbmdlc3QuYnJvYWRjYXN0YCwgYEhvc3RQb3J0LnB1Ymxpc2hgIGFuZCBgSG9zdFBvcnQud2lyZWA7IGBIb3N0UG9ydC5zbmFwc2hvdCgpYCBpcyB0aGUgaHViIFNvdXJjZSdzIGBzbmFwc2hvdGAuIGBXaXJlLnRpY2soKWAgaXMgdGhlIDEgSHogZHJpdmVyIGZvciBQMjQtM2MgKGVuZ2luZSB0aWNrLCBoZWxkIG1lc3NhZ2VzLCB1bmF1dGggcmVwZWF0cykuCi0gKipCb2RpZXMgY29tZSBmcm9tIGNvbW1pdHRlZCByb3dzLioqIEFmdGVyIHRoZSBjb21taXQgd2FpdCBhbiBhbGVydCBvciBlcGlzb2RlIG1lc3NhZ2UgaXMgcmVhZCBiYWNrIGZyb20gaXRzIHJvdywgc28gYGFsZXJ0X2lkYCBpcyB0aGUgaWQgdGhlIFJFU1QgQWNrbm93bGVkZ2UgdXNlcy4gVGhlIGFsZXJ0IGlzIGZvdW5kIGJ5IGBldmVudF9zZXFgIChubyBpbmRleCB3aXRob3V0IGBzZXNzaW9uX2lkYCwgQURSIDAwMzAgY29zdCBub3RlKSwgdGhlIGVwaXNvZGUgYnkgbm9kZSAobGF0ZXN0KS4gYEluZ2VzdGVkLmN0eGAgY2FycmllcyB0aGUgcmVhZGluZydzIGlucHV0cywgY2FwdHVyZWQgdW5kZXIgdGhlIGxvY2suCi0gKipPUEVOLCBuZWVkcyB5b3VyIGRlY2lzaW9uOiBgdW5wZXJzaXN0ZWRgLioqIERlc2lnbiAxIHNheXMgYW4gYWxlcnQgYnJvYWRjYXN0IGJlZm9yZSBpdHMgY29tbWl0IGNhcnJpZXMgYHVucGVyc2lzdGVkPTFgLCBidXQgdGhlIHdpcmUgaGFzIG5vIHN1Y2ggZmllbGQgKDMuOCwgYEFsZXJ0Qm9keWApIGFuZCBgYWxlcnRfaWRgIGRvZXMgbm90IGV4aXN0IGJlZm9yZSB0aGUgY29tbWl0LiBJbnRlcmltLCB1bnRpbCB5b3UgZGVjaWRlOiBhIHVuaXQgbm90IGNvbW1pdHRlZCB3aXRoaW4gYGNvbW1pdF93YWl0X21zYCBpcyBoZWxkIGluIGBXaXJlLnBlbmRpbmdgIGFuZCBpdHMgYWxlcnQgYW5kIGVwaXNvZGUgbWVzc2FnZXMgZ28gb3V0IGFmdGVyIGl0IGNvbW1pdHMgKHJlYWRpbmdzIGFyZSBub3QgaGVsZCwgc28gdGhlIG5vZGUgY2FyZCBzdGlsbCBzaG93cyBpdHMgbGV2ZWwpOyBhIHJvdyB0aGUgd3JpdGVyIHJlamVjdGVkIGhhcyBubyBpZCwgc28gbm8gbWVzc2FnZSBpcyBzZW50IGFuZCBpdHMgYGV2ZW50X3NlcWAgZ29lcyBpbnRvIGBXaXJlLnVucGVyc2lzdGVkYC4gVGhlIGhvc3QgYWxhcm0gZG9lcyBub3QgZGVwZW5kIG9uIGVpdGhlci4gT3B0aW9uczogKGEpIGFkZCBgdW5wZXJzaXN0ZWRgIHRvIGBBbGVydEJvZHlgIGFuZCBhIHByb3Zpc2lvbmFsIGlkIChjaGFuZ2VzIGBtb2RlbHMucHlgLCBgd3Muc2NoZW1hLmpzb25gLCBgd3MudHNgIGFuZCB0aGUgZGFzaGJvYXJkOyBydW4gYGp1c3QgZ2VuYCksIChiKSBrZWVwIHRoZSBpbnRlcmltIHJ1bGUuIE5vdCBidWlsdCBiZWNhdXNlIHRoZSBnZW5lcmF0b3JzIGNvdWxkIG5vdCBiZSBydW4gaW4gdGhpcyBzZXNzaW9uLgotICoqT1BFTjogQWNrbm93bGVkZ2Ugb2YgYW4gZXBpc29kZSBhbmQgYW4gYWxyZWFkeSBjbGVhcmVkIGxpbmtlZCBhbGVydC4qKiAzLjggc2F5cyBvbmUgYWxlcnQgbWVzc2FnZSBwZXIgbGlua2VkIGFsZXJ0LCBhbHNvIGZvciBhIGNsZWFyZWQgb25lLiBUaGUgZW5naW5lIGFja25vd2xlZGdlcyBvbmx5IG9wZW4gcm93cywgc28gb25seSB0aG9zZSBnZXQgYSBtZXNzYWdlLiBVbmNoYW5nZWQuCi0gKipSZWFkaW5ncy4qKiBFdmVyeSB2ZXJpZmllZCBmcmFtZSBnaXZlcyBvbmUgcmVhZGluZywgYSBkdXBsaWNhdGUgdG9vIChgc2VxX2NsYXNzYCBzYXlzIHNvKS4gYGxldmVsYCBpcyB0aGUgZW5naW5lJ3MgZGlzcGxheWVkIGxldmVsLCBgcG9zdHVyZWAgaXMgYGlkX21vZGVgIGJpdHMgNCBhbmQgNSwgYHN0aWxsbmVzc19zYCBpcyB0aGUgaG9zdCdzIHNoYWRvdyBydW4gKDAuMCB3aGVuIG5vbmUpLCBgcmVhc29uc2AgYXJlIHRoZSByZWFzb24gdGV4dHMgb2YgdGhlIG5vZGUncyBvcGVuIGFsZXJ0cyAoQ08gcm93cyBoYXZlIG5vbmUsIHNvIHRoZSBsaXN0IGNhbiBiZSBlbXB0eSkuCi0gKip1bmF1dGhfYWxlcnQgcmVwZWF0cy4qKiBBIHJlcGVhdCBCQURfTUFDIGZyYW1lIGhhcyBubyBlZmZlY3QgYW5kIG5vIGJyb2FkY2FzdCwgc28gYFdpcmUudGljaygpYCBzZW5kcyB0aGUgYWxlcnQgYWdhaW4gd2hlbiBgdW5hdXRoX2NvdW50YCBjaGFuZ2VkOyB0aGUgaHViIGtlZXBzIGl0cyBvbmNlLXBlci1zZWNvbmQgbGltaXQuCi0gKipTbmFwc2hvdC4qKiBOb2RlcyBzaG93IHRoZSBsYXN0IGNvbW1pdHRlZCB2ZXJpZmllZCBub24tZHVwbGljYXRlIGZyYW1lOyBgbGlua19zdGF0ZWAgaXMgYG5vdF9jb25uZWN0ZWRgIHVudGlsIHRoZSBlbmdpbmUgaGFzIGhlYXJkIHRoZSBub2RlIHNpbmNlIHRoZSBob3N0IHN0YXJ0ZWQgKHVudGlsIFAyNC0zYyBsb2FkcyBzdGF0ZSksIG5ldmVyIGByZWNvdmVyZWRgLiBgb3Blbl9hbGVydHNgIGFyZSB0aGUgcm93cyB3aXRoIGBjbGVhcmVkX3RzYCBOVUxMLCBzbyBhIHJlY29ubmVjdCBkcm9wcyBhIGNsZWFyZWQgYWxlcnQgdGhhdCBpcyBzdGlsbCB1bmFja25vd2xlZGdlZCAodGhlIGRhc2hib2FyZCBrZWVwcyB0aG9zZSBmcm9tIG1lc3NhZ2VzIG9ubHkpLiBgY29faGlzdG9yeV8zMG1gIGNvbWVzIGZyb20gaW5kZXhlZCBmcmFtZXMsIHdpdGhvdXQgZHVwbGljYXRlcyBhbmQgQ08tZmF1bHQgZnJhbWVzLiBgaG9zdF9nYXBgIGxlYXZlcyB0aGUgYmFubmVycyBvbmNlIGFja25vd2xlZGdlZDsgYGxvZ2dpbmdfZmF1bHRgIGZvbGxvd3MgdGhlIHdyaXRlci4gYGJhc2Vfb2ZmbGluZWAsIGBhdWRpb19mYXVsdGAgYW5kIGBob3N0X3Bvd2VyYCBkZWZhdWx0IHRvIEhlYWx0aCwgZmFsc2UgYW5kIGBhY2AgdW50aWwgUDI0LTNjIHBhc3NlcyB0aGUgcmVhbCBzb3VyY2VzLgo=");
  replace("host/ppe_host/io/ingest.py", "    unit: Optional[Unit]\n\nclass RateWindow", "    unit: Optional[Unit]\n    ctx: Optional[dict] = None   # P24-3b-2a: what the reading message needs, captured under the lock (None unless verify is OK); see wire.reading_body\n\nclass RateWindow");
  replace("host/ppe_host/io/ingest.py", "            nl = backend = final = reasons = None\n", "            nl = backend = final = reasons = None; rlist = []\n");
  replace("host/ppe_host/io/ingest.py", "                reasons = '; '.join(a.reasons for a in mine if a.reasons) or None\n", "                reasons = '; '.join(a.reasons for a in mine if a.reasons) or None; rlist = [a.reasons for a in mine if a.reasons]\n");
  replace("host/ppe_host/io/ingest.py", "            drop = diag and not fx\n", "            ctx = dict(node=node, d=d, rx_ts=now.wall_ms, rx_mono=now.mono_ms, rssi=f.rssi, snr=f.snr, over=over, ns=self.st.nodes.get(node), reasons=rlist, seq_class=cls) if host == 'OK' else None\n            drop = (diag and not fx)\n");
  replace("host/ppe_host/io/ingest.py", "        out = Ingested(host, cls, fseq, tuple(fx), stored, committed, backend_ms, unit)\n", "        out = Ingested(host, cls, fseq, tuple(fx), stored, committed, backend_ms, unit, ctx)\n");
  replace("host/ppe_host/io/ingest.py", "Not here (P24-3b-2): the messages for the dashboard.", "P24-3b-2a: Ingested.ctx carries the reading's inputs; the messages themselves are built in wire.py.");
  replace("host/ppe_host/host_port.py", "    def session_id(self): return self.ing.session_id\n    def recovering_retry_s(self):", "    def session_id(self): return self.ing.session_id\n    def snapshot(self):\n        \"\"\"The hub's Source.snapshot (P24-3b-2a): built by wire.Wire, which attach() plugs in.\"\"\"\n        if self.wire is None: raise RuntimeError('no Wire attached: build wire.Wire(port, hub).attach() first')\n        return self.wire.snapshot()\n    def recovering_retry_s(self):");
  replace("host/ppe_host/host_port.py", "class HostPort:\n    def __init__(self, ingest", "class HostPort:\n    wire = None   # set by wire.Wire.attach() (P24-3b-2a)\n    def __init__(self, ingest");
  replace("host/ppe_host/host_port.py", "            self._done((), self.ing.write([Stmt('UPDATE alerts SET acknowledged_ts = ?, acknowledged_by = ? WHERE alert_id = ? AND acknowledged_ts IS NULL', (ts, operator_id, alert_id))], durable=True))", "            self._done((AlertAcknowledged(0, node, typ, eseq, operator_id, ts),), self.ing.write([Stmt('UPDATE alerts SET acknowledged_ts = ?, acknowledged_by = ? WHERE alert_id = ? AND acknowledged_ts IS NULL', (ts, operator_id, alert_id))], durable=True))   # the effect only tells the Wire which row to send (event_seq 0 is never stored)");
  replace("host/ppe_host/host_port.py", "Not here: the snapshot and the WebSocket messages (P24-3b-2, which plugs into publish)", "The snapshot and the WebSocket messages are wire.py (P24-3b-2a), which plugs into publish. Not here");
  append('docs/PROGRESS.md', "- Part 24-3b-2a done: wire.py (Wire: reading, alert and episode messages built after the commit and read back from the committed rows, held while a unit has not committed, no message for a rejected row, unauth_alert repeats and the engine tick from Wire.tick(), the snapshot for the hub Source), Ingested.ctx, HostPort.snapshot and the acknowledgement of a cleared alert now publishes, host/tests/test_wire.py (15 tests, bodies checked against the WsMessage contract), docs/adr/0032.md (P24-3b-2 split into 2a and 2b; `unpersisted` has no wire field and needs a decision); link, system and advisory messages are P24-3b-2b, steps 8 to 10 are P24-3c");
}
