// patches/part24_5g_fix.mjs (run from repo root: node patches/part24_5g_fix.mjs)
// The catalog text is "BASE FIRMWARE MISMATCH: ...", so the two 5g tests must look for that, not "ABI MISMATCH".
import fs from 'node:fs';
const fixes = [
  ['dashboard/tests/banners_ui.test.tsx', "toContain('ABI MISMATCH')", "toContain('BASE FIRMWARE MISMATCH')"],
  ['e2e/tests/abi_banner.spec.ts', "toContainText('ABI MISMATCH')", "toContainText('BASE FIRMWARE MISMATCH')"],
];
for (const [p, from, to] of fixes) {
  const s = fs.readFileSync(p, 'utf8');
  if (s.includes(to)) { console.log('skip  ' + p); continue; }
  if (!s.includes(from)) { console.error('anchor not found in ' + p); process.exit(1); }
  fs.writeFileSync(p, s.replace(from, to)); console.log('edit  ' + p);
}
