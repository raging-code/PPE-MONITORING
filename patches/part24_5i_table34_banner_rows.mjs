// patches/part24_5i_table34_banner_rows.mjs  (run from repo root: node patches/part24_5i_table34_banner_rows.mjs [--dry] [--force])
// P24-5i (ADR 0054): table 3.4 gets the AUDIO FAULT and BASE FIRMWARE MISMATCH rows; the two it.fails tests become normal tests. New: docs/adr/0054.md.
// Edited: docs/design/s03-4.md, dashboard/tests/catalog.test.ts, docs/adr/0015.md, 0051.md, docs/design/INDEX.md, docs/PROGRESS.md (anchored replaces and appends; line endings of the file are kept, so CRLF files work). Idempotent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
const putB64 = (p, b64) => put(p, Buffer.from(b64, 'base64').toString('utf8'));
const replace = (p, oldStr, newStr) => plan.push({ op: 'replace', p, oldStr, newStr });
const append = (p, text) => plan.push({ op: 'append', p, text });
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const swap = (p, oldSha, newB64) => plan.push({ op: 'swap', p, oldSha, content: Buffer.from(newB64, 'base64').toString('utf8') });
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
    } else if (s.op === 'swap') {
      const lf = cur.replace(/\r\n/g, '\n');
      if (lf === s.content) log.push(`skip      ${s.p} (already applied)`);
      else if (sha(lf) === s.oldSha || FORCE) { state.set(s.p, s.content); log.push(`edit      ${s.p}`); }
      else throw new Error(`${s.p} is not the version this patch expects (sha ${sha(lf).slice(0, 12)}); apply earlier parts first or use --force`);
    } else if (s.op === 'replace') {
      const crlf = cur.includes('\r\n'), fix = (x) => (crlf ? x.replace(/\r?\n/g, '\r\n') : x);
      const o = fix(s.oldStr), w = fix(s.newStr);
      const n = cur.split(o).length - 1;
      if (cur.includes(w)) log.push(`skip      ${s.p} (already applied)`);
      else if (n === 1) { state.set(s.p, cur.replace(o, () => w)); log.push(`edit      ${s.p}`); }
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




// ---- write only this part below ----
const ROW_AUDIO = "| AUDIO FAULT (system) [audio_fault] | The host audio self-check fails: a playback call raises (no device, device removed), or (optional, 3.12 c) the endpoint is muted or below host_volume_min_pct | AUDIO FAULT: host alarm sound cannot play, check the speakers | None (visual only, 3.3) | Banner (system_events only; never in alerts table) |";
const ROW_ABI = "| BASE FIRMWARE MISMATCH (system) [abi_mismatch] | The base heartbeat reports a beacon ABI that differs from the host's (ADR 0050, ADR 0051). Cleared by a heartbeat that agrees; a heartbeat without an ABI changes nothing | BASE FIRMWARE MISMATCH: base ABI differs from the host, update the base firmware | None (visual only) | Banner, not acknowledgeable (system_events only; never in alerts table) |";
const ADR = `# ADR 0054: table 3.4 gains the AUDIO FAULT and BASE FIRMWARE MISMATCH rows (P24-5i)

Status: Proposed (closes the design gap named in ADR 0015 and ADR 0051; confirm at the next design review).
Design: Rev 3.45 stays frozen. No frame, beacon, migration, constants.json, setting, wire field or catalog entry changes. Design changes go in an ADR (Coding Guide), so this one amends table 3.4 of 3.4 and the completeness sentence under it.

- **Gap.** The completeness rule under table 3.4 says every banner of alert_catalog.json has a row and a test fails if one does not. Two banners had none: \`audio_fault\` (3.12 d adds it to the catalog but not to 3.4; ADR 0015) and \`abi_mismatch\` (ADR 0051). Vitest marked both with \`it.fails\`.
- **Rows added** to docs/design/s03-4.md after HOST POWER, in badge order 32 and 33, with the pop-up text copied from alert_catalog.json:
  - AUDIO FAULT (system) [audio_fault]: raised by the 3.12 b self-check (and, if adopted, the 3.12 c endpoint check); sound None (visual only); Banner, system_events only.
  - BASE FIRMWARE MISMATCH (system) [abi_mismatch]: raised by a heartbeat whose ABI differs; sound None (visual only); Banner that is not acknowledgeable, system_events only.
- **Completeness sentence.** "7 banners including audio_fault, 3.12" becomes "8 banners including audio_fault, 3.12, and abi_mismatch, ADR 0051". The 3.12 d sentence "banners 6 to 7, total 32 entries" is a count at Rev 3.45 and is left as written; the catalog now has 33 entries (25 alert types, 8 banners).
- **Which file is the record.** The .docx of Rev 3.45 is not edited here, because the design is frozen and no new full revision is planned (13.1). docs/design/s03-4.md is the text the completeness test reads, so it carries the two rows and the amended sentence, and docs/design/INDEX.md says so. If the two files disagree, this ADR is the reason. A later design revision should copy the two rows and the sentence into the .docx and then this note can go.
- **Tests.** catalog.test.ts: the two \`it.fails\` tests and the exemption in the sound and Shows-as check are removed. The loop now checks both rows like every other banner (sound word, Shows-as value, "system_events only"), and one test says that all 8 banners have a 3.4 row. Nothing outside that file reads the table.
- **Not here.** The firmware change (\`fw\` and \`abi\` on the \`hb\` line) [BENCH]. The 3.12 c Windows endpoint check stays Proposed as the design states it.
`;

async function run() {
  const D = 'docs/design/s03-4.md';
  const base = fs.existsSync(abs(D)) ? fs.readFileSync(abs(D), 'utf8').replace(/\r\n/g, '\n') : '';
  const hp = base.split('\n').find((l) => l.startsWith('| HOST POWER (system) [host_power]'));
  if (!hp) throw new Error('HOST POWER row not found in ' + D);
  replace(D, hp, hp + '\n' + ROW_AUDIO + '\n' + ROW_ABI);
  replace(D, '(7 banners including audio_fault, 3.12)', '(8 banners including audio_fault, 3.12, and abi_mismatch, ADR 0051)');

  const T = 'dashboard/tests/catalog.test.ts';
  replace(T, "      if (e.type === 'audio_fault' || e.type === 'abi_mismatch') continue; // gaps, see the it.fails tests below\n", '');
  const t = fs.readFileSync(abs(T), 'utf8').replace(/\r\n/g, '\n');
  const a = t.indexOf("  it('the 6 banners other than audio_fault");
  const b = t.indexOf("});\n", t.indexOf("it.fails('the abi_mismatch banner"));
  if (a < 0 || b < 0) { if (!t.includes("every one of the 8 banners has a 3.4 row")) throw new Error('catalog.test.ts is not the version this patch expects'); }
  else {
    const old = t.slice(a, b + 4);
    replace(T, old, "  it('every one of the 8 banners has a 3.4 row (ADR 0054)', () => {\n    expect(BANNERS).toHaveLength(8);\n    for (const b of BANNERS) expect(ROW.has(b.type), b.type).toBe(true);\n  });\n");
  }

  put('docs/adr/0054.md', ADR);
  append('docs/adr/0015.md', '\n- **Closed by ADR 0054 (P24-5i):** table 3.4 now has the AUDIO FAULT row and the it.fails test is a normal test.\n');
  append('docs/adr/0051.md', '\n- **Closed by ADR 0054 (P24-5i):** table 3.4 now has the BASE FIRMWARE MISMATCH row and the it.fails test is a normal test.\n');
  append('docs/design/INDEX.md', '\nAmendment (ADR 0054): `s03-4.md` also carries two rows that Rev 3.45 lacks, AUDIO FAULT [audio_fault] and BASE FIRMWARE MISMATCH [abi_mismatch], and "8 banners" in the completeness sentence. The .docx is not edited (the design is frozen); the ADR is the record of the difference.\n');
  append('docs/PROGRESS.md', '- Part 24-5i done (ADR 0054): table 3.4 (docs/design/s03-4.md) gains the AUDIO FAULT and BASE FIRMWARE MISMATCH rows and "8 banners" in the completeness sentence; catalog.test.ts loses both it.fails tests and the exemption, and checks all 8 banners against a 3.4 row. No code, wire, catalog or migration change; the .docx stays at Rev 3.45. Open: the firmware heartbeat change [BENCH].\n');
}

try { await run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }
