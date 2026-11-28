// @vitest-environment jsdom
// Requirements: REQ-SES-002
// ADR 0075 (S8-6b): End shift ends every jacket on the host, so the dashboard says so in the dialog, reloads who wears what after the shift has ended, and asks who wears each jacket in the new shift.
// The question never blocks anything and goes away when it is answered or dismissed. A host with no firefighters, or one that does not answer, gets no question.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within, waitFor } from '@testing-library/react';
import TopStrip from '../src/components/TopStrip.tsx';
import { liveStore } from '../src/store/live.ts';
import { confirmWearers, setWearers, wearerStore } from '../src/store/wearers.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import type { FirefighterRow } from '../src/api/firefighters.ts';
import { snapshot } from './helpers.ts';

const ROW: FirefighterRow = { firefighter_id: 1, alias: 'FFR-01', full_name: 'Sam Example', sex: null, age_years: 34, height_cm: 180, weight_kg: 82.5, resting_hr: 58, max_hr: null, smoker: false, years_service: null,
  consent_ts: 1, consent_form_version: 'v1', active: true, node_id: 1, consent_withdrawn_ts: null };
type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
// A host like the real one after S8-6: End shift empties every jacket; /assign puts a person on a node.
function host(rows: FirefighterRow[], listAnswer?: { status: number }) {
  const calls: Call[] = []; let list = rows;
  const reply = (status: number, b: unknown) => ({ status, json: async () => b }) as unknown as Response;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const method = String(init.method), body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined; calls.push({ url, method, body });
    if (url === '/api/firefighters' && method === 'GET') return listAnswer ? reply(listAnswer.status, {}) : reply(200, list);
    if (url === '/api/session/end') { list = list.map((r) => ({ ...r, node_id: null })); return reply(200, { closed_session_id: 1, new_session_id: 2, backup_ok: true }); }
    if (url === '/api/firefighters/assign') { const f = body?.firefighter_id as number | null; list = list.map((r) => (r.firefighter_id === f ? { ...r, node_id: body?.node_id as number } : r)); return reply(200, { node_id: body?.node_id, firefighter_id: f, alias: 'FFR-01', result: 'assigned' }); }
    if (url.startsWith('/api/sessions')) return reply(200, []);
    return reply(500, {});
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
// The page state of a shift in which the operator had confirmed FFR-01 on node 1.
function confirmedShift(rows: FirefighterRow[]) { setWearers(rows); confirmWearers(); }
async function endShift() {
  fireEvent.click(screen.getByRole('button', { name: 'End shift' }));
  fireEvent.change(screen.getByLabelText('Type END to confirm'), { target: { value: 'END' } });
  await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'End shift' })); });
}
beforeEach(() => { liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state); wearerStore.setState({ byNode: {}, people: null, confirmedSig: null }); });
afterEach(cleanup);

describe('the End shift dialog', () => {
  it('says that every jacket is taken off and lists who is on which jacket now', () => {
    confirmedShift([ROW]); render(<TopStrip fetchFn={host([ROW]).fetchFn} />); fireEvent.click(screen.getByRole('button', { name: 'End shift' }));
    const dlg = screen.getByRole('dialog', { name: 'End shift' });
    expect(dlg.textContent).toContain('Every firefighter is taken off their jacket'); expect(within(dlg).getByRole('region', { name: 'Jackets that will be ended' }).textContent).toContain('FF-01: FFR-01');
  });
  it('shows no jacket list when nobody wears a jacket', () => {
    confirmedShift([{ ...ROW, node_id: null }]); render(<TopStrip fetchFn={host([ROW]).fetchFn} />); fireEvent.click(screen.getByRole('button', { name: 'End shift' }));
    expect(screen.queryByRole('region', { name: 'Jackets that will be ended' })).toBeNull();
  });
});

describe('after End shift', () => {
  it('reloads who wears what and asks who wears each jacket in the new shift; the card of the old wearer is empty', async () => {
    confirmedShift([ROW]); const h = host([ROW]); render(<TopStrip fetchFn={h.fetchFn} />); await endShift();
    const ask = await screen.findByRole('region', { name: 'New shift jackets' });
    expect(h.calls.map((c) => c.url)).toEqual(expect.arrayContaining(['/api/session/end', '/api/firefighters'])); expect(wearerStore.getState().byNode).toEqual({});
    expect(ask.textContent).toContain('every jacket was taken off'); expect(within(ask).getByRole('group', { name: 'Who wears the jackets today' })).toBeTruthy();
  });
  it('confirming puts the person back on the jacket through /assign and the question goes away', async () => {
    confirmedShift([ROW]); const h = host([ROW]); render(<TopStrip fetchFn={h.fetchFn} />); await endShift(); await screen.findByRole('region', { name: 'New shift jackets' });
    fireEvent.change(screen.getByLabelText('Firefighter for FF-01'), { target: { value: '1' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm who wears the jackets' })); });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New shift jackets' })).toBeNull());
    expect(h.calls.filter((c) => c.url === '/api/firefighters/assign').map((c) => c.body)).toEqual([{ node_id: 1, firefighter_id: 1 }]); expect(wearerStore.getState().byNode).toEqual({ 1: 'FFR-01' });
  });
  it('Not now closes the question and nothing is sent; the readings stay unlinked', async () => {
    confirmedShift([ROW]); const h = host([ROW]); render(<TopStrip fetchFn={h.fetchFn} />); await endShift(); await screen.findByRole('region', { name: 'New shift jackets' });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' })); expect(screen.queryByRole('region', { name: 'New shift jackets' })).toBeNull();
    expect(h.calls.some((c) => c.url === '/api/firefighters/assign')).toBe(false);
  });
  it('a host with no firefighters, or one that does not answer the list, gets no question', async () => {
    const h = host([]); render(<TopStrip fetchFn={h.fetchFn} />); await endShift(); await screen.findByRole('region', { name: 'Shift summary' });
    expect(screen.queryByRole('region', { name: 'New shift jackets' })).toBeNull(); cleanup();
    confirmedShift([ROW]); const g = host([ROW], { status: 500 }); render(<TopStrip fetchFn={g.fetchFn} />); await endShift(); await screen.findByRole('region', { name: 'Shift summary' });
    expect(screen.queryByRole('region', { name: 'New shift jackets' })).toBeNull();
  });
});
