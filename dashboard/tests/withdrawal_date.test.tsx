// @vitest-environment jsdom
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
