// patches/part24_5f2_finish.mjs  (run from repo root: node patches/part24_5f2_finish.mjs [--dry])
// P24-5f, second half (ADR 0051). The host code of 5f is already in the repo (wire.py, models.py, api_rest.py, their tests).
// This adds what was missing: catalog entry, ws.schema.json, gen/ws.ts, reducer, dashboard tests, e2e mock, ADR 0051, PROGRESS entry.
// Every edit is checked before anything is written; a second run changes nothing.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd(), DRY = process.argv.includes('--dry');
const abs = (p) => path.join(ROOT, p);
const rd = (p) => fs.readFileSync(abs(p), 'utf8');
if (!fs.existsSync(abs('host/migrations/0002.sql')) || !fs.existsSync(abs('docs/adr/0050.md'))) { console.error('WRONG BASE: 0002.sql or 0050.md missing (need P24-5e)'); process.exit(1); }
if (!rd('host/ppe_host/wire.py').includes('abi_mismatch')) { console.error('WRONG BASE: wire.py has no abi_mismatch (need the 5f host files)'); process.exit(1); }

const edits = new Map(); // path -> content
const cur = (p) => edits.has(p) ? edits.get(p) : (fs.existsSync(abs(p)) ? rd(p) : null);
const log = [], errors = [];
function sub(p, label, done, fn) {
  const s = cur(p);
  if (s === null) { if (p.startsWith('docs/adr/')) { edits.set(p, fn('')); log.push(`create    ${p}`); } else errors.push(`${p}: file missing`); return; }
  if (done(s)) { log.push(`skip      ${p} (${label})`); return; }
  const r = fn(s);
  if (r === null || r === s) { errors.push(`${p}: anchor not found for "${label}"`); return; }
  edits.set(p, r); log.push(`edit      ${p} (${label})`);
}
const rep = (p, label, from, to) => sub(p, label, (s) => s.includes(to), (s) => s.includes(from) ? s.replace(from, to) : null);

// 1. catalog: 32 -> 33 entries
sub('shared/alert_catalog.json', 'abi_mismatch entry', (s) => s.includes('"abi_mismatch"'), (s) => {
  const tail = '"text":"AUDIO FAULT: host alarm sound cannot play, check the speakers"}]';
  if (!s.includes(tail)) return null;
  return s.replace(tail, tail.slice(0, -1) + ',{"type":"abi_mismatch","owner":"system_banner","class":"system","allowed_levels":["NONE","WARNING"],"default_level":"NONE","sound_by_level":{"NONE":"none","WARNING":"none"},"show":"banner","badge_order":33,"text":"ABI MISMATCH: base firmware and host disagree on the beacon format, update the base or the host"}]');
});

// 2. ws.schema.json (what tools/gen_ws_schema.py writes): property and required entry, in Banners and in the system message
sub('shared/ws.schema.json', 'abi_mismatch property', (s) => s.includes('"abi_mismatch"'), (s) => {
  const re = /( *)"audio_fault": \{\n( *)"title": "Audio Fault",\n *"type": "boolean"\n *\}/g;
  if (!re.test(s)) return null;
  s = s.replace(re, (m, i1, i2) => m + `,\n${i1}"abi_mismatch": {\n${i2}"title": "Abi Mismatch",\n${i2}"type": "boolean"\n${i1}}`);
  return s.replace(/^( *)"audio_fault"(,?)$/gm, (m, i1, c) => `${i1}"audio_fault",\n${i1}"abi_mismatch"${c}`);
});

// 3. dashboard/src/gen/ws.ts
sub('dashboard/src/gen/ws.ts', 'abi_mismatch fields', (s) => s.includes('abi_mismatch'), (s) => s.includes('  audio_fault: boolean;\n') ? s.split('  audio_fault: boolean;\n').join('  audio_fault: boolean;\n  abi_mismatch: boolean;\n') : null);

// 4. reducer
rep('dashboard/src/store/reducer.ts', 'carry the flag', 'host_power: m.host_power, audio_fault: m.audio_fault,', 'host_power: m.host_power, audio_fault: m.audio_fault, abi_mismatch: m.abi_mismatch,');

// 5. dashboard tests that build a Banners / system message / snapshot
rep('dashboard/tests/helpers.ts', 'banners default', "host_power: 'ac', audio_fault: false }", "host_power: 'ac', audio_fault: false, abi_mismatch: false }");
rep('dashboard/tests/layout_ui.test.tsx', 'ALL banners', "audio_fault: true };", "audio_fault: true, abi_mismatch: false };");
rep('dashboard/tests/reducer.test.ts', 'system message', "audio_fault: false, banner: 'logging_fault'", "audio_fault: false, abi_mismatch: false, banner: 'logging_fault'");
rep('dashboard/tests/banners.test.ts', 'Banners helper', "host_power: 'ok', audio_fault: false, ...o", "host_power: 'ok', audio_fault: false, abi_mismatch: false, ...o");
rep('dashboard/tests/banners_ui.test.tsx', 'banners helper', "host_power: 'ok', audio_fault: false, ...o", "host_power: 'ok', audio_fault: false, abi_mismatch: false, ...o");
rep('e2e/mock_host.mjs', 'mock banners', "host_power: 'ac', audio_fault: false }", "host_power: 'ac', audio_fault: false, abi_mismatch: false }");

