// @vitest-environment jsdom
// Requirements: REQ-API-002
// ADR 0074 (S8-5b): Edit and Withdraw consent in Settings: the form starts at what the host has and sends only the fields that differ, the checks of the Add form, the confirmation before a withdrawal,
// the sentences of the answers, a withdrawn person shown without buttons, and the logic of checkEdit and the messages.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import SettingsPanel from '../src/components/SettingsPanel.tsx';
import { checkEdit, editFormOf, editMessage, isWithdrawn, withdrawMessage, type FirefighterRow } from '../src/api/firefighters.ts';
import { liveStore } from '../src/store/live.ts';
import { wearerStore } from '../src/store/wearers.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const ROW: FirefighterRow = { firefighter_id: 1, alias: 'FFR-01', full_name: 'Sam Example', sex: null, age_years: 34, height_cm: 180, weight_kg: 82.5, resting_hr: 58, max_hr: null, smoker: false, years_service: null,
  consent_ts: 1, consent_form_version: 'v1', active: true, node_id: null, consent_withdrawn_ts: null };
const WITHDRAWN: FirefighterRow = { ...ROW, firefighter_id: 2, alias: 'FFR-02', full_name: 'Pat Other', active: false, consent_withdrawn_ts: 5 };
type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
function host(rows: FirefighterRow[], answer?: (url: string) => { status: number; body: unknown } | undefined) {
  const calls: Call[] = []; let list = rows;
  const reply = (status: number, b: unknown) => ({ status, json: async () => b }) as unknown as Response;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const method = String(init.method), body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined; calls.push({ url, method, body });
    if (url === '/api/firefighters' && method === 'GET') return reply(200, list);
    const a = answer?.(url); if (a) return reply(a.status, a.body);
    if (url === '/api/firefighters/edit') { const id = body?.firefighter_id as number; list = list.map((r) => (r.firefighter_id === id ? { ...r, ...body } as FirefighterRow : r)); return reply(200, { firefighter_id: id, alias: 'FFR-01', result: 'changed', changed: Object.keys(body ?? {}).filter((k) => k !== 'firefighter_id') }); }
    if (url === '/api/firefighters/withdraw') { const id = body?.firefighter_id as number; list = list.map((r) => (r.firefighter_id === id ? { ...r, active: false, node_id: null, consent_withdrawn_ts: 9 } : r)); return reply(200, { firefighter_id: id, alias: 'FFR-01', result: 'withdrawn' }); }
    return reply(500, {});
  }) as unknown as typeof fetch;
  return { calls, api: { fetchFn, getToken: () => 't' } };
}
const posts = (h: ReturnType<typeof host>) => h.calls.filter((c) => c.method === 'POST');
beforeEach(() => { liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state); wearerStore.setState({ byNode: {} }); });
afterEach(cleanup);

describe('checkEdit', () => {
  it('starts at what the host has and a form nobody touched has nothing to send', () => {
    expect(editFormOf(ROW)).toEqual({ name: 'Sam Example', age: '34', height: '180', weight: '82.5', restingHr: '58', maxHr: '', sex: '', smoker: 'no', years: '' });
    expect(checkEdit(editFormOf(ROW), ROW)).toEqual({ error: 'Nothing was changed.' });
  });
  it('sends only the fields that differ, clears an optional one with null and trims the name', () => {
    const f = { ...editFormOf({ ...ROW, max_hr: 190, sex: 'F', years_service: 4 }), weight: '90', name: ' Sam E. ', maxHr: '', sex: '' as const, smoker: 'yes' as const };
    expect(checkEdit(f, { ...ROW, max_hr: 190, sex: 'F', years_service: 4 })).toEqual({ body: { firefighter_id: 1, full_name: 'Sam E.', sex: null, weight_kg: 90, max_hr: null, smoker: true } });
  });
  it('gives the first problem as one sentence, with the same ranges as the Add form', () => {
    const e = (over: Partial<ReturnType<typeof editFormOf>>) => checkEdit({ ...editFormOf(ROW), ...over }, ROW);
    expect(e({ name: ' ' })).toEqual({ error: 'Full name is required.' });
    expect(e({ age: '99' })).toEqual({ error: 'Age must be 16 to 80.' });
    expect(e({ weight: '' })).toEqual({ error: 'Weight is required.' });
    expect(e({ age: '3.5' })).toEqual({ error: 'Age must be a whole number.' });
    expect(e({ maxHr: '50' })).toEqual({ error: 'Maximum heart rate must be 100 to 230.' });
    expect(e({ restingHr: '120', maxHr: '110' })).toEqual({ error: 'Maximum heart rate must be above the resting heart rate.' });
  });
  it('isWithdrawn is false for null and for a host that sends no such field', () => {
    expect(isWithdrawn(ROW)).toBe(false); expect(isWithdrawn({ ...ROW, consent_withdrawn_ts: undefined })).toBe(false); expect(isWithdrawn(WITHDRAWN)).toBe(true);
  });
  it('the messages never carry a name and say what happened', () => {
    expect(editMessage({ kind: 'ok', body: { firefighter_id: 1, alias: 'FFR-01', result: 'changed', changed: ['weight_kg'] } }, 'FFR-01')).toBe('Saved the changes to FFR-01.');
    expect(editMessage({ kind: 'ok', body: { firefighter_id: 1, alias: 'FFR-01', result: 'unchanged', changed: [] } }, 'FFR-01')).toBe('No change.');
    expect(editMessage({ kind: 'conflict', code: 'STATE_CONFLICT' } as never, 'FFR-01')).toContain('withdrawn consent');
    expect(editMessage({ kind: 'conflict', code: 'RECOVERING', retryAfterS: 3 } as never, 'FFR-01')).toContain('recovering');
    expect(withdrawMessage({ kind: 'ok', body: { firefighter_id: 1, alias: 'FFR-01', result: 'withdrawn' } }, 'FFR-01')).toContain('left out of the readings download');
    expect(withdrawMessage({ kind: 'ok', body: { firefighter_id: 1, alias: 'FFR-01', result: 'unchanged' } }, 'FFR-01')).toContain('already withdrawn');
    expect(withdrawMessage({ kind: 'auth' } as never, 'FFR-01')).toContain('Log in');
  });
});

