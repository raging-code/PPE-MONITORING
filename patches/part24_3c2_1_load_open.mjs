// patches/part24_3c2_1_load_open.mjs  (P24-3c-2 Part 1, code only; run from repo root: node patches/part24_3c2_1_load_open.mjs [--dry] [--force])
// Adds start-up step 9 of design 14.5: load open alerts and open episodes by two indexed queries into the engine state.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
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
      // already applied is checked FIRST: a new text may contain its own anchor
      if (cur.includes(s.newStr)) { log.push(`skip      ${s.p} (already applied)`); continue; }
      const n = cur.split(s.oldStr).length - 1;
      if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
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
  const ING = 'host/ppe_host/io/ingest.py';

  // 1. imports: dataclasses.replace and the engine module (the names LEVELS and RANK in ingest.py are its own)
  replace(ING,
    'FrameEvent, RANK, RaiseAlert, TickEvent, next_seq, step)\n',
    'FrameEvent, RANK, RaiseAlert, TickEvent, next_seq, step)\nfrom dataclasses import replace as _replace\nfrom ..core import rule_engine as eng\n');

  // 2. header note
  replace(ING,
    'Not here (P12b): the real clock, base_health rows',
    'P24-3c-2: load_open_state() reads the open alerts and open episodes by two indexed queries and Ingest.load_open() merges them into the engine state (start-up step 9); existing state wins, nothing is written and no event_seq is used.\nNot here (P12b): the real clock, base_health rows');

  // 3. load_open_state, OpenState, OpenReport
  replace(ING,
    'class Ingested(NamedTuple):',
    String.raw`OPEN_ALERTS_SQL = 'SELECT alert_id, event_seq, episode_id, node_id, type, level, reasons, raised_ts, acknowledged_ts FROM alerts WHERE cleared_ts IS NULL ORDER BY event_seq'      # idx_alerts_open (partial index on cleared_ts IS NULL)
OPEN_EPISODES_SQL = "SELECT episode_id, node_id, kind, opened_ts, acknowledged_ts, acknowledged_by, state FROM episodes WHERE state IN ('OPEN', 'ACKNOWLEDGED') ORDER BY episode_id"   # idx_episodes_one_active

class OpenState(NamedTuple):
    """What the database says is open (P24-3c-2). Nothing here touches an Ingest."""
    alerts: dict       # (node_id, type) -> engine OpenAlert
    episodes: dict     # node_id -> engine Episode
    unauth: dict       # node_id -> (unauth_count, unauth_last_seen_ts) of an open unauth_alert
    skipped: tuple     # (what, row id, why): rows that could not become engine state

class OpenReport(NamedTuple):
    alerts: int        # open alerts added to the engine state by this call
    episodes: int      # open episodes added by this call
    skipped: tuple     # as OpenState.skipped

def _is_node(v): return isinstance(v, int) and not isinstance(v, bool)

def load_open_state(conn):
    """Start-up step 9 (design 14.5, section 1 step b): the open alerts (cleared_ts IS NULL, in every session) and the open episodes (state OPEN or ACKNOWLEDGED) by two indexed queries,
    as engine values. The database holds less than the engine keeps, so four things are decided here (ADR 0034):
    (1) unauth_count: not stored; an open unauth_alert comes back with count 1 (a lower bound: at least the frame that opened it) and unauth_last_seen_ts = its raised_ts.
    (2) Episode.opened_event_seq: not stored; it is the event_seq of the episode's oldest open man_down or mayday row minus 1 (EpisodeOpened is allocated just before that RaiseAlert), or 0 when no such row is open. Nothing looks an episode up by it (the writer uses the node).
    (3) motion_state: not stored; NO_RESPONSE for MAN_DOWN (the safe label, it changes to movement_detected only after fresh frames show it) and None for MAYDAY; the move and still timers start empty.
    (4) A row that cannot be an engine value is skipped and listed, never loaded and never fatal: node_id NULL or not an int, unknown type or level, unknown episode kind, a second open row for the same node and type (the lowest event_seq stays),
    a second active episode for a node. Reads only: no write, no event_seq."""
    skipped, alerts, unauth, first_of_ep, episodes = [], {}, {}, {}, {}
    for aid, seq, epid, nid, typ, lvl, why, raised, ack in conn.execute(OPEN_ALERTS_SQL):
        if not _is_node(nid): skipped.append(('alert', aid, 'node_id is %r' % (nid,))); continue
        if typ not in eng.ALERT_TYPES: skipped.append(('alert', aid, 'unknown type %r' % (typ,))); continue
        if lvl not in eng.LEVELS: skipped.append(('alert', aid, 'unknown level %r' % (lvl,))); continue
        if (nid, typ) in alerts: skipped.append(('alert', aid, 'second open row for node %d type %s' % (nid, typ))); continue
        alerts[(nid, typ)] = eng.OpenAlert(nid, typ, lvl, seq, raised, why or '', ack)
        if typ == 'unauth_alert': unauth[nid] = (1, raised)
        if epid is not None and typ in eng.EPISODE_ALERT_TYPES: first_of_ep.setdefault(epid, seq)       # rows come in event_seq order: the first is the oldest
    for epid, nid, kind, opened, ack_ts, ack_by, state in conn.execute(OPEN_EPISODES_SQL):
        if not _is_node(nid): skipped.append(('episode', epid, 'node_id is %r' % (nid,))); continue
        if kind not in ('MAN_DOWN', 'MAYDAY'): skipped.append(('episode', epid, 'unknown kind %r' % (kind,))); continue
        if nid in episodes: skipped.append(('episode', epid, 'second active episode for node %d' % nid)); continue
        episodes[nid] = eng.Episode(nid, kind, state, first_of_ep[epid] - 1 if epid in first_of_ep else 0, opened, ack_ts, ack_by,
                                    motion_state=None if kind == 'MAYDAY' else eng.NO_RESPONSE)
    return OpenState(alerts, episodes, unauth, tuple(skipped))

class Ingested(NamedTuple):`);

  // 4. Ingest.load_open
  replace(ING,
    '    def on_item(self, kind, payload):\n        """The SerialReader callback."""',
    String.raw`    def load_open(self, conn):
        """P24-3c-2, start-up step 9: merge load_open_state(conn) into the engine state. The existing state wins: an alert, an episode or a node's unauth fields that the engine already holds are left as they are,
        so a second call changes nothing and returns zeros. Only a row that this call adds can set that node's unauth_count and unauth_last_seen_ts. No row is written, no event_seq is used, no effect is produced.
        Returns an OpenReport (counts of what was added, and the skipped rows, each logged as a warning)."""
        found = load_open_state(conn)
        for what, rid, why in found.skipped: log.warning('open %s %s not loaded: %s', what, rid, why)
        with self._lock:
            st = self.st
            alerts, episodes, nodes = dict(st.alerts), dict(st.episodes), dict(st.nodes)
            added_a = [k for k in found.alerts if k not in alerts]
            for k in added_a: alerts[k] = found.alerts[k]
            added_e = [n for n in found.episodes if n not in episodes]
            for n in added_e: episodes[n] = found.episodes[n]
            for nid, (count, seen) in found.unauth.items():
                if (nid, 'unauth_alert') in added_a: nodes[nid] = _replace(nodes.get(nid, eng.NodeState()), unauth_count=count, unauth_last_seen_ts=seen)
            if added_a or added_e: self.st = _replace(st, alerts=alerts, episodes=episodes, nodes=nodes)
        return OpenReport(len(added_a), len(added_e), found.skipped)

    def on_item(self, kind, payload):
        """The SerialReader callback."""`);

  // 5. Runtime
  const RT = 'host/ppe_host/runtime.py';
  replace(RT,
    'steps 9 and 10 (P24-3c-2 and P24-3c-3: open alerts, Uvicorn, the 1 Hz driver of offer_tick and Health.tick)',
    'step 9 is load_open() (P24-3c-2); step 10 (P24-3c-3: Uvicorn, the 1 Hz driver of offer_tick and Health.tick)');
  replace(RT,
    '    def release(self):\n        """Step 13 (P25 calls this after RECOVERING_EXIT)."""',
    String.raw`    def load_open(self):
        """Step 9 (P24-3c-2): open alerts and open episodes into the engine state by indexed SQL (Ingest.load_open on the start-up connection), before Uvicorn starts, so the first snapshot
        and the first frame agree. Safe to call again: the existing state wins. Returns the OpenReport."""
        rep = self.ingest.load_open(self.st.conn)
        log.info('step 9: %d open alert(s) and %d open episode(s) loaded, %d row(s) skipped', rep.alerts, rep.episodes, len(rep.skipped))
        return rep
    def release(self):
        """Step 13 (P25 calls this after RECOVERING_EXIT)."""`);

  // 6. main.py: call step 9, say so, and keep the one existing test that reads the line in step
  const MN = 'host/ppe_host/main.py';
  replace(MN, 'begin_session(st); rt = Runtime(st).start()', 'begin_session(st); rt = Runtime(st).start(); rt.load_open()');
  replace(MN, '# steps 6 and 7, then step 8 (P24-3c-1)', '# steps 6 and 7, step 8 (P24-3c-1), step 9 (P24-3c-2)');
  replace(MN, "print('start-up steps 1 to 8 done:", "print('start-up steps 1 to 9 done:");
  replace(MN, '# P24-3c-2 and later continue here with step 9', '# P24-3c-3 and later continue here with step 10');
  replace('host/tests/test_session_start.py', "'steps 1 to 8 done' in", "'steps 1 to 9 done' in");
}