// 6. catalog test: 33 entries, 8 banners, the new banner has no 3.4 row yet (same gap as audio_fault)
const CT = 'dashboard/tests/catalog.test.ts';
rep(CT, 'title', "loads the 32 entries: 25 alert types and 7 banners", "loads the 33 entries: 25 alert types and 8 banners");
rep(CT, 'length', "expect(CATALOG).toHaveLength(32);", "expect(CATALOG).toHaveLength(33);");
rep(CT, 'banner list', "toEqual(['audio_fault', 'base_offline',", "toEqual(['abi_mismatch', 'audio_fault', 'base_offline',");
rep(CT, 'skip rows', "if (e.type === 'audio_fault') continue; // gap, see the next test", "if (e.type === 'audio_fault' || e.type === 'abi_mismatch') continue; // gap, see the next tests");
rep(CT, 'badge title', "run 1 to 32'", "run 1 to 33'");
rep(CT, 'badge length', "{ length: 32 }", "{ length: 33 }");
rep(CT, 'rows test title', "the 6 banners other than audio_fault each have a 3.4 row", "the 6 banners other than audio_fault and abi_mismatch each have a 3.4 row");
rep(CT, 'rows test body', "BANNERS.filter((x) => x.type !== 'audio_fault')", "BANNERS.filter((x) => x.type !== 'audio_fault' && x.type !== 'abi_mismatch')");
sub(CT, 'it.fails abi_mismatch', (s) => s.includes("it.fails('the abi_mismatch banner"), (s) => {
  const a = "  it.fails('the audio_fault banner has a 3.4 row', () => {\n    expect(ROW.has('audio_fault')).toBe(true);\n  });\n";
  return s.includes(a) ? s.replace(a, a + "  // Same gap for abi_mismatch (ADR 0051): the proposed 3.4 row is in the ADR. Remove \".fails\" when the design has it.\n  it.fails('the abi_mismatch banner has a 3.4 row', () => {\n    expect(ROW.has('abi_mismatch')).toBe(true);\n  });\n") : null;
});

// 7. host test counts that name the banners
rep('host/tests/test_api_models.py', 'comment', "the other 7 rows are system banners", "the other 8 rows are system banners");

// 8. ADR 0051 and PROGRESS
const ADR = 'docs/adr/0051.md';
const adrText = `# ADR 0051: the ABI_MISMATCH banner, host side (P24-5f)

Status: Proposed (decided in the P24-5 session; follows ADR 0050, which left the banner as a follow-on stage).
Design: Rev 3.45 3.4 (banners), 3.12 (completeness rule), firmware note 4.

- **Flag.** \`banners.abi_mismatch\` (boolean) is added after \`audio_fault\` in the \`system\` message and in the snapshot \`banners\`. Wire reads it from \`Ingest.fw_state.mismatch\` (FwState of ADR 0050); a callable can replace the source, like the other banner flags. False until the base reports an abi. A heartbeat without an abi does not clear it; a new session starts clean and reports again.
- **Edge.** A \`system\` message is sent when the flag changes, like the other flags, never on a steady heartbeat.
- **Catalog.** \`abi_mismatch\` is added to \`shared/alert_catalog.json\` (32 to 33 entries, owner system_banner, levels NONE and WARNING, default NONE, no sound, badge_order 33) and to \`BANNER_KINDS\`. It is not acknowledgeable (the ack allowlist stays host_gap and logging_fault): the ack route returns 400. The banner stays while the mismatch lasts.
- **Generated files.** ws.schema.json and dashboard/src/gen/ws.ts carry the field; tools/gen_ws_schema.py writes the same output.
- **Dashboard in this stage.** Only the reducer carries the flag, and the test fixtures and the e2e mock host include it, so the type check stays green. Showing the banner is P24-5g.
- **Design gap.** Table 3.4 has no ABI MISMATCH row (the same gap as AUDIO FAULT, ADR 0015). Catalog.test.ts marks it with \`it.fails\`. Proposed row: ABI MISMATCH | banner, system_events only | WARNING | no sound | text as in the catalog.
- **Not here.** The banner on screen (5g); the firmware change that sends fw and abi [BENCH]; a \`cli doctor\` row.
`;
sub(ADR, 'create', () => true, () => adrText);
const PROG = 'docs/PROGRESS.md';
sub(PROG, 'append', (s) => s.includes('Part 24-5f done'), (s) => s.replace(/\n*$/, '\n') + "- Part 24-5f done (ADR 0051; host side of the ABI_MISMATCH banner): `banners.abi_mismatch` in the system message and the snapshot (Wire reads Ingest.fw_state.mismatch, replaceable like the other flags), models.py, BANNER_KINDS and alert_catalog.json (33 entries, not acknowledgeable, no sound), ws.schema.json and gen/ws.ts, the reducer, test fixtures and the e2e mock host, host/tests/test_abi_banner.py (7 tests). Open: the banner on screen (5g), the firmware change [BENCH], the missing 3.4 row (it.fails in catalog.test.ts), a cli doctor row.\n");


if (errors.length) { console.error('NOTHING WRITTEN. Problems:\n  ' + errors.join('\n  ')); process.exit(1); }
for (const [p, c] of edits) {
  if (!DRY) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c, 'utf8'); }
}
console.log(log.join('\n'));
console.log((DRY ? 'DRY RUN: ' : 'OK: ') + edits.size + ' file(s) ' + (DRY ? 'would be written' : 'written'));