describe('Edit in Settings', () => {
  it('opens the form at the host values, sends only the changed fields and shows the saved sentence and the new value', async () => {
    const h = host([ROW]); render(<SettingsPanel api={h.api} onClose={() => {}} />); await screen.findByText('Sam Example');
    fireEvent.click(screen.getByRole('button', { name: 'Edit FFR-01' }));
    const form = screen.getByRole('form', { name: 'Edit FFR-01' }); expect((within(form).getByLabelText(/Weight/) as HTMLInputElement).value).toBe('82.5');
    fireEvent.change(within(form).getByLabelText(/Weight/), { target: { value: '90' } }); fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('status')).textContent).toBe('Saved the changes to FFR-01.');
    expect(posts(h)).toEqual([{ url: '/api/firefighters/edit', method: 'POST', body: { firefighter_id: 1, weight_kg: 90 } }]);
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit FFR-01' })).toBeNull()); expect(screen.getByText('90')).toBeTruthy();
  });
  it('a form with nothing changed or a value out of range sends nothing and says why', async () => {
    const h = host([ROW]); render(<SettingsPanel api={h.api} onClose={() => {}} />); await screen.findByText('Sam Example');
    fireEvent.click(screen.getByRole('button', { name: 'Edit FFR-01' })); const form = screen.getByRole('form', { name: 'Edit FFR-01' });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' })); expect((await screen.findByRole('alert')).textContent).toBe('Nothing was changed.');
    fireEvent.change(within(form).getByLabelText(/Age/), { target: { value: '99' } }); fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Age must be 16 to 80.')); expect(posts(h)).toEqual([]);
  });
  it('a refusal by the host stays in the form with its sentence; Cancel closes the form without sending', async () => {
    const h = host([ROW], (u) => (u === '/api/firefighters/edit' ? { status: 422, body: { error_code: 'VALIDATION_ERROR', detail: 'weight_kg must be 30 to 250', retry_after_s: null } } : undefined));
    render(<SettingsPanel api={h.api} onClose={() => {}} />); await screen.findByText('Sam Example');
    fireEvent.click(screen.getByRole('button', { name: 'Edit FFR-01' })); const form = screen.getByRole('form', { name: 'Edit FFR-01' });
    fireEvent.change(within(form).getByLabelText(/Weight/), { target: { value: '90' } }); fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Not accepted: weight_kg must be 30 to 250')); expect(screen.getByRole('form', { name: 'Edit FFR-01' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('form', { name: 'Edit FFR-01' })).toBeNull(); expect(posts(h)).toHaveLength(1);
  });
});

describe('Withdraw consent in Settings', () => {
  it('asks first, sends nothing on Cancel, and on Yes withdraws, shows the sentence and the row without buttons', async () => {
    const h = host([ROW]); render(<SettingsPanel api={h.api} onClose={() => {}} />); await screen.findByText('Sam Example');
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' }));
    const dlg = screen.getByRole('alertdialog', { name: 'Withdraw consent for FFR-01' }); expect(dlg.textContent).toContain('cannot be undone'); expect(dlg.textContent).not.toContain('Sam');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(posts(h)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' })); fireEvent.change(screen.getByLabelText('Withdrawal form reference'), { target: { value: 'WF-1' } }); fireEvent.change(screen.getByLabelText('Witness to the withdrawal'), { target: { value: 'Witness Two' } }); fireEvent.click(screen.getByRole('button', { name: 'Yes, withdraw consent' }));
    expect((await screen.findByRole('status')).textContent).toContain('Consent withdrawn for FFR-01'); expect(posts(h)).toEqual([{ url: '/api/firefighters/withdraw', method: 'POST', body: { firefighter_id: 1, withdrawal_form_ref: 'WF-1', withdrawal_witness: 'Witness Two' } }]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit FFR-01' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Set FFR-01 active' })).toBeNull(); expect(screen.getAllByText('Consent withdrawn').length).toBeGreaterThan(0);
  });
  it('a person who withdrew earlier is shown with no Edit, Withdraw or Set active button', async () => {
    const h = host([ROW, WITHDRAWN]); render(<SettingsPanel api={h.api} onClose={() => {}} />); await screen.findByText('Pat Other');
    for (const n of ['Edit FFR-02', 'Withdraw consent for FFR-02', 'Set FFR-02 active', 'Set FFR-02 inactive']) expect(screen.queryByRole('button', { name: n })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit FFR-01' })).toBeTruthy();
  });
  it('a host that refuses keeps the dialog open with the sentence; the readings note says who is left out', async () => {
    const h = host([ROW], (u) => (u === '/api/firefighters/withdraw' ? { status: 409, body: { error_code: 'RECOVERING', detail: 'x', retry_after_s: 3 } } : undefined));
    render(<SettingsPanel api={h.api} onClose={() => {}} />); await screen.findByText('Sam Example');
    expect(screen.getByText(/people who withdrew consent are left out/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' })); fireEvent.change(screen.getByLabelText('Withdrawal form reference'), { target: { value: 'WF-1' } }); fireEvent.change(screen.getByLabelText('Witness to the withdrawal'), { target: { value: 'Witness Two' } }); fireEvent.click(screen.getByRole('button', { name: 'Yes, withdraw consent' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('recovering')); expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});
