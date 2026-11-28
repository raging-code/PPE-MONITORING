// @vitest-environment jsdom
// Requirements: REQ-API-002
// ADR 0077 (S8-8): the Withdraw consent dialog asks for the reference of the withdrawal form and a witness. Both are required: an empty or blank one is said on the screen and nothing is sent; typed values are
// sent trimmed; both fields are empty each time the dialog opens and limited to the host's 40 and 80 characters; and the logic of checkWithdrawalProof.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import SettingsPanel from '../src/components/SettingsPanel.tsx';
import { checkWithdrawalProof, type FirefighterRow } from '../src/api/firefighters.ts';
import { liveStore } from '../src/store/live.ts';
import { wearerStore } from '../src/store/wearers.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const ROW: FirefighterRow = { firefighter_id: 1, alias: 'FFR-01', full_name: 'Sam Example', sex: null, age_years: 34, height_cm: 180, weight_kg: 82.5, resting_hr: 58, max_hr: null, smoker: false, years_service: null,
  consent_ts: Date.UTC(2020, 0, 1), consent_form_version: 'v1', active: true, node_id: null, consent_withdrawn_ts: null };
const FORM = 'Withdrawal form reference', WIT = 'Witness to the withdrawal';
type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
function host() {
  const calls: Call[] = []; let list = [ROW];
  const reply = (status: number, b: unknown) => ({ status, json: async () => b }) as unknown as Response;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const method = String(init.method), body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined; calls.push({ url, method, body });
    if (url === '/api/firefighters' && method === 'GET') return reply(200, list);
    if (url === '/api/firefighters/withdraw') { list = list.map((r) => ({ ...r, active: false, node_id: null, consent_withdrawn_ts: 9 })); return reply(200, { firefighter_id: 1, alias: 'FFR-01', result: 'withdrawn' }); }
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
const type = (dlg: HTMLElement, label: string, value: string) => fireEvent.change(within(dlg).getByLabelText(label), { target: { value } });
const yes = (dlg: HTMLElement) => fireEvent.click(within(dlg).getByRole('button', { name: 'Yes, withdraw consent' }));

describe('checkWithdrawalProof', () => {
  it('needs both, ignores blanks, and keeps to the host limits', () => {
    expect(checkWithdrawalProof('WF-1', 'Witness Two')).toBeNull(); expect(checkWithdrawalProof('', 'W')).toContain('form'); expect(checkWithdrawalProof('   ', 'W')).toContain('form');
    expect(checkWithdrawalProof('WF-1', '')).toContain('witness'); expect(checkWithdrawalProof('WF-1', '  ')).toContain('witness');
    expect(checkWithdrawalProof('x'.repeat(41), 'W')).toContain('40'); expect(checkWithdrawalProof('x'.repeat(40), 'W')).toBeNull(); expect(checkWithdrawalProof('WF', 'x'.repeat(81))).toContain('80'); expect(checkWithdrawalProof('WF', 'x'.repeat(80))).toBeNull();
  });
});

describe('the Withdraw consent dialog asks for the proof', () => {
  it('has two empty text fields with the host limits, and the dialog never shows the name', async () => {
    const h = host(); const dlg = await openDialog(h); const f = within(dlg).getByLabelText(FORM) as HTMLInputElement, w = within(dlg).getByLabelText(WIT) as HTMLInputElement;
    expect(f.type).toBe('text'); expect(f.value).toBe(''); expect(f.maxLength).toBe(40); expect(w.type).toBe('text'); expect(w.value).toBe(''); expect(w.maxLength).toBe(80); expect(dlg.textContent).not.toContain('Sam');
  });
  it('Yes with nothing typed, or with only one of them, says what is missing and sends nothing', async () => {
    const h = host(); const dlg = await openDialog(h);
    yes(dlg); expect((await screen.findByRole('status')).textContent).toContain('reference of the withdrawal form');
    type(dlg, FORM, 'WF-1'); yes(dlg); await waitFor(() => expect(screen.getByRole('status').textContent).toContain('name of the witness'));
    type(dlg, FORM, '   '); type(dlg, WIT, 'Witness Two'); yes(dlg); await waitFor(() => expect(screen.getByRole('status').textContent).toContain('reference of the withdrawal form'));
    expect(posts(h)).toEqual([]); expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
  it('typed values are sent trimmed with the withdrawal', async () => {
    const h = host(); const dlg = await openDialog(h); type(dlg, FORM, '  WF-2026-014 '); type(dlg, WIT, ' Witness Two  '); yes(dlg);
    expect((await screen.findByRole('status')).textContent).toContain('Consent withdrawn for FFR-01');
    expect(posts(h)).toEqual([{ url: '/api/firefighters/withdraw', method: 'POST', body: { firefighter_id: 1, withdrawal_form_ref: 'WF-2026-014', withdrawal_witness: 'Witness Two' } }]);
  });
  it('both fields are empty again each time the dialog is opened', async () => {
    const h = host(); const dlg = await openDialog(h); type(dlg, FORM, 'WF-1'); type(dlg, WIT, 'Witness Two'); fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' }));
    expect((screen.getByLabelText(FORM) as HTMLInputElement).value).toBe(''); expect((screen.getByLabelText(WIT) as HTMLInputElement).value).toBe(''); expect(posts(h)).toEqual([]);
  });
});
