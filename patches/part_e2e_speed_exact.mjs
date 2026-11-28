// patches/part_e2e_speed_exact.mjs  (run from repo root: node patches/part_adr0067_audio_probe_result.mjs [--dry] [--force])
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
      if (cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
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
const f = 'e2e/tests/replay_speed.spec.ts';
const cur = fs.readFileSync(abs(f), 'utf8');
// Playwright's name match is a case-insensitive substring, so 'Speed ×1' also matched 'Speed ×16'. exact: true matches the whole label only.
const next = cur
  .replace(/\{ name: 'Speed ×(1|4|16)' \}/g, "{ name: 'Speed ×$1', exact: true }")
  .replace(/\{ name: `Speed ×\$\{n\}` \}/g, "{ name: `Speed ×${n}`, exact: true }");
if (next === cur && !cur.includes("exact: true")) throw new Error('no Speed locator found in ' + f);
if (next !== cur) replace(f, cur, next);
append('docs/PROGRESS.md', "- E2E speed-button locators fixed (tests only): on the operator laptop 20 of 23 Playwright tests passed and 3 in e2e/tests/replay_speed.spec.ts failed with a strict-mode violation, because getByRole('button', { name: 'Speed ×1' }) is a substring match and also found 'Speed ×16'. All Speed locators in that spec now use exact: true. The dashboard was right and its buttons are unchanged; no code, wire, setting or migration change. Also recorded: data/ppe.db held no sessions on 2026-11-28, so the REPLAY check against a real recorded session (Path B) waits for the first real recording.\n");
}
