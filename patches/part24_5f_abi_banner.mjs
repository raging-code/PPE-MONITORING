// patches/part24_5f_abi_banner.mjs  (run from the repo root: node patches/part24_5f_abi_banner.mjs [--dry] [--force])
// P24-5f (ADR 0051): the abi_mismatch banner, host side. Base: commit 20be49f (P24-5e). Needs 0002.sql, docs/adr/0050.md and services/fw_check.py; stops if they are missing.
// Edited: host/ppe_host/wire.py, api/models.py, api/api_rest.py, shared/alert_catalog.json (32 -> 33), shared/ws.schema.json and dashboard/src/gen/ws.ts (what tools/gen_ws_schema.py writes),
//   e2e/mock_host.mjs, dashboard/src/store/reducer.ts (carries the flag), fixtures and counts of 4 host tests and 5 dashboard tests, docs/PROGRESS.md.
// New: host/tests/test_abi_banner.py, docs/adr/0051.md. Not here (5g): the banner on screen (dashboard/src/alerts/banners.ts, SystemBanners, layout, e2e) and the 3.4 row in the design.
// All edits are checked first and written only if every anchor matches (all or nothing). Running it twice is safe.
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
      if (cur !== null && cur !== s.content && !FORCE) throw new Error(`EXISTS with other content (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : cur === s.content ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) {
      throw new Error(`MISSING file: ${s.p}`);
    } else if (s.op === 'replace') {
      const n = cur.split(s.oldStr).length - 1;
      if (cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
      else throw new Error(`ANCHOR found ${n} times in ${s.p}: ${s.oldStr.slice(0, 70)}`);
    } else if (s.op === 'append') {
      if (cur.includes(s.text)) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : '\n') + s.text + '\n'); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : `OK: ${state.size} file(s) written`);
}
try { run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }

function run() {
  for (const need of ['host/migrations/0002.sql', 'docs/adr/0050.md', 'host/ppe_host/services/fw_check.py'])
    if (!fs.existsSync(abs(need))) throw new Error(`WRONG BASE: ${need} is missing. This patch needs the repo at P24-5e (commit 20be49f).`);

  // ---- host: models (the generated files below follow from these lines) ----
  const M = 'host/ppe_host/api/models.py';
  replace(M, '    audio_fault: bool\n\n# ---- host to dashboard ----', "    audio_fault: bool\n    abi_mismatch: bool       # P24-5f (ADR 0051): the base reports a beacon ABI that differs from the host's\n\n# ---- host to dashboard ----");
  replace(M, '    audio_fault: bool\n    banner: Optional[BannerKind]', '    audio_fault: bool\n    abi_mismatch: bool\n    banner: Optional[BannerKind]');

  // ---- host: wire (default source is the Ingest's FwState; injectable like the other three) ----
  const W = 'host/ppe_host/wire.py';
  replace(W, 'def __init__(self, port, hub, base_offline=None, audio_fault=None, host_power=None):', 'def __init__(self, port, hub, base_offline=None, audio_fault=None, host_power=None, abi_mismatch=None):');
  replace(W, "        self.audio_fault, self.host_power = audio_fault or (lambda: False), host_power or (lambda: 'ac')\n",
    "        self.audio_fault, self.host_power = audio_fault or (lambda: False), host_power or (lambda: 'ac')\n" +
    "        self.abi_mismatch = abi_mismatch or (lambda: bool(getattr(self.ing.fw_state, 'mismatch', False)))   # P24-5f (ADR 0051): FwState of P24-5e; false until the base reports an abi\n");
  replace(W, 'audio_fault=bool(self.audio_fault()), banner=banner, acknowledged_ts=ack)', 'audio_fault=bool(self.audio_fault()), abi_mismatch=bool(self.abi_mismatch()), banner=banner, acknowledged_ts=ack)');
  replace(W, 'audio_fault=bool(self.audio_fault())), constants=dict(K.CONSTANTS))', 'audio_fault=bool(self.audio_fault()), abi_mismatch=bool(self.abi_mismatch())), constants=dict(K.CONSTANTS))');

  // ---- host: the banner is a known kind for the ack route (not on the allowlist: known but not ackable is 400) ----
  replace('host/ppe_host/api/api_rest.py', "'host_power', 'audio_fault')  # the banners of alert_catalog.json", "'host_power', 'audio_fault', 'abi_mismatch')  # the banners of alert_catalog.json");

  // ---- shared: catalog entry (same shape as audio_fault; system_events only, never in alerts) ----
  replace('shared/alert_catalog.json', 'check the speakers"}]',
    'check the speakers"},{"type":"abi_mismatch","owner":"system_banner","class":"system","allowed_levels":["NONE","WARNING"],"default_level":"NONE","sound_by_level":{"NONE":"none","WARNING":"none"},"show":"banner","badge_order":33,"text":"BASE FIRMWARE MISMATCH: base ABI differs from the host, update the base firmware"}]');

  // ---- generated files: what tools/gen_ws_schema.py writes for the two model lines (run it afterwards: git diff must be empty) ----
  const S = 'shared/ws.schema.json';
  const FLD = '        "abi_mismatch": {\n          "title": "Abi Mismatch",\n          "type": "boolean"\n        }';
  const AF = '        "audio_fault": {\n          "title": "Audio Fault",\n          "type": "boolean"\n        }';
  replace(S, AF + '\n      },\n      "required": [', AF + ',\n' + FLD + '\n      },\n      "required": [');
  replace(S, '        "host_power",\n        "audio_fault"\n      ],\n      "title": "Banners"', '        "host_power",\n        "audio_fault",\n        "abi_mismatch"\n      ],\n      "title": "Banners"');
  replace(S, AF + ',\n        "banner": {', AF + ',\n' + FLD + ',\n        "banner": {');
  replace(S, '        "audio_fault",\n        "banner",', '        "audio_fault",\n        "abi_mismatch",\n        "banner",');
  replace('dashboard/src/gen/ws.ts', '  audio_fault: boolean;\n}\n\nexport interface EpisodeBody', '  audio_fault: boolean;\n  abi_mismatch: boolean;\n}\n\nexport interface EpisodeBody');
  replace('dashboard/src/gen/ws.ts', '  audio_fault: boolean;\n  banner: ', '  audio_fault: boolean;\n  abi_mismatch: boolean;\n  banner: ');
  replace('e2e/mock_host.mjs', "host_power: 'ac', audio_fault: false }", "host_power: 'ac', audio_fault: false, abi_mismatch: false }");

  // ---- dashboard: only what keeps tsc and Vitest green; showing the banner is 5g ----
  replace('dashboard/src/store/reducer.ts', 'host_power: m.host_power, audio_fault: m.audio_fault,', 'host_power: m.host_power, audio_fault: m.audio_fault, abi_mismatch: m.abi_mismatch,');
  replace('dashboard/tests/helpers.ts', "host_power: 'ac', audio_fault: false }", "host_power: 'ac', audio_fault: false, abi_mismatch: false }");
  replace('dashboard/tests/banners.test.ts', "host_power: 'ok', audio_fault: false, ...o })", "host_power: 'ok', audio_fault: false, abi_mismatch: false, ...o })");
  replace('dashboard/tests/layout_ui.test.tsx', "host_power: 'battery 40', audio_fault: true };", "host_power: 'battery 40', audio_fault: true, abi_mismatch: false };");
  replace('dashboard/tests/reducer.test.ts', "audio_fault: false, banner: 'logging_fault', acknowledged_ts: 1999 };", "audio_fault: false, abi_mismatch: true, banner: 'logging_fault', acknowledged_ts: 1999 };");
  replace('dashboard/tests/reducer.test.ts', '    expect(s.banners?.logging_fault).toBe(true);\n', '    expect(s.banners?.logging_fault).toBe(true);\n    expect(s.banners?.abi_mismatch).toBe(true);\n');
  const C = 'dashboard/tests/catalog.test.ts';
  replace(C, "it('loads the 32 entries: 25 alert types and 7 banners', () => {\n    expect(CATALOG).toHaveLength(32);", "it('loads the 33 entries: 25 alert types and 8 banners', () => {\n    expect(CATALOG).toHaveLength(33);");
  replace(C, "toEqual(['audio_fault', 'base_offline',", "toEqual(['abi_mismatch', 'audio_fault', 'base_offline',");
  replace(C, "if (e.type === 'audio_fault') continue; // gap, see the next test", "if (e.type === 'audio_fault' || e.type === 'abi_mismatch') continue; // gaps, see the it.fails tests below");
  replace(C, "run 1 to 32', () => {", "run 1 to 33', () => {");
  replace(C, '{ length: 32 }', '{ length: 33 }');
  replace(C, "it('the 6 banners other than audio_fault each have a 3.4 row', () => {\n    for (const b of BANNERS.filter((x) => x.type !== 'audio_fault'))", "it('the 6 banners other than audio_fault and abi_mismatch each have a 3.4 row', () => {\n    for (const b of BANNERS.filter((x) => x.type !== 'audio_fault' && x.type !== 'abi_mismatch'))");
  replace(C, "  it.fails('the audio_fault banner has a 3.4 row', () => {\n    expect(ROW.has('audio_fault')).toBe(true);\n  });\n",
    "  it.fails('the audio_fault banner has a 3.4 row', () => {\n    expect(ROW.has('audio_fault')).toBe(true);\n  });\n" +
    "  // Expected failure (ADR 0051): the same gap for the abi_mismatch banner. Remove \".fails\" when the row is added to the design.\n" +
    "  it.fails('the abi_mismatch banner has a 3.4 row', () => {\n    expect(ROW.has('abi_mismatch')).toBe(true);\n  });\n");

  // ---- host tests: fixtures and counts that name the banner set ----
  replace('host/tests/test_api_models.py', "'audio_fault': False, 'banner': None, 'acknowledged_ts': None}", "'audio_fault': False, 'abi_mismatch': False, 'banner': None, 'acknowledged_ts': None}");
  replace('host/tests/test_api_models.py', "'host_power': 'ac', 'audio_fault': False}, 'constants': CONSTANTS}", "'host_power': 'ac', 'audio_fault': False, 'abi_mismatch': False}, 'constants': CONSTANTS}");
  replace('host/tests/test_api_models.py', '"host_power":"ac","audio_fault":false},', '"host_power":"ac","audio_fault":false,"abi_mismatch":false},');
  replace('host/tests/test_api_scba_banner.py', "['no_live_data', 'base_offline', 'recovering', 'host_power', 'audio_fault'])", "['no_live_data', 'base_offline', 'recovering', 'host_power', 'audio_fault', 'abi_mismatch'])");
  replace('host/tests/test_api_scba_banner.py', 'len(R.BANNER_KINDS) == 7', 'len(R.BANNER_KINDS) == 8');
  replace('host/tests/test_ws_hub.py', "host_power='ac', audio_fault=False), constants=", "host_power='ac', audio_fault=False, abi_mismatch=False), constants=");
  replace('host/tests/test_ws_hub.py', 'audio_fault=False, banner=None, acknowledged_ts=None)', 'audio_fault=False, abi_mismatch=False, banner=None, acknowledged_ts=None)');
  replace('host/tests/test_wire.py', "'host_power': 'ac', 'audio_fault': False} and s['constants']", "'host_power': 'ac', 'audio_fault': False, 'abi_mismatch': False} and s['constants']");

  put('host/tests/test_abi_banner.py', String.raw`"""P24-5f (ADR 0051): the abi_mismatch banner. A heartbeat through the real Ingest sets FwState, and Wire carries the flag to the system message and the snapshot banners.
Same rig as test_wire_2b1 (real DBWriter, database, HostPort, fake hub; every body is validated against the WsMessage models). Requirements: REQ-ING-003, REQ-API-007."""
from ppe_host import abi as host_abi
from ppe_host.api import models as M
from ppe_host.io.serial_reader import Heartbeat
from test_wire import got
from test_wire_2b1 import wired

GOOD, BAD = host_abi.BEACON_ABI_VER, host_abi.BEACON_ABI_VER + 1

def beat(ing, clock, fw=None, abi=None):
    clock.advance(1000); ing.heartbeat(Heartbeat(1, 1000, 85, 1, 0, 0, 0, 1, fw, abi))
def flag(wire): return wire.snapshot()['banners']['abi_mismatch']

def test_a_matching_or_missing_abi_sends_no_system_message_and_the_snapshot_flag_is_false(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    beat(ing, clock); wire.tick(); beat(ing, clock, '1.3.0', GOOD); wire.tick()
    assert got(h, 'system') == [] and flag(wire) is False; w.stop()

def test_a_reported_abi_that_differs_is_one_system_message_and_the_snapshot_flag_is_true(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    beat(ing, clock, '1.3.0', BAD); wire.tick(); (m,) = got(h, 'system')
    assert m['abi_mismatch'] is True and m['banner'] is None and flag(wire) is True
    beat(ing, clock, '1.3.0', BAD); wire.tick(); assert len(got(h, 'system')) == 1                                   # a steady mismatch is not repeated
    w.stop()

def test_the_banner_clears_with_one_system_message_when_the_abi_agrees_again(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    beat(ing, clock, '1.3.0', BAD); wire.tick(); beat(ing, clock, '1.3.0', GOOD); wire.tick()
    assert [m['abi_mismatch'] for m in got(h, 'system')] == [True, False] and flag(wire) is False; w.stop()

def test_a_heartbeat_without_abi_does_not_clear_a_mismatch(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    beat(ing, clock, '1.3.0', BAD); beat(ing, clock); wire.tick(); assert flag(wire) is True and len(got(h, 'system')) == 1; w.stop()

def test_a_new_session_reports_the_mismatch_again_and_the_banner_stays_on(tmp_path):
    from test_db_schema import session
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    beat(ing, clock, '1.3.0', BAD); wire.tick(); assert flag(wire) is True
    c.execute("UPDATE sessions SET ended_ts = 2, end_kind = 'ENDED' WHERE session_id = 1"); session(c, 2); ing.session_id = 2
    beat(ing, clock, '1.3.0', BAD); wire.tick(); assert flag(wire) is True; w.stop()                                # reported again in the new session

def test_an_explicit_source_replaces_the_fw_state(tmp_path):
    on = [False]; c, w, clock, ing, p, h, wire = wired(tmp_path, abi_mismatch=lambda: on[0])
    wire.tick(); assert got(h, 'system') == []
    on[0] = True; wire.tick(); (m,) = got(h, 'system'); assert m['abi_mismatch'] is True and flag(wire) is True; w.stop()

def test_the_snapshot_with_the_flag_is_a_valid_snapshot_message(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); beat(ing, clock, '1.3.0', BAD)
    s = wire.snapshot(); M.parse_server(dict(s, v=1, type='snapshot', srv_seq=0, srv_ts=1, epoch='5d1f7c3a-2b64-4e0f-9a51-3c7e8d2b6a10')); w.stop()
`);

  put('docs/adr/0051.md', `# ADR 0051: the abi_mismatch banner, host side (P24-5f)

Status: Proposed (the follow-on stage that ADR 0050 left open).
Design: Rev 3.45 is frozen. This changes two shared contracts it names (shared/alert_catalog.json and shared/ws.schema.json) the same way ADR 0015 handled audio_fault, because table 3.4 has no row for a base-firmware banner.

- **Banner.** \`abi_mismatch\`, owner system_banner, class system, levels NONE or WARNING (default NONE), sound none, shows as Banner, badge_order 33. Catalog 32 to 33 entries (25 alert types, 8 banners). It is host state only: no alerts row, no audio, never acknowledgeable (the allowlist of 3.8 stays host_gap and logging_fault, so the ack route answers 400 for it, as for audio_fault).
- **Source.** The state of P24-5e: \`Ingest.fw_state.mismatch\`, set by a heartbeat whose \`abi\` differs from BEACON_ABI_VER and cleared by one that agrees. A heartbeat without \`abi\` changes nothing, so old firmware shows no banner and a mismatch is not cleared by silence. A new session starts a new FwState with its next heartbeat; the banner stays on until then and is reported again, because the base, not the session, carries the ABI. \`Wire(abi_mismatch=callable)\` replaces the source, like the other three flags.
- **Wire.** A new boolean \`abi_mismatch\` after \`audio_fault\` in the system message and in the snapshot \`banners\` object (models.py Banners and SystemMsg; ws.schema.json and dashboard/src/gen/ws.ts regenerate). It is part of the system-message key, so a change sends one system message and a steady state sends none.
- **No design row.** Rev 3.45 table 3.4 has no row for it. Proposed row: BASE FIRMWARE MISMATCH (system) [abi_mismatch] | The base heartbeat reports a beacon ABI that differs from the host's | BASE FIRMWARE MISMATCH: base ABI differs from the host, update the base firmware | None (visual only) | Banner (system_events only; never in alerts table). Vitest marks the missing row with it.fails, as for audio_fault; remove \`.fails\` when the design has the row.
- **Dashboard.** Only what keeps tsc and Vitest green: the reducer carries the flag and the fixtures and catalog counts change. Showing the banner (banners.ts, SystemBanners, layout and e2e) is P24-5g.
- **Effect on hashes.** constants_hash covers constants.json only, so no session is abandoned. The alert_catalog hash in build_manifest.json changes, as it should.
- **Not here.** The firmware change [BENCH]; \`cli doctor\` rows.
`);

  append('docs/PROGRESS.md', '- Part 24-5f done (ADR 0051; host side of the ABI_MISMATCH banner): a boolean `abi_mismatch` after `audio_fault` in the system message and in the snapshot banners (models.py; ws.schema.json and dashboard/src/gen/ws.ts regenerated), Wire reads it from Ingest.fw_state (injectable like the other banner flags), BANNER_KINDS and alert_catalog.json gain `abi_mismatch` (32 to 33 entries, badge_order 33; not ackable, 400 on the ack route), the reducer carries the flag and the dashboard fixtures and catalog counts are updated so tsc and Vitest stay green; the 3.4 row is missing in the design (it.fails, as for audio_fault). 7 tests in host/tests/test_abi_banner.py. Open: P24-5g, the banner on screen (banners.ts, SystemBanners, layout, e2e), and the firmware change [BENCH].');
}
