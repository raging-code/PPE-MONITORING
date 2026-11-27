// patches/part24_5g_abi_banner_ui.mjs  (run from repo root: node patches/part24_5g_abi_banner_ui.mjs [--dry])
// P24-5g (ADR 0051): the abi_mismatch banner on screen.
// Edited: dashboard/src/alerts/banners.ts, dashboard/tests/{banners.test.ts,banners_ui.test.tsx,layout_ui.test.tsx}, e2e/mock_host.mjs, e2e/tests/helpers.ts,
//         docs/adr/0051.md, docs/PROGRESS.md. New: e2e/tests/abi_banner.spec.ts.
// SystemBanners.tsx and Shell need no change: they draw whatever bannersFor() returns. Every edit is checked before anything is written; a second run changes nothing.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd(), DRY = process.argv.includes('--dry');
const abs = (p) => path.join(ROOT, p);
const exists = (p) => fs.existsSync(abs(p));
const rd = (p) => fs.readFileSync(abs(p), 'utf8');
if (!exists('docs/adr/0051.md') || !rd('dashboard/src/store/reducer.ts').includes('abi_mismatch')) { console.error('WRONG BASE: P24-5f is not complete (docs/adr/0051.md or the reducer flag is missing)'); process.exit(1); }

const edits = new Map(), log = [], errors = [];
const cur = (p) => edits.has(p) ? edits.get(p) : (exists(p) ? rd(p) : null);
function sub(p, label, done, fn) {
  const s = cur(p);
  if (s === null) { if (label === 'create') { edits.set(p, fn('')); log.push(`create    ${p}`); } else errors.push(`${p}: file missing`); return; }
  if (done(s)) { log.push(`skip      ${p} (${label})`); return; }
  const r = fn(s);
  if (r === null || r === s) { errors.push(`${p}: anchor not found for "${label}"`); return; }
  edits.set(p, r); log.push(`edit      ${p} (${label})`);
}
const rep = (p, label, from, to) => sub(p, label, (s) => s.includes(to), (s) => s.includes(from) ? s.replace(from, to) : null);

// 1. the banner itself
const BN = 'dashboard/src/alerts/banners.ts';
rep(BN, 'BannerKind', "'host_power' | 'audio_fault';", "'host_power' | 'audio_fault' | 'abi_mismatch';");
rep(BN, 'show it', "    if (b.audio_fault) add('audio_fault', txt('audio_fault'), 'WARNING');\n",
  "    if (b.audio_fault) add('audio_fault', txt('audio_fault'), 'WARNING');\n    if (b.abi_mismatch) add('abi_mismatch', txt('abi_mismatch'), 'WARNING'); // P24-5g (ADR 0051): not in ACKABLE, so no button; stays while the host reports it\n");

// 2. Vitest: pure logic
const BT = 'dashboard/tests/banners.test.ts';
sub(BT, 'abi tests', (s) => s.includes('ABI MISMATCH uses the catalog wording'), (s) => {
  const a = "  it('RECOVERING comes from the recovering flag and has no level colour', () => {";
  return s.includes(a) ? s.replace(a, `  it('ABI MISMATCH uses the catalog wording, is a WARNING, sorts after AUDIO FAULT and is gone when the flag clears', () => {
    const r = show(B({ abi_mismatch: true, audio_fault: true }));
    expect(r.map((b) => b.kind)).toEqual(['audio_fault', 'abi_mismatch']);
    expect(r[1]).toMatchObject({ text: entryFor('abi_mismatch')!.text, level: 'WARNING', ackable: false });
    expect(show(B({ abi_mismatch: false }))).toEqual([]);
  });
  it('a banner with a higher level stays above ABI MISMATCH', () => {
    expect(show(B({ abi_mismatch: true, base_offline: true })).map((b) => b.kind)).toEqual(['base_offline', 'abi_mismatch']);
  });
` + a) : null;
});
rep(BT, 'not ackable', "B({ base_offline: true, audio_fault: true, host_power: 'battery 28' })", "B({ base_offline: true, audio_fault: true, abi_mismatch: true, host_power: 'battery 28' })");

