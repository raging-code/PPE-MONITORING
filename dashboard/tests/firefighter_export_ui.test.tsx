// @vitest-environment jsdom
// Requirements: REQ-API-002
// ADR 0073 (S8-4b): the Settings button 'Download readings by firefighter': the authenticated fetch, the saved file, the alias-only message and the failures.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import SettingsPanel from '../src/components/SettingsPanel.tsx';
import { downloadReadings, readingsMessage } from '../src/api/firefighters.ts';
import type { SaveDeps } from '../src/api/shift.ts';
import { liveStore } from '../src/store/live.ts';
import { wearerStore } from '../src/store/wearers.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const ROW = { firefighter_id: 1, alias: 'FFR-01', full_name: 'Sam Example', sex: null, age_years: 34, height_cm: 180, weight_kg: 82.5, resting_hr: 58, max_hr: null, smoker: false, years_service: null, consent_ts: 1, consent_form_version: 'v1', active: true, node_id: null };
type Call = { url: string; method: string; auth: string };
function host(csvStatus = 200) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), auth: (init.headers as Record<string, string>).Authorization });
    if (url === '/api/firefighters') return { status: 200, json: async () => [ROW] } as unknown as Response;
    if (url === '/api/firefighters/readings.csv') return { status: csvStatus, blob: async () => new Blob(['session_id,event_seq,rx_ts,firefighter\r\n']) } as unknown as Response;
    return { status: 500, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchFn, api: { fetchFn, getToken: () => 't' } };
}
function saver() {
  const log: string[] = [];
  const deps: SaveDeps = { createObjectURL: () => 'blob:1', revokeObjectURL: (u) => log.push(`revoke ${u}`), click: (u, n) => log.push(`click ${u} ${n}`) };
  return { log, deps };
}
beforeEach(() => { liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state); wearerStore.setState({ byNode: {} }); });
afterEach(cleanup);

describe('downloadReadings', () => {
  it('asks the host with the token, saves the file under its name and frees the object URL', async () => {
    const h = host(), s = saver();
    expect(await downloadReadings(h.api, s.deps)).toBe('saved');
    expect(h.calls).toEqual([{ url: '/api/firefighters/readings.csv', method: 'GET', auth: 'Bearer t' }]);
    expect(s.log).toEqual(['click blob:1 firefighter-readings.csv', 'revoke blob:1']);
  });
  it('a 401 or 403 is auth and a 500, a lost connection and an unreadable body are failed; nothing is saved', async () => {
    for (const [st, want] of [[401, 'auth'], [403, 'auth'], [500, 'failed']] as const) { const s = saver(); expect(await downloadReadings(host(st).api, s.deps)).toBe(want); expect(s.log).toEqual([]); }
    const s = saver(); expect(await downloadReadings({ fetchFn: (async () => { throw new Error('down'); }) as unknown as typeof fetch, getToken: () => 't' }, s.deps)).toBe('failed'); expect(s.log).toEqual([]);
    const bad = { fetchFn: (async () => ({ status: 200, blob: async () => { throw new Error('cut'); } })) as unknown as typeof fetch, getToken: () => null };
    expect(await downloadReadings(bad, s.deps)).toBe('failed'); expect(s.log).toEqual([]);
  });
  it('the messages say the file shows the alias, ask for a new login, or ask to try again', () => {
    expect(readingsMessage('saved')).toContain('alias'); expect(readingsMessage('auth')).toContain('Log in'); expect(readingsMessage('failed')).toContain('Try again');
  });
});

describe('Settings download button', () => {
  it('shows the button with the list, sends one request when pressed and says what was saved', async () => {
    const h = host(), s = saver(); render(<SettingsPanel api={h.api} onClose={() => {}} saveDeps={s.deps} />);
    await screen.findByText('Sam Example');
    fireEvent.click(screen.getByRole('button', { name: 'Download readings by firefighter' }));
    expect((await screen.findByRole('status')).textContent).toContain('Saved firefighter-readings.csv');
    expect(h.calls.filter((c) => c.url === '/api/firefighters/readings.csv')).toHaveLength(1); expect(s.log[0]).toBe('click blob:1 firefighter-readings.csv');
  });
  it('a host that refuses shows one sentence and saves nothing; the button works again afterwards', async () => {
    const h = host(500), s = saver(); render(<SettingsPanel api={h.api} onClose={() => {}} saveDeps={s.deps} />);
    await screen.findByText('Sam Example'); const b = screen.getByRole('button', { name: 'Download readings by firefighter' });
    fireEvent.click(b); await waitFor(() => expect(screen.getByRole('status').textContent).toContain('did not send the file'));
    expect(s.log).toEqual([]); expect((b as HTMLButtonElement).disabled).toBe(false);
  });
  it('the button is not offered while the list has not loaded', async () => {
    const h = host(); render(<SettingsPanel api={h.api} onClose={() => {}} saveDeps={saver().deps} />);
    expect(screen.queryByRole('button', { name: 'Download readings by firefighter' })).toBeNull(); await screen.findByText('Sam Example');
  });
});
