// patches/part24_3b2b1_link_system.mjs  (run from repo root: node patches/part24_3b2b1_link_system.mjs [--dry] [--force])
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
  const W = 'host/ppe_host/wire.py';
  replace(W, "Not here (P24-3b-2b): link, system and advisory messages. No thread", "P24-3b-2b-i: link and system messages (Wire.link_state, _links, _system, on_banner_ack). Not here (P24-3b-2b-ii): the advisory message. No thread");
  replace(W, "        with self._conn() as c: self.alias = {r['node_id']: r['alias'] for r in c.execute('SELECT node_id, alias FROM roster')}\n",
"        with self._conn() as c:\n            self.alias = {r['node_id']: r['alias'] for r in c.execute('SELECT node_id, alias FROM roster')}\n            self.mode = c.execute('SELECT mode FROM sessions WHERE session_id = ?', (self.ing.session_id,)).fetchone()['mode']\n        self.links, self.sys_key, self.sys_rej = {}, None, 0   # P24-3b-2b-i: last link state per node, last system body (without the counter), counter last sent\n");
  replace(W, "self.port.publish, self.port.wire, self.ing.broadcast = self.on_effects, self, self.on_frame; return self\n",
"self.port.publish, self.port.wire, self.ing.broadcast = self.on_effects, self, self.on_frame\n        now = self.ing.clock.wall_ms(); self.links = {n: (self.link_state(n), now) for n in self.alias}   # what is true now is not news\n        b = self._sys_body(); self.sys_key, self.sys_rej = self._key(b), b['rejected_frames']; return self\n");
  replace(W, "        self.on_effects(out.effects, out.unit, out.committed)\n", "        self.on_effects(out.effects, out.unit, out.committed); self._links()\n");
  replace(W, "        if due: self._send([RaiseAlert(k, open_[k], 'unauth_alert', 'NONE', '', 0) for k in due])\n",
"        if due: self._send([RaiseAlert(k, open_[k], 'unauth_alert', 'NONE', '', 0) for k in due])\n        self._links(); self._system(tick=True)\n");
  replace(W, "link = 'not_connected' if ns is None else 'link_lost' if (nid, 'link_lost') in ing.st.alerts else 'signal_lost' if (nid, 'signal_lost') in ing.st.alerts else 'ok'", "link = self.link_state(nid)");
  replace(W, "    # ---- snapshot ----\n", String.raw`    # ---- link and system messages (P24-3b-2b-i) ----
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
    def on_banner_acknowledged(self, kind, ts): self._system(banner=kind, ack=ts)

    # ---- snapshot ----
`);
  replace('host/ppe_host/host_port.py', "        self.banner_ack[kind] = self.ing.clock.wall_ms(); return BannerAck(kind, self.banner_ack[kind])",
"        self.banner_ack[kind] = self.ing.clock.wall_ms()\n        if self.wire is not None: self.wire.on_banner_acknowledged(kind, self.banner_ack[kind])   # P24-3b-2b-i: the BANNER_ACK system message\n        return BannerAck(kind, self.banner_ack[kind])");
  put('host/tests/test_wire_2b1.py', String.raw`"""P24-3b-2b-i: the link and system messages of wire.Wire (design 3.8). Real DBWriter, database, HostPort and engine, a fake hub; every body is checked against the WsMessage contract
(real models when pydantic is installed, else shared/ws.schema.json). The 3b-2a hub fakes have no publish_link or publish_system: Wire sends those messages only to a hub that has them."""
from ppe_host import constants as K
from ppe_host.wire import Wire
from test_effect_rows import wait
from test_gv_bytes import WRONG_KEY, pack
from test_host_port import port
from test_ingest import send
from test_wire import Hub as Hub1, SCHEMA, _ok, got

NAMES = {'link': 'LinkMsg', 'system': 'SystemMsg', 'advisory': 'AdvisoryMsg'}
def check2(kind, body):
    msg = dict(body, v=1, type=kind, srv_seq=0, srv_ts=1)
    try: from ppe_host.api import models as M
    except ImportError: assert _ok(msg, SCHEMA[NAMES[kind]]), msg; return
    M.parse_server(msg)
class Hub(Hub1):
    def publish_link(self, b): check2('link', b); self.sent.append(('link', b))
    def publish_system(self, b): check2('system', b); self.sent.append(('system', b))
def wired(tmp_path, **kw):
    c, w, clock, ing, p = port(tmp_path); h = Hub(); return c, w, clock, ing, p, h, Wire(p, h, **kw).attach()

def test_the_first_frame_of_a_node_is_a_link_message_from_not_connected_to_ok(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); assert got(h, 'link') == []
    wait(w, send(ing, clock, pack(seq=1)).unit); (m,) = got(h, 'link')
    assert (m['node_id'], m['state'], m['last_state'], m['since_ts']) == (1, 'ok', 'not_connected', clock.wall_ms())
    wait(w, send(ing, clock, pack(seq=2)).unit); assert len(got(h, 'link')) == 1; w.stop()

def test_silence_and_recovery_walk_the_link_states_and_the_snapshot_agrees(tmp_path):                           # GV-08
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=1)).unit)
    def now(): return got(h, 'link')[-1]
    def snap(): return wire.snapshot()['nodes'][0]['link_state']
    clock.advance((K.SIGNAL_LOST_S + 1) * 1000); wire.tick(); assert (now()['state'], now()['last_state'], snap()) == ('signal_lost', 'ok', 'signal_lost')
    clock.advance(K.LINK_LOST_MAX_S * 1000); wire.tick(); assert (now()['state'], now()['last_state'], snap()) == ('link_lost', 'signal_lost', 'link_lost')
    wait(w, send(ing, clock, pack(seq=2)).unit); assert (now()['state'], now()['last_state'], snap()) == ('recovered', 'link_lost', 'recovered')
    for s in range(3, 3 + K.REBASELINE_CLEAN_FRAMES): wait(w, send(ing, clock, pack(seq=s)).unit)                   # the recovery frame and the next rebaseline_clean_frames are not tracked
    assert (now()['state'], now()['last_state'], snap()) == ('ok', 'recovered', 'ok') and len(got(h, 'link')) == 5; w.stop()

def test_a_base_recovery_session_or_banner_source_change_is_one_system_message(tmp_path):
    off, fault, pw = [False], [False], ['ac']
    c, w, clock, ing, p, h, wire = wired(tmp_path, base_offline=lambda: off[0], audio_fault=lambda: fault[0], host_power=lambda: pw[0])
    wire.tick(); assert got(h, 'system') == []                                                                      # nothing changed since attach
    off[0] = True; wire.tick(); (m,) = got(h, 'system')
    assert (m['base'], m['recovering'], m['session_id'], m['session_mode'], m['banner'], m['acknowledged_ts']) == ('offline', True, 1, 'LIVE', None, None)
    wire.tick(); assert len(got(h, 'system')) == 1
    off[0], fault[0], pw[0], w.logging_fault = False, True, 'battery', True; p.set_recovering(False); wire.tick(); m = got(h, 'system')[-1]
    assert len(got(h, 'system')) == 2 and (m['base'], m['recovering'], m['audio_fault'], m['host_power'], m['logging_fault']) == ('ok', False, True, 'battery', True); w.stop()

def test_the_rejected_frame_count_goes_out_with_the_tick_and_not_more_often(tmp_path):                           # 3.8: rejected_frames, GV-04
    c, w, clock, ing, p, h, wire = wired(tmp_path); wait(w, send(ing, clock, pack(seq=5, key=WRONG_KEY), base='BAD_MAC').unit); assert got(h, 'system') == []
    wire.tick(); (m,) = got(h, 'system'); assert m['rejected_frames'] == 1
    wire.tick(); wait(w, send(ing, clock, pack(seq=6)).unit); wire.tick(); assert len(got(h, 'system')) == 1; w.stop()

def test_a_banner_acknowledgement_is_a_system_message_with_the_banner_and_the_time(tmp_path):                   # 3.8: BANNER_ACK
    c, w, clock, ing, p, h, wire = wired(tmp_path); p.set_host_gap(12.5, 'db_restored'); wire.tick(); assert got(h, 'system')[-1]['host_gap'] == {'gap_s': 12.5, 'reason': 'db_restored'}
    n = len(got(h, 'system')); clock.advance(5); p.ack_banner('host_gap', 1); m = got(h, 'system')[-1]
    assert len(got(h, 'system')) == n + 1 and (m['banner'], m['acknowledged_ts'], m['host_gap']) == ('host_gap', clock.wall_ms(), None)
    wire.tick(); assert len(got(h, 'system')) == n + 1                                                              # the tick does not repeat it
    w.logging_fault = True; wire.tick(); p.ack_banner('logging_fault', 1); m = got(h, 'system')[-1]; assert (m['banner'], m['logging_fault']) == ('logging_fault', True); w.stop()
`);
  append('docs/PROGRESS.md', "- Part 24-3b-2b-i done: link messages (Wire.link_state from the engine: not_connected, ok, weak_signal, signal_lost, link_lost, recovered; one message per change, the snapshot uses the same function) and system messages (base, recovering, session, banner sources; rejected_frames with the tick only; BANNER_ACK at once from HostPort.ack_banner), sent only to a hub that has publish_link and publish_system, host/tests/test_wire_2b1.py (5 tests); advisory rows and message are P24-3b-2b-ii, ADR 0033 is P24-3b-2b-iii");
}
