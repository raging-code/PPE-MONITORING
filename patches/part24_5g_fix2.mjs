// patches/part24_5g_fix2.mjs (run from repo root: node patches/part24_5g_fix2.mjs)
// e2e/tests/no_live_data.spec.ts, first test: the mock host only stamps lastTickAt on its 1 s tick, so right after a fast sign-in it can still be 0
// and the test computed "now - 0". Wait for the first tick before muting the host. Timing-only test change, no product code.
import fs from 'node:fs';
const p = 'e2e/tests/no_live_data.spec.ts';
const s = fs.readFileSync(p, 'utf8');
const from = "  await expect(noLiveData(page)).toHaveCount(0);\n\n  const { lastTickAt } = await control(request, { mode: 'muted' });";
const to = "  await expect(noLiveData(page)).toHaveCount(0);\n  await expect.poll(async () => (await control(request, {})).lastTickAt).toBeGreaterThan(0);   // the mock has sent its first tick\n\n  const { lastTickAt } = await control(request, { mode: 'muted' });";
if (s.includes(to)) { console.log('skip  ' + p); process.exit(0); }
if (!s.includes(from)) { console.error('anchor not found in ' + p); process.exit(1); }
fs.writeFileSync(p, s.replace(from, to)); console.log('edit  ' + p);
