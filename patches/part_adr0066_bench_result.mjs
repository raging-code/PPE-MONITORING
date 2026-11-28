// patches/part_adr0066_bench_result.mjs  (run from repo root: node patches/part_adr0066_bench_result.mjs [--dry] [--force])
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
put("docs/adr/0066.md", "# ADR 0066: The 130,000-frame write-commit benchmark (`synchronous=FULL` vs WAL)\n\nStatus: Decided. This closes the first bullet of CODING_GUIDE.md Section 6 (\"Not for chat\"): \"The 130,000-frame benchmark (decides `synchronous=FULL` or WAL: keep `FULL` if commit p99 with antivirus running is 50 ms or less, otherwise WAL with `synchronous=NORMAL`) ... on the laptop.\" The audio probe named in the same bullet is a separate, still-open item.\n\nNo code, wire, setting, migration or constants change. `host/ppe_host/io/db_writer.py` already defaults every writer connection to `synchronous=FULL` (`connect_db`, `DBWriter.__init__`); this ADR is the record that the default was tested and should stay.\n\n## Tool\n\n`tools/bench_writer.py`, a standalone script (not imported by `ppe_host`, not wired into `cli.py`, CI or the `justfile`). It builds a throwaway copy of the real schema with the repo's own `connect_db` and `run_migrations`, seeds the roster and one session row, then commits 130,000 single-frame rows one at a time (one `BEGIN IMMEDIATE` / `COMMIT` per frame, matching how `DBWriter` commits a routine frame), timing each commit. It runs this twice back to back, same machine and disk: once at `synchronous=FULL`, once at `journal_mode=WAL` with `synchronous=NORMAL`.\n\n## Result (field laptop, antivirus running as in a real shift)\n\n130,000 frames per pass:\n\n| | p50 | p95 | p99 | max |\n|---|---|---|---|---|\n| `synchronous=FULL` (current default) | 0.93 ms | 8.97 ms | **9.86 ms** | 123.37 ms |\n| `journal_mode=WAL`, `synchronous=NORMAL` | 0.06 ms | 0.17 ms | 0.30 ms | 223.95 ms |\n\nMachine/disk: [FILL IN: laptop model, SSD or HDD, internal or external]. Antivirus: running, as it would be during a real shift. Full per-commit timings (130,130 rows) were written to `bench_results.csv` alongside the run; [FILL IN: where that file is kept, if anywhere].\n\nA smaller 5,000-frame run on the same machine gave FULL p99 10.42 ms and WAL+NORMAL p99 0.31 ms, consistent with the full run.\n\n## Decision\n\n**Keep `synchronous=FULL`.** Its p99 (9.86 ms) is well inside the 50 ms gate, so the rule in Section 6 does not call for a change. No edit to `db_writer.py`'s default, `connect_db`, or any setting.\n\n## Notes for the record\n\n- WAL + `synchronous=NORMAL` is faster on every percentile up to p99 (roughly 30x at p50), but its **max** (223.95 ms) is higher than FULL's max (123.37 ms) on this run. That is consistent with an occasional WAL checkpoint stall: WAL trades a lower, steadier per-commit cost for a rarer but larger spike when the log is flushed to the main database file. FULL has no such spike because every commit itself is the durable write. This does not change the decision (the gate is on p99, not max), but it is a reason FULL is also the more *predictable* of the two, not only the one that happens to pass.\n- Sustained throughput was 527.8 frames/s (FULL) and 1557.6 frames/s (WAL+NORMAL) on this machine. Both are far above anything the system needs in normal operation (3 roster nodes at a sub-1 Hz routine rate), so this benchmark was about per-commit latency under load, not throughput headroom.\n- This result is specific to the machine and disk it was measured on. If the field laptop is replaced, or if `host_disk_min_gb`-class storage changes (e.g. a laptop with a spinning HDD instead of an SSD), re-run `tools/bench_writer.py` and update this ADR rather than assuming the old numbers still hold.\n- The matching chunked-recovery timing (`RECOVERING_EXIT` within 3 s, ADR 0037) is covered separately by `host/tests/test_p25_release.py`; this ADR's benchmark is only the raw commit-latency half of the Section 6 bullet.\n\n## Still open\n\n- The audio probe of the same Section 6 bullet.\n- [FILL IN: machine/disk identification above, and the kept location of `bench_results.csv`, if it is being kept as supporting data for this ADR.]\n");
append("docs/PROGRESS.md", "- ADR 0066 recorded (ADR; closes the write-commit half of the Section 6 benchmark bullet): tools/bench_writer.py (a standalone script, not part of ppe_host, not wired into cli.py, CI or the justfile) was run on the field laptop with antivirus on, 130,000 single-frame commits at synchronous=FULL and again at journal_mode=WAL with synchronous=NORMAL against a throwaway copy of the real schema built with the repo's own connect_db and run_migrations. Result: FULL p99 9.86 ms, well under the 50 ms gate, so synchronous=FULL stays the default (no code, wire, setting or migration change). WAL+NORMAL was faster at p50/p95/p99 but had a higher max (223.95 ms vs 123.37 ms), noted as a likely WAL checkpoint stall. The matching chunked-recovery timing is covered separately by test_p25_release.py. Open: the audio probe of the same Section 6 bullet, and the machine/disk identification in the ADR.\n");
}
