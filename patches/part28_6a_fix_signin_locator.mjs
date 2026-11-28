// patches/part28_6a_fix_signin_locator.mjs  (run from repo root: node patches/part28_6a_fix_signin_locator.mjs [--dry])
// Fix to P28-6: getByRole('button', { name: 'Sign in' }) also matches the link 'Sign in with name and PIN' (substring match), so in the token form it resolved to 2 elements. The locator is now exact.
// Edited: e2e/tests/helpers.ts, e2e/tests/pin_login.spec.ts, docs/PROGRESS.md. Safe to run twice.

import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd(), DRY = process.argv.includes('--dry'), FORCE = process.argv.includes('--force');
const abs = (p) => path.join(ROOT, p), plan = [];
const put = (p, content, replaces) => plan.push({ op: 'put', p, content, replaces });
const replace = (p, o, n) => plan.push({ op: 'replace', p, o, n });
const append = (p, text) => plan.push({ op: 'append', p, text });
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toEol = (t, e) => t.replace(/\r\n/g, '\n').replace(/\n/g, e);
const lf = (s) => s.replace(/\r\n/g, '\n');
function apply() {
  const state = new Map(), log = [];
  const get = (p) => (state.has(p) ? state.get(p) : fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      const same = cur !== null && lf(cur) === lf(s.content), known = cur !== null && s.replaces && cur.includes(s.replaces);
      if (cur !== null && !same && !known && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : same ? 'unchanged' : 'overwrite'} ${s.p}`);
      if (!same) state.set(s.p, cur !== null && cur.includes('\r\n') ? toEol(s.content, '\r\n') : s.content);
    } else if (cur === null) throw new Error(`MISSING file: ${s.p} (run the earlier parts first, and run from the repo root)`);
    else if (s.op === 'replace') {
      const e = eolOf(cur), o = toEol(s.o, e), n = toEol(s.n, e), c = cur.split(o).length - 1;
      if (cur.includes(n)) log.push(`skip      ${s.p} (already applied)`);
      else if (c === 1) { state.set(s.p, cur.replace(o, () => n)); log.push(`edit      ${s.p}`); }
      else throw new Error(`ANCHOR found ${c} times in ${s.p}: ${s.o.slice(0, 70)}`);
    } else if (s.op === 'append') {
      const e = eolOf(cur), t = toEol(s.text, e);
      if (cur.includes(t.trim())) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : e) + t + e); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n') + (DRY ? '\n(dry run: nothing written)' : '\ndone'));
}

replace("e2e/tests/helpers.ts",
  "fill('e2e-token');\n  const t = Date.now();\n  await page.getByRole('button', { name: 'Sign in' }).click();",
  "fill('e2e-token');\n  const t = Date.now();\n  await page.getByRole('button', { name: 'Sign in', exact: true }).click();   // exact: the token form also has the link 'Sign in with name and PIN'");
replace("e2e/tests/helpers.ts",
  ".check();\n  const t = Date.now();\n  await page.getByRole('button', { name: 'Sign in' }).click();",
  ".check();\n  const t = Date.now();\n  await page.getByRole('button', { name: 'Sign in', exact: true }).click();");
replace("e2e/tests/pin_login.spec.ts",
  "page.getByRole('button', { name: 'Sign in' });",
  "page.getByRole('button', { name: 'Sign in', exact: true });   // exact: the token form also has the link 'Sign in with name and PIN'");
append("docs/PROGRESS.md", "- Part 28-6a done (fix to P28-6, found by the first browser run): the Playwright locator for the Sign in button is now exact (helpers.ts signIn and signInWithPin, pin_login.spec.ts), because in the token form the link 'Sign in with name and PIN' also matched a substring search and 10 of 14 e2e tests failed with a strict mode violation. No dashboard, host or mock host change; the four PIN tests that did not click Sign in in the token form had passed on the first run.");

try { apply(); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