// 3. Vitest: component
const UT = 'dashboard/tests/banners_ui.test.tsx';
rep(UT, 'helper', "host_power: 'ok', audio_fault: false, ...o } });", "host_power: 'ok', audio_fault: false, abi_mismatch: false, ...o } });");
sub(UT, 'abi ui test', (s) => s.includes('abi_mismatch shows as a status banner'), (s) => {
  const a = "  it('the TEST bar is dark and neutral,";
  return s.includes(a) ? s.replace(a, `  it('abi_mismatch shows as a status banner with the catalog text and no Acknowledge button, and goes when the flag clears', () => {
    live(banners({ abi_mismatch: true })); const r = render(<SystemBanners />);
    const el = screen.getByTestId('banner-abi_mismatch');
    expect(el.getAttribute('role')).toBe('status'); expect(el.textContent).toContain('ABI MISMATCH');
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    cleanup(); live(banners({ abi_mismatch: false })); r.unmount(); render(<SystemBanners />);
    expect(screen.queryByTestId('banner-abi_mismatch')).toBeNull();
  });
` + a) : null;
});

// 4. Vitest: layout with every banner active
const LT = 'dashboard/tests/layout_ui.test.tsx';
rep(LT, 'ALL', "audio_fault: true, abi_mismatch: false };", "audio_fault: true, abi_mismatch: true };");
rep(LT, 'ids', "'banner-audio_fault', 'banner-host_power'", "'banner-audio_fault', 'banner-abi_mismatch', 'banner-host_power'");

// 5. e2e mock host: a control flag and a system message
const MH = 'e2e/mock_host.mjs';
rep(MH, 'snapshot arg', "export const snapshotMessage = (now) => ({", "export const snapshotMessage = (now, abi = false) => ({");
rep(MH, 'snapshot flag', "audio_fault: false, abi_mismatch: false },\n  constants", "audio_fault: false, abi_mismatch: abi },\n  constants");
rep(MH, 'system message', "export const tickMessage = (seq, now) => ({ v: 1, type: 'tick', srv_seq: seq, srv_ts: now });\n",
  "export const tickMessage = (seq, now) => ({ v: 1, type: 'tick', srv_seq: seq, srv_ts: now });\nexport const systemMessage = (seq, now, abi) => ({ v: 1, type: 'system', srv_seq: seq, srv_ts: now, base: 'ok', recovering: false, session_id: 1, session_mode: 'SIMULATOR', rejected_frames: 0,\n  logging_fault: false, host_gap: null, host_power: 'ac', audio_fault: false, abi_mismatch: abi, banner: null, acknowledged_ts: null });\n");
rep(MH, 'state', "const state = { mode: 'live', lastTickAt: 0, startCount: 0, logins: 0 };", "const state = { mode: 'live', lastTickAt: 0, startCount: 0, logins: 0, abi_mismatch: false };");
rep(MH, 'reset', "if (b.reset) { state.startCount = 0; state.logins = 0; state.lastTickAt = 0; }", "if (b.reset) { state.startCount = 0; state.logins = 0; state.lastTickAt = 0; state.abi_mismatch = false; }");
rep(MH, 'ctl abi', "    if (['live', 'muted', 'dead'].includes(b.mode)) state.mode = b.mode;\n",
  "    if (['live', 'muted', 'dead'].includes(b.mode)) state.mode = b.mode;\n    if (typeof b.abi_mismatch === 'boolean' && b.abi_mismatch !== state.abi_mismatch) {   // the base reports a different ABI (or agrees again): one system message, like the host\n      state.abi_mismatch = b.abi_mismatch;\n      if (state.mode === 'live') for (const c of clients) if (c.authed && c.kind === 'data' && c.ws.readyState === 1) c.ws.send(JSON.stringify(systemMessage(++c.seq, Date.now(), state.abi_mismatch)));\n    }\n");
