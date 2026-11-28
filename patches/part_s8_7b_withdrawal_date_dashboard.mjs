// patches/part_s8_7b_withdrawal_date_dashboard.mjs  (run from repo root: node patches/part_s8_7b_withdrawal_date_dashboard.mjs [--dry] [--force])
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
  const SP = 'dashboard/src/components/SettingsPanel.tsx', API = 'dashboard/src/api/firefighters.ts';
  // --- the API helpers ---
  replace(API, `export const postWithdraw = (api: Api, firefighterId: number): Promise<ActionResult<WithdrawnBody>> => request<WithdrawnBody>(api, 'POST', '/api/firefighters/withdraw', { firefighter_id: firefighterId });`,
`// ADR 0076: the optional date of the withdrawal (YYYY-MM-DD). It is sent only when filled in, so a plain withdrawal sends exactly {firefighter_id}.
export const postWithdraw = (api: Api, firefighterId: number, withdrawalDate?: string): Promise<ActionResult<WithdrawnBody>> => request<WithdrawnBody>(api, 'POST', '/api/firefighters/withdraw', withdrawalDate ? { firefighter_id: firefighterId, withdrawal_date: withdrawalDate } : { firefighter_id: firefighterId });
// The first problem with the date of a withdrawal as a sentence, or null. '' means today. today is YYYY-MM-DD in this screen's local date; the consent day is read as UTC like the host does.
export function checkWithdrawalDate(date: string, today: string, consentTs: number): string | null {
  if (date === '') return null;
  if (date > today) return 'The withdrawal date cannot be in the future.';
  if (Number.isFinite(consentTs) && date < new Date(consentTs).toISOString().slice(0, 10)) return 'The withdrawal date cannot be before the consent date.';
  return null;
}`);
  replace(API, `export function withdrawMessage(r: ActionResult<WithdrawnBody>, alias: string): string {`, `export function withdrawMessage(r: ActionResult<WithdrawnBody>, alias: string, date = ''): string {`);
  replace(API, "`Consent withdrawn for ${alias}. ${alias} is inactive, wears no jacket and is left out of the readings download.`", "`Consent withdrawn for ${alias}${date ? ` (dated ${date})` : ''}. ${alias} is inactive, wears no jacket and is left out of the readings download.`");
  // --- the Settings panel ---
  replace(SP, `checkForm, downloadReadings,`, `checkForm, checkWithdrawalDate, downloadReadings,`);
  replace(SP, `[confirming, setConfirming] = useState<FirefighterRow | null>(null);`, `[confirming, setConfirming] = useState<FirefighterRow | null>(null), [withdrawDate, setWithdrawDate] = useState('');      // ADR 0076`);
  replace(SP, `    const res = await postWithdraw(api, r.firefighter_id);
    setBusy(false); setNote(withdrawMessage(res, r.alias));`, `    const bad = checkWithdrawalDate(withdrawDate, localToday(), r.consent_ts);      // ADR 0076: the same checks as the host, so a wrong date is said before anything is sent
    if (bad) { setBusy(false); setNote(bad); return; }
    const res = await postWithdraw(api, r.firefighter_id, withdrawDate);
    setBusy(false); setNote(withdrawMessage(res, r.alias, withdrawDate));`);
  replace(SP, `onClick={() => { setEditing(null); setConfirming(r); }}`, `onClick={() => { setEditing(null); setWithdrawDate(''); setConfirming(r); }}`);
  replace(SP, `The profile stays as the record. This cannot be undone here.</p>`, `The profile stays as the record. This cannot be undone here.</p>
                <label className="block text-base">Date consent was withdrawn (leave empty for today)<input type="date" className={FIELD} value={withdrawDate} max={localToday()} min={new Date(confirming.consent_ts).toISOString().slice(0, 10)} disabled={busy} onChange={(e) => setWithdrawDate(e.target.value)} /></label>`);
  // --- the tests ---
  put('dashboard/tests/withdrawal_date.test.tsx', `// @vitest-environment jsdom
// Requirements: REQ-API-002
// ADR 0076 (S8-7b): the optional date in the Withdraw consent dialog: empty sends exactly what it sent before, a date is sent as withdrawal_date, a date in the future or before the consent is said on the screen
// and nothing is sent, the field is empty each time the dialog opens, the host's refusal is shown, and the logic of checkWithdrawalDate and withdrawMessage.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import SettingsPanel, { localToday } from '../src/components/SettingsPanel.tsx';
import { checkWithdrawalDate, withdrawMessage, type FirefighterRow } from '../src/api/firefighters.ts';
import { liveStore } from '../src/store/live.ts';
import { wearerStore } from '../src/store/wearers.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const CONSENT = Date.UTC(2020, 0, 1, 8, 30);      // 2020-01-01 08:30 UTC
const ROW: FirefighterRow = { firefighter_id: 1, alias: 'FFR-01', full_name: 'Sam Example', sex: null, age_years: 34, height_cm: 180, weight_kg: 82.5, resting_hr: 58, max_hr: null, smoker: false, years_service: null,
  consent_ts: CONSENT, consent_form_version: 'v1', active: true, node_id: null, consent_withdrawn_ts: null };
const LABEL = 'Date consent was withdrawn (leave empty for today)';
type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
function host(refuse?: { status: number; body: unknown }) {
  const calls: Call[] = []; let list = [ROW];
  const reply = (status: number, b: unknown) => ({ status, json: async () => b }) as unknown as Response;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const method = String(init.method), body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined; calls.push({ url, method, body });
    if (url === '/api/firefighters' && method === 'GET') return reply(200, list);
    if (url === '/api/firefighters/withdraw') {
      if (refuse) return reply(refuse.status, refuse.body);
      list = list.map((r) => ({ ...r, active: false, node_id: null, consent_withdrawn_ts: 9 })); return reply(200, { firefighter_id: 1, alias: 'FFR-01', result: 'withdrawn' });
    }
    return reply(500, {});
  }) as unknown as typeof fetch;
  return { calls, api: { fetchFn, getToken: () => 't' } };
}
const posts = (h: ReturnType<typeof host>) => h.calls.filter((c) => c.method === 'POST');
beforeEach(() => { liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state); wearerStore.setState({ byNode: {} }); });
afterEach(cleanup);
async function openDialog(h: ReturnType<typeof host>) {
  render(<SettingsPanel api={h.api} onClose={() => {}} />); await screen.findByText('Sam Example');
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' }));
  return screen.getByRole('alertdialog', { name: 'Withdraw consent for FFR-01' });
}

describe('checkWithdrawalDate and withdrawMessage', () => {
  it('empty is fine; today, a past day and the consent day itself are fine; later than today and before the consent day are said', () => {
    expect(checkWithdrawalDate('', '2026-11-28', CONSENT)).toBeNull(); expect(checkWithdrawalDate('2026-11-28', '2026-11-28', CONSENT)).toBeNull();
    expect(checkWithdrawalDate('2025-06-15', '2026-11-28', CONSENT)).toBeNull(); expect(checkWithdrawalDate('2020-01-01', '2026-11-28', CONSENT)).toBeNull();
    expect(checkWithdrawalDate('2026-11-29', '2026-11-28', CONSENT)).toContain('in the future'); expect(checkWithdrawalDate('2019-12-31', '2026-11-28', CONSENT)).toContain('before the consent date');
  });
  it('the sentence of a successful withdrawal carries the date only when one was given', () => {
    const ok = { kind: 'ok', body: { firefighter_id: 1, alias: 'FFR-01', result: 'withdrawn' } } as const;
    expect(withdrawMessage(ok, 'FFR-01')).toBe('Consent withdrawn for FFR-01. FFR-01 is inactive, wears no jacket and is left out of the readings download.');
    expect(withdrawMessage(ok, 'FFR-01', '2025-06-15')).toContain('Consent withdrawn for FFR-01 (dated 2025-06-15).');
  });
});

describe('the Withdraw consent dialog', () => {
  it('has an empty date field limited to the days from the consent to today, and a plain Yes sends exactly {firefighter_id}', async () => {
    const h = host(); const dlg = await openDialog(h); const input = within(dlg).getByLabelText(LABEL) as HTMLInputElement;
    expect(input.type).toBe('date'); expect(input.value).toBe(''); expect(input.max).toBe(localToday()); expect(input.min).toBe('2020-01-01'); expect(dlg.textContent).not.toContain('Sam');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Yes, withdraw consent' }));
    expect((await screen.findByRole('status')).textContent).not.toContain('dated'); expect(posts(h)).toEqual([{ url: '/api/firefighters/withdraw', method: 'POST', body: { firefighter_id: 1 } }]);
  });
  it('a date is sent as withdrawal_date and named in the sentence', async () => {
    const h = host(); const dlg = await openDialog(h);
    fireEvent.change(within(dlg).getByLabelText(LABEL), { target: { value: '2025-06-15' } }); fireEvent.click(within(dlg).getByRole('button', { name: 'Yes, withdraw consent' }));
    expect((await screen.findByRole('status')).textContent).toContain('Consent withdrawn for FFR-01 (dated 2025-06-15)');
    expect(posts(h)).toEqual([{ url: '/api/firefighters/withdraw', method: 'POST', body: { firefighter_id: 1, withdrawal_date: '2025-06-15' } }]);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
  it('a date in the future or before the consent is said on the screen, nothing is sent and the dialog stays open', async () => {
    const h = host(); const dlg = await openDialog(h); const input = within(dlg).getByLabelText(LABEL);
    fireEvent.change(input, { target: { value: '2999-01-01' } }); fireEvent.click(within(dlg).getByRole('button', { name: 'Yes, withdraw consent' }));
    expect((await screen.findByRole('status')).textContent).toContain('cannot be in the future');
    fireEvent.change(input, { target: { value: '2019-12-31' } }); fireEvent.click(within(dlg).getByRole('button', { name: 'Yes, withdraw consent' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('cannot be before the consent date'));
    expect(posts(h)).toEqual([]); expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
  it('the field is empty again each time the dialog is opened', async () => {
    const h = host(); const dlg = await openDialog(h);
    fireEvent.change(within(dlg).getByLabelText(LABEL), { target: { value: '2025-06-15' } }); fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' }));
    expect((screen.getByLabelText(LABEL) as HTMLInputElement).value).toBe(''); expect(posts(h)).toEqual([]);
  });
  it("the host's refusal of the date is shown and the dialog stays open", async () => {
    const h = host({ status: 422, body: { error_code: 'VALIDATION_ERROR', detail: 'the withdrawal date is before the consent date' } }); const dlg = await openDialog(h);
    fireEvent.change(within(dlg).getByLabelText(LABEL), { target: { value: '2025-06-15' } }); fireEvent.click(within(dlg).getByRole('button', { name: 'Yes, withdraw consent' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Not accepted: the withdrawal date is before the consent date')); expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});
`);
}
