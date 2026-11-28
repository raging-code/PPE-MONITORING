// @vitest-environment jsdom
// Requirements: REQ-AUD-001, REQ-API-002
// ADR 0072 (S8-3b): "Who wears each jacket today" ahead of Start monitoring, and Set inactive in Settings.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import Shell from '../src/components/Shell.tsx';
import TopStrip from '../src/components/TopStrip.tsx';
import { liveStore } from '../src/store/live.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import { wdStore } from '../src/store/watchdog.ts';
import { audioStore } from '../src/audio/siren.ts';
import { createGate, gateStore } from '../src/audio/gate.ts';
import { resetWearers, setWearers, wearerStore } from '../src/store/wearers.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const ROW = (id: number, node: number | null, active = true) => ({ firefighter_id: id, alias: `FFR-0${id}`, full_name: `Person ${id}`, sex: null, age_years: 30, height_cm: 170, weight_kg: 70, resting_hr: 60, max_hr: null, smoker: false, years_service: null, consent_ts: 1, consent_form_version: 'v1', active, node_id: node });
type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
// A host with the list, assign and active routes. It keeps the state, so a change shows on the next GET like the real one.
function host(start: ReturnType<typeof ROW>[], refuse?: (b: Record<string, unknown>) => boolean) {
  const calls: Call[] = []; let list = start;
  const reply = (status: number, b: unknown) => ({ status, json: async () => b }) as unknown as Response;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const method = String(init.method), body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined; calls.push({ url, method, body });
    if (url === '/api/firefighters' && method === 'GET') return reply(200, list);
    if (url === '/api/firefighters/assign') {
      if (refuse?.(body ?? {})) return reply(409, { error_code: 'STATE_CONFLICT', detail: 'x', retry_after_s: null });
      const node = body?.node_id as number, id = body?.firefighter_id as number | null;
      list = list.map((r) => (r.node_id === node ? { ...r, node_id: null } : r)).map((r) => (r.firefighter_id === id ? { ...r, node_id: node } : r));
      return reply(200, { node_id: node, firefighter_id: id, alias: id === null ? null : `FFR-0${id}`, result: id === null ? 'ended' : 'assigned' });
    }
    if (url === '/api/firefighters/active') { const id = body?.firefighter_id as number, on = body?.active as boolean; list = list.map((r) => (r.firefighter_id === id ? { ...r, active: on, node_id: on ? r.node_id : null } : r)); return reply(200, { firefighter_id: id, alias: `FFR-0${id}`, active: on, result: 'changed' }); }
    if (url === '/api/session/start') return reply(200, { monitoring_active: true });
    return reply(500, {});
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const mkGate = (fetchFn: typeof fetch) => {
  const ctx = { state: 'suspended', sampleRate: 8000, destination: 'd', resume: vi.fn(async function () { ctx.state = 'running'; }),
    createBuffer: (_c: number, n: number) => { const a = new Float32Array(n); return { getChannelData: () => a }; }, createBufferSource: () => ({ buffer: null, loop: false, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }) };
  return createGate({ api: { fetchFn, getToken: () => 't' }, makeCtx: () => ctx });
};
const deps = () => ({ controller: { start: vi.fn(), login: vi.fn() }, bridge: { init: vi.fn() } });
const live = () => liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state);
beforeEach(() => { window.sessionStorage.clear(); window.sessionStorage.setItem('ppe_token', 't'); wdStore.setState({ noData: false, sirenOn: false }); audioStore.setState({ unlocked: false, ctx: null }); gateStore.setState(gateStore.getInitialState()); resetWearers(); });
afterEach(cleanup);
const startBtn = () => screen.getByRole('button', { name: 'Start monitoring' }) as HTMLButtonElement;
const testSound = async () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Test sound' })); });

