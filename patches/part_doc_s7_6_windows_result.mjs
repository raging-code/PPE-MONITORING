// patches/part_doc_s7_6_windows_result.mjs  (run from repo root: node patches/part_adr0067_audio_probe_result.mjs [--dry] [--force])
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
append('docs/adr/0063.md', "\n## Windows result (2026-11-28)\n\nThe check this ADR asked for was run on a Windows laptop (Windows PowerShell): `python -m ppe_host.main --mode SIMULATOR`, one Ctrl+C after about 11 s, then `echo $LASTEXITCODE`.\n\n- The log said `stopped by signal SIGINT` once (the first Windows run of S7-4 logged it twice), then `host stopped, exit code 0`.\n- `$LASTEXITCODE` was `0`, not `-1073741510`. The fix of this ADR works for a single console Ctrl+C in SIMULATOR.\n\nNot covered by this one run: Ctrl+Break (SIGBREAK), SIGTERM and the supervisor on a real console; the `CancelledError` traceback of the first Windows run did not appear here either, but one clean run does not explain it. The `sessions.end_kind` and the last system events of the session were not read back in this run.\n");
append('docs/adr/0060.md', "\nThe Windows Ctrl+C check asked for above was run on 2026-11-28: exit code 0, see the Windows result in ADR 0063.\n");
replace('docs/design-review-agenda.md', "- [ ] S7-6 Ctrl+C exit code: `python -m ppe_host.main --mode SIMULATOR`, Ctrl+C once, then `echo $LASTEXITCODE` (ADR 0060 and 0063).", "- [x] S7-6 Ctrl+C exit code: `python -m ppe_host.main --mode SIMULATOR`, Ctrl+C once, then `echo $LASTEXITCODE` (ADR 0060 and 0063). Done 2026-11-28: exit code 0 and the log line `host stopped, exit code 0`.");
append('docs/PROGRESS.md', "- S7-6 Windows check recorded (docs only): on 2026-11-28 the host was run in SIMULATOR on a Windows laptop and stopped with one Ctrl+C; the log showed `stopped by signal SIGINT` once and `host stopped, exit code 0`, and `$LASTEXITCODE` was 0 (it was -1073741510 before S7-6). Recorded in ADR 0063 (Windows result) with a pointer in ADR 0060, and ticked in docs/design-review-agenda.md. Not covered: Ctrl+Break, SIGTERM, the supervisor on a real console, and reading the session row back. No code, wire, setting or migration change.\n");
}
