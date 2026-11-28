// patches/part28_4a_fix_ruff.mjs  (run from repo root: node patches/part28_4a_fix_ruff.mjs [--dry])
// Fixes ruff F821 in host/ppe_host/api/api_rest.py: the Port protocol named 'PinResult' without importing it (test_locks_lint failed).
// api_rest now imports pin_auth (pin_auth imports only security at module level and api_rest lazily, so there is no cycle) and the annotation is 'pin_auth.PinResult'.
// Safe to run twice. CRLF files keep their CRLF. --dry writes nothing.
import fs from 'node:fs';
import path from 'node:path';
const DRY = process.argv.includes('--dry'), P = 'host/ppe_host/api/api_rest.py', f = path.join(process.cwd(), P);
if (!fs.existsSync(f)) { console.error('ERROR: missing ' + P + ' (run from the repo root)'); process.exit(1); }
let s = fs.readFileSync(f, 'utf8'); const e = s.includes('\r\n') ? '\r\n' : '\n', log = [];
const edit = (o, n) => {
  if (s.includes(n)) { log.push('skip      (already applied) ' + o.slice(0, 50)); return; }
  const c = s.split(o).length - 1; if (c !== 1) { console.error(`ERROR: anchor found ${c} times: ${o}`); process.exit(1); }
  s = s.replace(o, () => n); log.push('edit      ' + P);
};
edit('from . import models as M, security as sec' , 'from . import models as M, pin_auth, security as sec');
edit("-> 'PinResult': ...", "-> 'pin_auth.PinResult': ...");
if (!DRY) fs.writeFileSync(f, s);
console.log(log.join('\n') + (DRY ? '\n(dry run: nothing written)' : '\ndone'));