describe('the jacket check before Start monitoring', () => {
  it('keeps Start monitoring off until the wearers are confirmed, shows aliases only, and sends no assign call when nothing changed', async () => {
    const h = host([ROW(1, 1), ROW(2, null)]); live(); setWearers([ROW(1, 1), ROW(2, null)]);
    render(<Shell {...deps()} gate={mkGate(h.fetchFn)} fetchFn={h.fetchFn} />); await testSound();
    expect(startBlocked()).toBe(true); expect(screen.queryByText('Confirm who wears the jackets first.')).not.toBeNull();
    const group = screen.getByRole('group', { name: 'Who wears the jackets today' }); expect(group.textContent).not.toContain('Person 1');
    expect((within(group).getByLabelText('Firefighter for FF-01') as HTMLSelectElement).value).toBe('1');
    await act(async () => { fireEvent.click(within(group).getByRole('button', { name: 'Confirm who wears the jackets' })); });
    await waitFor(() => expect(startBtn().disabled).toBe(false));
    expect(h.calls.filter((c) => c.url === '/api/firefighters/assign')).toEqual([]); expect(screen.queryByText(/Jackets confirmed: FF-01 FFR-01/)).not.toBeNull();
    await act(async () => { fireEvent.click(startBtn()); }); await waitFor(() => expect(screen.queryByText('Siren ON')).not.toBeNull());
  });
  it('a changed pick is sent as an assign call, then the list is read again and Start monitoring opens', async () => {
    const h = host([ROW(1, null), ROW(2, null)]); live(); setWearers([ROW(1, null), ROW(2, null)]);
    render(<Shell {...deps()} gate={mkGate(h.fetchFn)} fetchFn={h.fetchFn} />); await testSound();
    fireEvent.change(screen.getByLabelText('Firefighter for FF-01'), { target: { value: '2' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm who wears the jackets' })); });
    await waitFor(() => expect(startBtn().disabled).toBe(false));
    expect(h.calls.filter((c) => c.url === '/api/firefighters/assign').map((c) => c.body)).toEqual([{ node_id: 1, firefighter_id: 2 }]);
    expect(h.calls.at(-1)).toMatchObject({ url: '/api/firefighters', method: 'GET' });
  });
  it('a refused change shows a sentence, confirms nothing and keeps Start monitoring off', async () => {
    const h = host([ROW(1, null)], () => true); live(); setWearers([ROW(1, null)]);
    render(<Shell {...deps()} gate={mkGate(h.fetchFn)} fetchFn={h.fetchFn} />); await testSound();
    fireEvent.change(screen.getByLabelText('Firefighter for FF-01'), { target: { value: '1' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm who wears the jackets' })); });
    await waitFor(() => expect(screen.queryByText(/cannot be assigned/)).not.toBeNull()); expect(startBtn().disabled).toBe(true);
  });
  it('does not block when the host has no firefighters, and does not block when the list never arrived', async () => {
    live(); const h = host([]); setWearers([]);
    const { unmount } = render(<Shell {...deps()} gate={mkGate(h.fetchFn)} fetchFn={h.fetchFn} />); await testSound();
    expect(startBtn().disabled).toBe(false); expect(screen.queryByText(/No firefighters are set up/)).not.toBeNull(); unmount();
    resetWearers(); gateStore.setState(gateStore.getInitialState()); render(<Shell {...deps()} gate={mkGate(h.fetchFn)} fetchFn={h.fetchFn} />); await testSound();
    expect(startBtn().disabled).toBe(false); expect(screen.queryByRole('group', { name: 'Who wears the jackets today' })).toBeNull();
  });
  it('a change made elsewhere after the confirmation asks again', async () => {
    const h = host([ROW(1, 1)]); live(); setWearers([ROW(1, 1)]);
    render(<Shell {...deps()} gate={mkGate(h.fetchFn)} fetchFn={h.fetchFn} />); await testSound();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm who wears the jackets' })); }); await waitFor(() => expect(startBtn().disabled).toBe(false));
    act(() => setWearers([ROW(1, null)])); expect(startBtn().disabled).toBe(true); expect(screen.queryByRole('group', { name: 'Who wears the jackets today' })).not.toBeNull();
  });
  it('a person picked for one node is not offered on another', async () => {
    liveStore.setState(apply(initialState('CONNECTING'), { ...snapshot(), roster: [{ node_id: 1, alias: 'FF-01', active: 1 }, { node_id: 2, alias: 'FF-02', active: 1 }] } as unknown as ServerMessage).state);
    const h = host([ROW(1, null), ROW(2, null)]); setWearers([ROW(1, null), ROW(2, null)]);
    render(<Shell {...deps()} gate={mkGate(h.fetchFn)} fetchFn={h.fetchFn} />);
    fireEvent.change(screen.getByLabelText('Firefighter for FF-01'), { target: { value: '1' } });
    const opts = within(screen.getByLabelText('Firefighter for FF-02')).getAllByRole('option').map((o) => o.textContent); expect(opts).toEqual(['Nobody', 'FFR-02']);
  });
});
const startBlocked = () => startBtn().disabled;

describe('Set inactive in Settings', () => {
  const open = async (h: ReturnType<typeof host>) => { live(); render(<TopStrip fetchFn={h.fetchFn} />); fireEvent.click(screen.getByRole('button', { name: 'Settings' })); return screen.findByRole('region', { name: 'Settings' }); };
  it('sets a firefighter inactive, says so with the alias, and the row then offers Set active', async () => {
    const h = host([ROW(1, 1)]); const panel = await open(h); await within(panel).findByText('Person 1');
    fireEvent.click(within(panel).getByRole('button', { name: 'Set FFR-01 inactive' }));
    await waitFor(() => expect(screen.queryByText('FFR-01 is inactive now and no longer wears a jacket.')).not.toBeNull());
    expect(h.calls.find((c) => c.url === '/api/firefighters/active')?.body).toEqual({ firefighter_id: 1, active: false });
    expect(within(panel).getByRole('button', { name: 'Set FFR-01 active' })).not.toBeNull(); expect(wearerStore.getState().people).toEqual([]);
    fireEvent.click(within(panel).getByRole('button', { name: 'Set FFR-01 active' })); await waitFor(() => expect(screen.queryByText('FFR-01 is active again.')).not.toBeNull());
  });
});
