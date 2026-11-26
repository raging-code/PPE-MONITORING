// patches/cleanup_dup_p18b.mjs  (run from repo root: node patches/cleanup_dup_p18b.mjs [--dry])
// Removes the duplicate P18b work accidentally generated alongside the real one (tools/gen_ws_schema.py,
// host/tests/test_gen_ws.py, dashboard/src/gen/ws.ts) that a separate chat session already built and that
// P19-1 (api/api_rest.py) already depends on. Deletes the stray tools/gen_api_types.py, host/tests/test_gen_api_types.py
// and dashboard/src/gen/ws_messages.ts, removes the extra "python tools/gen_api_types.py" line from justfile's
// gen target, drops the duplicate "Part 18b done: tools/gen_api_types.py..." line from docs/PROGRESS.md, and
// deletes the stray patches/part18b_api_schema_export.mjs itself so it is never re-run by mistake.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const abs = (p) => path.join(ROOT, p);

const toDelete = [
  'tools/gen_api_types.py',
  'host/tests/test_gen_api_types.py',
  'dashboard/src/gen/ws_messages.ts',
  'patches/part18b_api_schema_export.mjs',
];

const justfileLineToRemove = '    python tools/gen_api_types.py\n';
const progressLineToRemove =
  "- Part 18b done: tools/gen_api_types.py (exports shared/ws.schema.json from api/models.py's WsMessage discriminated union, " +
  "shared/openapi.json wrapping the same schemas under components.schemas with no paths yet -- REST routes are P19 and P19c, " +
  "and generates dashboard/src/gen/ws_messages.ts: one TypeScript interface per $defs entry plus ServerMessage, ClientMessage " +
  "and WsMessage unions on type), host/tests/test_gen_api_types.py (regenerate-empty-diff check, schema and TS shape tests, " +
  "strict tsc compile if a compiler is on PATH); justfile gen now runs it; P18 is complete";

const log = [];

function run() {
  // 1. delete stray files
  for (const rel of toDelete) {
    const p = abs(rel);
    if (fs.existsSync(p)) {
      log.push(`delete    ${rel}`);
      if (!DRY) fs.rmSync(p);
    } else {
      log.push(`skip      ${rel} (already gone)`);
    }
  }

  // 2. justfile: remove the extra gen_api_types.py line
  const jfPath = abs('justfile');
  let jf = fs.readFileSync(jfPath, 'utf8');
  if (jf.includes(justfileLineToRemove)) {
    jf = jf.replace(justfileLineToRemove, '');
    log.push('edit      justfile (removed gen_api_types.py line)');
    if (!DRY) fs.writeFileSync(jfPath, jf);
  } else {
    log.push('skip      justfile (line already absent)');
  }

  // 3. docs/PROGRESS.md: remove the duplicate Part 18b line (handles with/without trailing newline, with/without a
  // leading newline before it, wherever it landed in the file)
  const prPath = abs('docs/PROGRESS.md');
  let pr = fs.readFileSync(prPath, 'utf8');
  const variants = [
    '\n' + progressLineToRemove,       // appended after an existing trailing newline
    progressLineToRemove + '\n',       // appended, file had none before
    progressLineToRemove,              // exact-match fallback (e.g. it was the very last line, no trailing newline)
  ];
  let removed = false;
  for (const v of variants) {
    if (pr.includes(v)) { pr = pr.replace(v, ''); removed = true; break; }
  }
  if (removed) {
    log.push('edit      docs/PROGRESS.md (removed duplicate Part 18b line)');
    if (!DRY) fs.writeFileSync(prPath, pr);
  } else {
    log.push('skip      docs/PROGRESS.md (duplicate line already absent)');
  }

  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : 'OK: cleanup applied');
}

try { run(); } catch (e) { console.error('CLEANUP FAILED:', e.message); process.exit(1); }
