// @vitest-environment jsdom
// Requirements: REQ-API-007, REQ-UI-008
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import Shell from '../src/components/Shell.tsx';
import SystemBanners from '../src/components/SystemBanners.tsx';
import { liveStore } from '../src/store/live.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import { wdStore } from '../src/store/watchdog.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const deps = () => ({ controller: { start: vi.fn(), login: vi.fn() }, bridge: { init: vi.fn() } });
const live = (over: Record<string, unknown> = {}) => liveStore.setState(apply(initialState('CONNECTING'), snapshot(over) as unknown as ServerMessage).state);
const banners = (o: Record<string, unknown>) => ({ banners: { base_offline: false, logging_fault: false, host_gap: null, host_power: 'ok', audio_fault: false, ...o } });
beforeEach(() => { window.sessionStorage.clear(); wdStore.setState({ noData: false, sirenOn: false }); });
afterEach(cleanup);

describe('banners in the Shell', () => {
  it('BASE OFFLINE shows as an alert banner above the live screen and the cards stay', () => {
    live(banners({ base_offline: true })); render(<Shell {...deps()} />);
    expect(screen.getByRole('alert').textContent).toContain('BASE OFFLINE: no node is being monitored'); expect(screen.queryByTestId('live')).not.toBeNull();
  });
  it('a host_gap banner has Acknowledge, which posts and then hides it', async () => {
    live(banners({ host_gap: { gap_s: 7, reason: null } }));
    const f = vi.fn(async () => ({ status: 200, json: async () => ({ kind: 'host_gap', acknowledged_ts: 5 }) }) as unknown as Response);
    render(<SystemBanners api={{ fetchFn: f as unknown as typeof fetch, getToken: () => 't' }} />);
    expect(screen.queryByText(/MONITORING GAP 7 s/)).not.toBeNull();
    const b = screen.getByRole('button', { name: 'Acknowledge' }); expect(b.className).toContain('min-h-11');
    await act(async () => { fireEvent.click(b); });
    await waitFor(() => expect(screen.queryByText(/MONITORING GAP/)).toBeNull());
  });
  it('a failed Acknowledge keeps the banner and says so', async () => {
    live(banners({ logging_fault: true }));
    const f = vi.fn(async () => ({ status: 503, json: async () => ({}) }) as unknown as Response);
    render(<SystemBanners api={{ fetchFn: f as unknown as typeof fetch, getToken: () => 't' }} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' })); });
    await waitFor(() => expect(screen.queryByText('The host did not answer. Try again.')).not.toBeNull());
    expect(screen.queryByText(/LOGGING FAULT/)).not.toBeNull();
  });
  it('base offline has no Acknowledge button', () => {
    live(banners({ base_offline: true, audio_fault: true })); render(<SystemBanners />);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  });
  it('the TEST bar is dark and neutral, appears for SIMULATOR and not for LIVE, and has no close button', () => {
    live({ session: { session_id: 1, started_ts: 1000, mode: 'SIMULATOR', session_label: null } }); const r = render(<Shell {...deps()} />);
    const bar = screen.getByTestId('mode-bar'); expect(bar.textContent).toBe('TEST: simulator data');
    expect(bar.className).toContain('bg-slate-800'); expect(bar.className).not.toMatch(/level-/); expect(bar.querySelector('button')).toBeNull();
    cleanup(); live(); r.unmount(); render(<Shell {...deps()} />); expect(screen.queryByTestId('mode-bar')).toBeNull();
  });
  it('nothing here covers the red NO LIVE DATA screen with a second set of banners', () => {
    live(banners({ base_offline: true })); render(<Shell {...deps()} />);
    act(() => wdStore.setState({ noData: true, sirenOn: true }));
    expect(screen.queryByTestId('banner-base_offline')).toBeNull();
  });
});

describe('empty states and NOT READY (3.7)', () => {
  const node = (id: number, alias: string, rx: number | null) => ({ node_id: id, alias, last_rx_ts: rx, co_ppm: null, temp_c: null, hum_pct: null, motion_g: null, bat_pct: rx ? 80 : null, scba: null, mandown: null, level: rx ? 'NORMAL' : null,
    link_state: rx ? 'ok' : 'not_connected', status2: null, flags: null, id_mode: null, status3: null, status4: null, co_validity: 'VALID', co_reason: null, scba_correction: null });
  it('a rostered node never heard is a grey Not connected card with no level, and says NOT READY before Start monitoring', () => {
    live({ monitoring_active: false, roster: [{ node_id: 1, alias: 'FF-01', active: 1 }, { node_id: 2, alias: 'FF-02', active: 1 }], nodes: [node(1, 'FF-01', 1000), node(2, 'FF-02', null)] });
    render(<Shell {...deps()} />);
    const c = screen.getByTestId('node-FF-02-none'); expect(c.textContent).toContain('Not connected'); expect(c.textContent).toContain('NOT READY');
    expect(c.className).not.toMatch(/level-/); expect(screen.queryByTestId('node-1')).not.toBeNull(); expect(screen.queryByTestId('node-2')).toBeNull();
  });
  it('NOT READY goes once monitoring is active, and a roster row with no node entry still shows its card', () => {
    live({ monitoring_active: true, roster: [{ node_id: 3, alias: 'FF-03', active: 1 }], nodes: [] }); render(<Shell {...deps()} />);
    const c = screen.getByTestId('node-FF-03-none'); expect(c.textContent).toContain('Not connected'); expect(c.textContent).not.toContain('NOT READY');
  });
  it('an empty roster says so', () => {
    live({ roster: [], nodes: [] }); render(<Shell {...deps()} />);
    expect(screen.queryByText('No responders on the roster')).not.toBeNull();
  });
});