rep(MH, 'snapshot on auth', "ws.send(JSON.stringify(snapshotMessage(Date.now())));", "ws.send(JSON.stringify(snapshotMessage(Date.now(), state.abi_mismatch)));");
rep(MH, 'header', "POST /__ctl {\"mode\":\"live\"|\"muted\"|\"dead\",\"reset\":true}, GET /__state.", "POST /__ctl {\"mode\":\"live\"|\"muted\"|\"dead\",\"reset\":true,\"abi_mismatch\":true|false}, GET /__state.");

// 6. e2e helpers and spec
const EH = 'e2e/tests/helpers.ts';
rep(EH, 'MockState', "startCount: number; logins: number }", "startCount: number; logins: number; abi_mismatch: boolean }");
rep(EH, 'control body', "body: { mode?: Mode; reset?: boolean }", "body: { mode?: Mode; reset?: boolean; abi_mismatch?: boolean }");
sub('e2e/tests/abi_banner.spec.ts', 'create', () => false, () => `// Requirements: REQ-UI-008
// P24-5g (ADR 0051): the ABI MISMATCH banner. The mock host sends the same system message the host sends when the base reports a different beacon ABI. No fixed sleeps.
import { expect, test } from '@playwright/test';
import { control, signInAndWaitLive } from './helpers';

test.beforeEach(async ({ request }) => { await control(request, { mode: 'live', reset: true }); });

test('ABI MISMATCH appears when the base reports a different ABI and goes when it agrees again', async ({ page, request }) => {
  await signInAndWaitLive(page);
  const banner = page.getByTestId('banner-abi_mismatch');
  await expect(banner).toHaveCount(0);

  await control(request, { abi_mismatch: true });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('ABI MISMATCH');
  await expect(banner.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);   // it cannot be acknowledged
  await expect(page.getByTestId('frame')).toBeVisible();                             // the cards stay

  await control(request, { abi_mismatch: false });
  await expect(banner).toHaveCount(0);
});
`);

// 7. docs
sub('docs/adr/0051.md', 'P24-5g bullet', (s) => s.includes('P24-5g done'), (s) => s.replace(/\n*$/, '\n') +
  "- **On screen (P24-5g done).** `bannersFor` shows `abi_mismatch` at WARNING with the catalog text; it is not in ACKABLE, so SystemBanners draws no button, and the banner stays while the host reports the flag. It sorts after AUDIO FAULT (badge_order 33) and below any DANGER banner. SystemBanners and Shell are unchanged. The e2e mock host takes `abi_mismatch` in POST /__ctl and sends one system message, like the host.\n");
sub('docs/PROGRESS.md', 'append', (s) => s.includes('Part 24-5g done'), (s) => s.replace(/\n*$/, '\n') +
  "- Part 24-5g done (ADR 0051; the abi_mismatch banner on screen): banners.ts shows it at WARNING with the catalog text, not acknowledgeable, after AUDIO FAULT; Vitest cases in banners.test.ts and banners_ui.test.tsx and the all-banners layout test; e2e mock host takes `abi_mismatch` in /__ctl and sends one system message, e2e/tests/abi_banner.spec.ts (on and off). Open: the firmware change [BENCH], the missing 3.4 row (it.fails in catalog.test.ts), a cli doctor row.\n");

if (errors.length) { console.error('NOTHING WRITTEN. Problems:\n  ' + errors.join('\n  ')); process.exit(1); }
if (!DRY) for (const [p, c] of edits) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c, 'utf8'); }
console.log(log.join('\n'));
console.log((DRY ? 'DRY RUN: ' : 'OK: ') + edits.size + ' file(s) ' + (DRY ? 'would be written' : 'written'));
