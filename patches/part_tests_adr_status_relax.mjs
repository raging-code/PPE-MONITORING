// patches/part_tests_adr_status_relax.mjs  (run from repo root: node patches/part_adr0067_audio_probe_result.mjs [--dry] [--force])
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
replace("host/tests/test_serial_drain.py", "'Status: Proposed' in adr", "('Status: Proposed' in adr or 'Status: Decided' in adr)");
replace("host/tests/test_replay.py", "'Status: Proposed' in adr", "('Status: Proposed' in adr or 'Status: Decided' in adr)");
replace("host/tests/test_simulator.py", "'Status: Proposed' in adr", "('Status: Proposed' in adr or 'Status: Decided' in adr)");
replace("host/tests/test_adr0033.py", "'Status: Proposed' in t", "('Status: Proposed' in t or 'Status: Decided' in t)");
replace("host/tests/test_adr0034.py", "'Status: Proposed' in t", "('Status: Proposed' in t or 'Status: Decided' in t)");
replace("host/tests/test_adr0035.py", "'Status: Proposed' in t", "('Status: Proposed' in t or 'Status: Decided' in t)");
replace("host/tests/test_adr0036.py", "'Status: Proposed' in t", "('Status: Proposed' in t or 'Status: Decided' in t)");
append('docs/PROGRESS.md', "- ADR status tests relaxed (tests only; prepares the design review): seven host tests (test_adr0033, test_adr0034, test_adr0035, test_adr0036, test_simulator, test_serial_drain, test_replay) asserted 'Status: Proposed' in their ADR (0033, 0034, 0035, 0036, 0057, 0058, 0059). They now accept Proposed or Decided, so confirming those ADRs at the design review does not fail them. Nothing else in the tests, tools or doc_lint depends on the status word. No code, wire, setting or migration change.\n");
}
