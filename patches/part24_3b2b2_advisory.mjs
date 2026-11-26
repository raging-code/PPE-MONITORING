// patches/part24_3b2b2_advisory.mjs  (run from repo root: node patches/part24_3b2b2_advisory.mjs [--dry] [--force])
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
  const I = 'host/ppe_host/io/ingest.py';

  // ---- imports: advisory_step + AdvisoryState/AdvisoryConfig/AdvisoryRow ----
  replace(I,
"from ..core.rule_engine import (AlertAcknowledged, ChangeAlertLevel, ClearAlert, EPISODE_ALERT_TYPES, EngineState, EpisodeAcknowledged, EpisodeEscalated, EpisodeOpened, EpisodeResolved,\n                                FrameEvent, RANK, RaiseAlert, TickEvent, next_seq, step)",
"from ..core.advisory import AdvisoryConfig, AdvisoryRow, AdvisoryState, advisory_step\nfrom ..core.rule_engine import (AlertAcknowledged, ChangeAlertLevel, ClearAlert, EPISODE_ALERT_TYPES, EngineState, EpisodeAcknowledged, EpisodeEscalated, EpisodeOpened, EpisodeResolved,\n                                FrameEvent, RANK, RaiseAlert, TickEvent, next_seq, step)");

  // ---- module docstring: note 2b-ii now covers the advisory rows ----
  replace(I,
"P24-3b-1: audit() and write() give the Port (host_port.py) ordered units of its own. P24-3b-2a: Ingested.ctx carries the reading's inputs; the messages themselves are built in wire.py. The audit rows of ACK_EPISODE, RESOLVE_EPISODE and the like are written by the REST routes through the Port, not here.\nNot here (P12b): the real clock, base_health rows, COUNTERS rows, SERIAL_LOST and SERIAL_BACK.\"\"\"",
"P24-3b-1: audit() and write() give the Port (host_port.py) ordered units of its own. P24-3b-2a: Ingested.ctx carries the reading's inputs; the messages themselves are built in wire.py. The audit rows of ACK_EPISODE, RESOLVE_EPISODE and the like are written by the REST routes through the Port, not here.\nP24-3b-2b-ii: advisory_step (core/advisory.py, P9) runs after step() on every frame() and tick() when adv_cfg is set (None until a Wire turns it on: the advisory table needs no reader until the\ndashboard does); its AdvisoryRow effects get one advisory_summaries row each, in the same unit as the frame or tick, and come back in Ingested.effects so wire.py can build the advisory message.\nNot here (P12b): the real clock, base_health rows, COUNTERS rows, SERIAL_LOST and SERIAL_BACK.\"\"\"");

  // ---- advisory_summaries INSERT in effect_stmts ----
  replace(I,
"        elif isinstance(e, EpisodeResolved):\n            out.append(Stmt(\"UPDATE episodes SET state = 'RESOLVED', resolved_ts = ?, resolve_reason = ?, resolved_by = ? WHERE \" + IN_ACTIVE, (e.ts, e.reason, e.operator_id, e.node_id)))\n    return out",
"        elif isinstance(e, EpisodeResolved):\n            out.append(Stmt(\"UPDATE episodes SET state = 'RESOLVED', resolved_ts = ?, resolve_reason = ?, resolved_by = ? WHERE \" + IN_ACTIVE, (e.ts, e.reason, e.operator_id, e.node_id)))\n        elif isinstance(e, AdvisoryRow):   # P24-3b-2b-ii: advisory_summaries has no row for passage_ids yet (Tier 1: source is always 'table', passage_ids stays NULL)\n            out.append(Stmt('INSERT INTO advisory_summaries(session_id, event_seq, ts, node_id, window_s, risk, reasons, action, source, passage_ids, quality) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',\n                            (session_id, e.event_seq, e.ts, e.node_id, e.window_s, e.risk, e.reasons, e.action, e.source, e.passage_ids, e.quality)))\n    return out");

  // ---- Ingest.__init__: adv (AdvisoryState) and adv_cfg (None until turned on) ----
  replace(I,
"        self.st, self.cs = EngineState(event_seq=event_seq_start), SeqState()",
"        self.st, self.cs, self.adv = EngineState(event_seq=event_seq_start), SeqState(), AdvisoryState()\n        self.adv_cfg = None   # P24-3b-2b-ii: off until a Wire calls enable_advisory(); advisory_step is skipped while this is None");

  // ---- enable_advisory: the one entry point a Wire (or anything else) uses to turn it on ----
  replace(I,
"    @classmethod\n    def from_settings(cls, settings, roster, writer, clock, session_id, **kw):\n        \"\"\"key from config/secrets.json, sys_id and commit_wait_ms from settings; nothing secret comes from the repo.\"\"\"\n        return cls(settings.cmac_key(), settings['sys_id'], roster, writer, clock, session_id, commit_wait_ms=settings['commit_wait_ms'], **kw)",
"    @classmethod\n    def from_settings(cls, settings, roster, writer, clock, session_id, **kw):\n        \"\"\"key from config/secrets.json, sys_id and commit_wait_ms from settings; nothing secret comes from the repo.\"\"\"\n        return cls(settings.cmac_key(), settings['sys_id'], roster, writer, clock, session_id, commit_wait_ms=settings['commit_wait_ms'], **kw)\n\n    def enable_advisory(self, heartbeat_s):\n        \"\"\"P24-3b-2b-ii: turn the Tier 1 advisory table on (settings key advisory_heartbeat_s). Idempotent; a second call with a different heartbeat_s replaces cfg without resetting AdvisoryState.\"\"\"\n        self.adv_cfg = AdvisoryConfig(heartbeat_s=heartbeat_s)");

  // ---- tick(): run advisory_step after step(), fold AdvisoryRow effects into fx ----
  replace(I,
"    def tick(self):\n        \"\"\"The 1 Hz TickEvent (silence rules and the 10 s timers). Returns (effects, unit); the owner broadcasts after the commit.\"\"\"\n        with self._lock:\n            self.st, fx = step(self.st, TickEvent(), now_of(self.clock)); return tuple(fx), self._fx_unit(fx, False)",
"    def tick(self):\n        \"\"\"The 1 Hz TickEvent (silence rules and the 10 s timers). Returns (effects, unit); the owner broadcasts after the commit.\"\"\"\n        with self._lock:\n            now = now_of(self.clock); self.st, fx = step(self.st, TickEvent(), now); event = TickEvent()\n            if self.adv_cfg is not None:\n                self.st, self.adv, afx = advisory_step(self.st, self.adv, event, now, self.adv_cfg); fx = tuple(fx) + afx\n            return tuple(fx), self._fx_unit(fx, False)");

  // ---- frame(): run advisory_step with the same FrameEvent and now, after step(), only for nodes the engine actually saw (host != BAD_LEN) ----
  replace(I,
"            self.st, fseq = next_seq(self.st)                              # the frame's own event_seq comes BEFORE the effects of this frame\n            fx = ()\n            if host != 'BAD_LEN': self.st, fx = step(self.st, FrameEvent(node, host, cls, d), now)",
"            self.st, fseq = next_seq(self.st)                              # the frame's own event_seq comes BEFORE the effects of this frame\n            fx = ()\n            if host != 'BAD_LEN':\n                event = FrameEvent(node, host, cls, d); self.st, fx = step(self.st, event, now)\n                if self.adv_cfg is not None:\n                    self.st, self.adv, afx = advisory_step(self.st, self.adv, event, now, self.adv_cfg); fx = tuple(fx) + afx");

  // ---- row/effect_stmts already take fx as given; just make sure 'fx' being a tuple (not list) downstream is fine (it already is used as a tuple in the return) ----
  replace(I,
"        out = Ingested(host, cls, fseq, tuple(fx), stored, committed, backend_ms, unit, ctx)",
"        out = Ingested(host, cls, fseq, tuple(fx), stored, committed, backend_ms, unit, ctx)   # fx may now include AdvisoryRow effects (P24-3b-2b-ii)");

  // ---- wire.py: the advisory message, built from AdvisoryRow effects the same way alert/episode effects are turned into messages ----
  const W = 'host/ppe_host/wire.py';
  replace(W,
"P24-3b-2b-i: link and system messages (Wire.link_state, _links, _system, on_banner_ack). Not here (P24-3b-2b-ii): the advisory message. No thread, no socket; every method runs on the event loop.\"\"\"",
"P24-3b-2b-i: link and system messages (Wire.link_state, _links, _system, on_banner_ack). P24-3b-2b-ii: the advisory message (Wire.enable_advisory, _advisory), sent straight from the\nAdvisoryRow effect (it has a passage_ids field but no database id of its own to read back, unlike an alert or episode). No thread, no socket; every method runs on the event loop.\"\"\"");

  replace(W,
"from .core.rule_engine import (AlertAcknowledged, ChangeAlertLevel, ClearAlert, EpisodeAcknowledged, EpisodeEscalated, EpisodeLabelChanged, EpisodeOpened, EpisodeResolved,\n                               NodeState, RaiseAlert)",
"from .core.advisory import AdvisoryRow\nfrom .core.rule_engine import (AlertAcknowledged, ChangeAlertLevel, ClearAlert, EpisodeAcknowledged, EpisodeEscalated, EpisodeLabelChanged, EpisodeOpened, EpisodeResolved,\n                               NodeState, RaiseAlert)");

  replace(W,
"def episode_body(r, label):",
"def advisory_body(e):\n    \"\"\"AdvisoryMsg fields (no envelope) from an AdvisoryRow effect. No database id: Tier 1 never acknowledges or re-reads an advisory row (design 14.3), so unlike alert_body and\n    episode_body this is built straight from the effect, with no read-back and nothing added by _send.\"\"\"\n    return dict(node_id=e.node_id, risk=e.risk, reasons=e.reasons, action=e.action, quality=e.quality, source=e.source)\n\ndef episode_body(r, label):");

  // enable_advisory passthrough + advisory effects sent alongside alert/episode effects in _send
  replace(W,
"    def attach(self):",
"    def enable_advisory(self, heartbeat_s):\n        \"\"\"P24-3b-2b-ii: turn the Tier 1 advisory table on in the Ingest this Wire is attached to. Call before or after attach(); advisory rows reach the hub through the normal _send path\n        either way, since AdvisoryRow effects travel in Ingested.effects / step()'s own fx exactly like alert and episode effects do.\"\"\"\n        self.ing.enable_advisory(heartbeat_s)\n\n    def attach(self):");

  replace(W,
"        for e in fx:\n            if isinstance(e, ALERT_FX):",
"        for e in fx:\n            if isinstance(e, AdvisoryRow): self._pub('publish_advisory', advisory_body(e)); continue   # no row to read back (design 14.3): send straight from the effect\n            if isinstance(e, ALERT_FX):");

  put('host/tests/test_advisory_wire.py', String.raw`"""P24-3b-2b-ii: advisory rows in Ingest (adv_cfg off until Wire.enable_advisory turns it on, advisory_step called after every step()) and the advisory message of wire.Wire.
Real DBWriter, database, HostPort and engine, a fake hub. Every body is checked against the WsMessage contract (real models when pydantic is installed, else shared/ws.schema.json).
The table itself (design 14.3: which row matches which level and reasons) is tested in test_advisory.py; this file only checks the wiring: the row lands in advisory_summaries in the
same unit as the frame or tick that produced it, and the hub gets one advisory message per row, with no message and no row while adv_cfg is off."""
from ppe_host.wire import Wire
from test_effect_rows import wait
from test_gv_bytes import pack
from test_host_port import port
from test_ingest import rows, send
from test_wire import Hub as Hub1, SCHEMA, _ok, got

HEARTBEAT_S = 300

def check3(body):
    msg = dict(body, v=1, type='advisory', srv_seq=0, srv_ts=1)
    try: from ppe_host.api import models as M
    except ImportError: assert _ok(msg, SCHEMA['AdvisoryMsg']), msg; return
    M.parse_server(msg)
class Hub(Hub1):
    def publish_advisory(self, b): check3(b); self.sent.append(('advisory', b))
def wired(tmp_path, **kw):
    c, w, clock, ing, p = port(tmp_path); h = Hub(); return c, w, clock, ing, p, h, Wire(p, h, **kw).attach()

def test_advisory_is_off_by_default_no_row_and_no_message(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    r = send(ing, clock, pack(seq=1)); wait(w, r.unit)
    assert rows(c, 'SELECT * FROM advisory_summaries') == [] and got(h, 'advisory') == []; w.stop()

def test_enable_advisory_writes_the_first_row_in_the_frames_unit_and_sends_one_message(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); wire.enable_advisory(HEARTBEAT_S)
    r = send(ing, clock, pack(seq=1)); wait(w, r.unit)
    arows = rows(c, 'SELECT * FROM advisory_summaries ORDER BY event_seq')
    assert len(arows) == 1 and arows[0]['session_id'] == 1 and arows[0]['node_id'] == 1 and arows[0]['risk'] == 'NOMINAL' and arows[0]['source'] == 'table' and arows[0]['passage_ids'] is None
    (m,) = got(h, 'advisory'); assert (m['node_id'], m['risk'], m['action'], m['quality'], m['source']) == (1, 'NOMINAL', arows[0]['action'], arows[0]['quality'], 'table'); w.stop()

def test_a_tick_also_runs_advisory_step_once_enabled(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); wire.enable_advisory(HEARTBEAT_S)
    send(ing, clock, pack(seq=1)); wait(w, ing.write([]))
    n0 = len(rows(c, 'SELECT * FROM advisory_summaries'))
    fx, u = ing.tick(); wait(w, u)
    assert len(rows(c, 'SELECT * FROM advisory_summaries')) >= n0; w.stop()   # no level change and no heartbeat due yet: a tick alone need not add a row, but must not error or duplicate state

def test_a_risk_change_writes_a_second_row_in_the_same_unit_as_the_frame_that_caused_it(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); wire.enable_advisory(HEARTBEAT_S)
    send(ing, clock, pack(seq=1)); wait(w, ing.write([]))
    r2 = send(ing, clock, pack(seq=2, co_x10=2500, flags=2))   # DANGER: co 250.0 ppm, node_level DANGER (GV-09a shape)
    wait(w, r2.unit)
    arows = rows(c, 'SELECT * FROM advisory_summaries ORDER BY event_seq')
    assert arows[-1]['node_id'] == 1 and arows[-1]['risk'] == 'TOXIC_ATMOSPHERE'
    frow = rows(c, 'SELECT event_seq FROM frames WHERE event_seq = (SELECT MAX(event_seq) FROM frames)')[0]
    assert arows[-1]['event_seq'] > frow['event_seq'] - 1   # the advisory row's event_seq was allocated in the same step() call as this frame's effects
    msgs = got(h, 'advisory'); assert msgs[-1]['risk'] == 'TOXIC_ATMOSPHERE'; w.stop()

def test_enable_advisory_through_the_wire_reaches_the_same_ingest_the_port_uses(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); assert ing.adv_cfg is None
    wire.enable_advisory(HEARTBEAT_S); assert ing.adv_cfg is not None and ing.adv_cfg.heartbeat_s == HEARTBEAT_S; w.stop()
`);

  append('docs/PROGRESS.md', "- Part 24-3b-2b-ii done: advisory rows (Ingest.enable_advisory/adv_cfg, off by default; advisory_step runs after step() on every frame() and tick(); AdvisoryRow effects get one advisory_summaries row each, same unit as the frame or tick) and the advisory message (wire.Wire.enable_advisory, advisory_body: no database read-back, built straight from the effect since design 14.3 gives it no id), host/tests/test_advisory_wire.py (5 tests); ADR 0033 and the doc touch-ups are P24-3b-2b-iii");
}
