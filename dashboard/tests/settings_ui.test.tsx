// @vitest-environment jsdom
// Requirements: REQ-API-002
// ADR 0071 (S8-2b): the Settings button, the Add firefighter form, who wears the jacket, and the alias on the node card.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import TopStrip from '../src/components/TopStrip.tsx';
import NodeCard from '../src/components/NodeCard.tsx';
import NotConnectedCard from '../src/components/NotConnectedCard.tsx';
import WearerSync from '../src/components/WearerSync.tsx';
import { localToday } from '../src/components/SettingsPanel.tsx';
import { liveStore } from '../src/store/live.ts';
import { wearerStore } from '../src/store/wearers.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { NodeSnap, ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const ROW = { firefighter_id: 1, alias: 'FFR-01', full_name: 'Sam Example', sex: null, age_years: 34, height_cm: 180, weight_kg: 82.5, resting_hr: 58, max_hr: null, smoker: false, years_service: null, consent_ts: 1, consent_form_version: 'v1', active: true, node_id: null as number | null };
type Call = { url: string; method: string; body: Record<string, unknown> | undefined; auth: string };
// A host with the three firefighter routes. It keeps the list, so a change shows on the next GET like the real one.
function host() {
  const calls: Call[] = []; let list = [ROW];
  const reply = (status: number, b: unknown) => ({ status, json: async () => b }) as unknown as Response;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const method = String(init.method), body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body, auth: (init.headers as Record<string, string>).Authorization });
    if (url === '/api/firefighters' && method === 'GET') return reply(200, list);
    if (url === '/api/firefighters' && method === 'POST') { list = [...list, { ...ROW, firefighter_id: 2, alias: 'FFR-02', full_name: String(body?.full_name) }]; return reply(200, { firefighter_id: 2, alias: 'FFR-02' }); }
    if (url === '/api/firefighters/assign') {
      const id = body?.firefighter_id as number | null; list = list.map((r) => (r.firefighter_id === id ? { ...r, node_id: body?.node_id as number } : r));
      return reply(200, { node_id: body?.node_id, firefighter_id: id, alias: id === null ? null : 'FFR-01', result: id === null ? 'ended' : 'assigned' });
    }
    return reply(500, {});
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const live = () => liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state);
beforeEach(() => { window.sessionStorage.clear(); window.sessionStorage.setItem('ppe_token', 't'); wearerStore.setState({ byNode: {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async (h: ReturnType<typeof host>) => { live(); render(<TopStrip fetchFn={h.fetchFn} />); fireEvent.click(screen.getByRole('button', { name: 'Settings' })); return screen.findByRole('region', { name: 'Settings' }); };
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('Settings', () => {
  it('opens from the top strip, lists the firefighters with their name, and closes', async () => {
    const h = host(); const panel = await open(h);
    expect(await within(panel).findByText('Sam Example')).not.toBeNull(); expect(within(panel).getByText('FFR-01')).not.toBeNull();
    expect(h.calls[0]).toMatchObject({ url: '/api/firefighters', method: 'GET', auth: 'Bearer t' });
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' })); expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull();
  });
  it('shows the form only after Add firefighter, and a form with a problem sends nothing', async () => {
    const h = host(); await open(h); await screen.findByText('Sam Example');
    expect(screen.queryByRole('form', { name: 'New firefighter' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add firefighter' })); expect(screen.getByRole('form', { name: 'New firefighter' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save firefighter' })); expect((await screen.findByRole('alert')).textContent).toBe('Full name is required.');
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
  it('without the consent tick nothing is sent', async () => {
    const h = host(); await open(h); await screen.findByText('Sam Example'); fireEvent.click(screen.getByRole('button', { name: 'Add firefighter' }));
    type('Full name', 'Pat Other'); type('Age (years)', '40'); type('Height (cm)', '170'); type('Weight (kg)', '70'); type('Resting heart rate (bpm)', '60'); type('Smoker', 'no');
    fireEvent.click(screen.getByRole('button', { name: 'Save firefighter' })); expect((await screen.findByRole('alert')).textContent).toContain('Tick the consent box');
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
  it('saves a complete form with the consent record, says the alias, and reloads the list', async () => {
    const h = host(); await open(h); await screen.findByText('Sam Example'); fireEvent.click(screen.getByRole('button', { name: 'Add firefighter' }));
    type('Full name', 'Pat Other'); type('Age (years)', '40'); type('Height (cm)', '170'); type('Weight (kg)', '70.5'); type('Resting heart rate (bpm)', '60'); type('Smoker', 'yes');
    fireEvent.click(screen.getByLabelText(/Consent given/)); type('Consent form version', 'v1'); type('Witness name', 'Witness One');
    fireEvent.click(screen.getByRole('button', { name: 'Save firefighter' }));
    expect((await screen.findByRole('status')).textContent).toBe('Saved as FFR-02.');
    const post = h.calls.find((c) => c.method === 'POST'); expect(post).toMatchObject({ url: '/api/firefighters', auth: 'Bearer t' });
    expect(post?.body).toEqual({ full_name: 'Pat Other', sex: null, age_years: 40, height_cm: 170, weight_kg: 70.5, resting_hr: 60, max_hr: null, smoker: true, years_service: null, consent: true, consent_form_version: 'v1', consent_witness: 'Witness One', consent_date: localToday() });
    await waitFor(() => expect(screen.getByText('Pat Other')).not.toBeNull()); expect(screen.queryByRole('form', { name: 'New firefighter' })).toBeNull();
  });
  it('assigns a firefighter to the jacket, and the alias reaches the wearer store', async () => {
    const h = host(); await open(h); const sel = await screen.findByLabelText('Firefighter for FF-01');
    fireEvent.change(sel, { target: { value: '1' } }); fireEvent.click(screen.getByRole('button', { name: 'Save who wears FF-01' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('FFR-01 now wears this jacket.'));
    expect(h.calls.find((c) => c.url === '/api/firefighters/assign')?.body).toEqual({ node_id: 1, firefighter_id: 1 });
    await waitFor(() => expect(wearerStore.getState().byNode).toEqual({ 1: 'FFR-01' }));
  });
  it('a host that does not answer shows Try again and nothing about the firefighters', async () => {
    live(); render(<TopStrip fetchFn={(async () => ({ status: 500, json: async () => ({}) })) as unknown as typeof fetch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' })); await screen.findByText(/The host did not answer/); expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
  });
});

describe('the alias on the node card', () => {
  const node = snapshot().nodes[0] as unknown as NodeSnap;
  it('shows who wears the jacket, and nothing when nobody is known', () => {
    const { rerender } = render(<NodeCard node={node} badges={[]} flashing={false} selected={false} onSelect={() => {}} wearer="FFR-01" />);
    expect(screen.getByText('Worn by FFR-01')).not.toBeNull();
    rerender(<NodeCard node={node} badges={[]} flashing={false} selected={false} onSelect={() => {}} />); expect(screen.queryByText(/Worn by/)).toBeNull();
  });
  it('the never-heard card shows it too', () => {
    render(<NotConnectedCard alias="FF-01" notReady={false} wearer="FFR-01" />); expect(screen.getByText('Worn by FFR-01')).not.toBeNull();
  });
});

describe('WearerSync', () => {
  it('reads the list once the screen is live, and not before', async () => {
    const f = vi.fn(async () => ({ status: 200, json: async () => [{ ...ROW, node_id: 1 }] }) as unknown as Response); vi.stubGlobal('fetch', f);
    liveStore.setState(initialState('CONNECTING')); render(<WearerSync />); expect(f).not.toHaveBeenCalled();
    act(() => { live(); }); await waitFor(() => expect(wearerStore.getState().byNode).toEqual({ 1: 'FFR-01' }));
  });
});
