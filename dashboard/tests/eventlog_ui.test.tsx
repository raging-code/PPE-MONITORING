// @vitest-environment jsdom
// P22d-2: the event log on the screen, its CSV button, the rejected-frames count (3.11). Real timers: the log waits REFRESH_MS after a live message.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import LiveScreen from '../src/components/LiveScreen.tsx';
import { liveStore } from '../src/store/live.ts';
import { uiStore } from '../src/store/ui.ts';
import { resetLog } from '../src/store/eventlog.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import { TOKEN_KEY } from '../src/store/controller.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import type { LogRow } from '../src/api/events.ts';
import { snapshot } from './helpers.ts';

const node = { node_id: 1, alias: 'FF-01', last_rx_ts: 900, co_ppm: 12, temp_c: 31.2, hum_pct: 44, motion_g: 0.08, bat_pct: 86, scba: 1, mandown: 0, level: 'NORMAL', link_state: 'ok', status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0, co_validity: 'VALID', co_reason: null, scba_correction: null };
const T = Date.UTC(2026, 10, 26, 0, 5, 9); // 08:05:09 in Manila
const ev = (seq: number, o: Partial<LogRow> = {}): LogRow => ({ event_seq: seq, log_ts: T + seq * 1000, record_type: 'alert_raised', node_id: 1, level: 'DANGER', code: 'man_down', detail: null, operator_id: null, ...o });
const load = () => act(() => { liveStore.setState(apply(initialState('CONNECTING'), snapshot({ srv_ts: 2000, nodes: [node] }) as unknown as ServerMessage).state); });
function host(events: LogRow[], csv: { status: number } = { status: 200 }) {
  const urls: string[] = [], headers: unknown[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url); headers.push((init?.headers as Record<string, string> | undefined)?.Authorization);
    if (url.startsWith('/api/events')) { const after = Number(new URL(url, 'http://h').searchParams.get('after_seq')); const e = events.filter((r) => r.event_seq > after); return { status: 200, json: async () => ({ events: e, last_seq: e.length ? e[e.length - 1].event_seq : after }) }; }
    if (url.startsWith('/api/export.csv')) return { status: csv.status, blob: async () => new Blob(['a,b']), json: async () => ({}) };
    return { status: 404, json: async () => ({}) };
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, urls, headers };
}
beforeEach(() => { window.sessionStorage.clear(); window.sessionStorage.setItem(TOKEN_KEY, 't'); resetLog(); uiStore.setState({ selected: null, minimized: {}, dismissed: {} }); });
afterEach(cleanup);

describe('event log (3.11)', () => {
  it('fills from GET /api/events, newest first, with clock time only and the responder alias', async () => {
    const h = host([ev(1), ev(2, { record_type: 'system', node_id: null, level: null, code: 'BASE_OFFLINE', detail: 'no beacon' })]); load(); render(<LiveScreen fetchFn={h.fetchFn} />);
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    const rows = within(screen.getByTestId('event-log')).getAllByRole('row');
    expect(rows[1].textContent).toContain('08:05:11'); expect(rows[1].textContent).toContain('Base offline: no beacon'); expect(rows[2].textContent).toContain('FF-01'); expect(rows[2].textContent).toContain('Man down DANGER raised');
    expect(h.urls[0]).toBe('/api/events?after_seq=0&limit=1000'); expect(h.headers[0]).toBe('Bearer t');
  });
  it('follows live messages: a new alert makes it ask only for rows after the last one', async () => {
    const all = [ev(1)], h = host(all); load(); render(<LiveScreen fetchFn={h.fetchFn} />); await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
    all.push(ev(2, { record_type: 'alert_cleared', level: 'WARNING', code: 'co_threshold' }));
    act(() => { liveStore.setState({ ...liveStore.getState(), alerts: { ...liveStore.getState().alerts } }); });
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3), { timeout: 3000 });
    expect(h.urls.filter((u) => u.startsWith('/api/events')).pop()).toBe('/api/events?after_seq=1&limit=1000'); expect(screen.getAllByRole('row')[1].textContent).toContain('Co threshold WARNING cleared');
  });
  it('the diagnostics view is off by default and adds the type, code and sequence columns when switched on', async () => {
    const h = host([ev(7)]); load(); render(<LiveScreen fetchFn={h.fetchFn} />); await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
    expect(screen.queryByText('Code')).toBeNull(); const b = screen.getByRole('button', { name: 'Diagnostics off' }); fireEvent.click(b);
    expect(screen.getByText('Code')).toBeTruthy(); expect(screen.getByText('alert_raised')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Diagnostics on' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('rejected frames show as one count with "check key", and nothing when there are none', async () => {
    const h = host([]); load(); render(<LiveScreen fetchFn={h.fetchFn} />); expect(screen.queryByTestId('rejected')).toBeNull();
    act(() => { liveStore.setState({ ...liveStore.getState(), rejectedFrames: 4 }); });
    expect(screen.getByTestId('rejected').textContent).toBe('4 frames rejected (authentication): check key'); await waitFor(() => expect(screen.getByText('No events yet.')).toBeTruthy());
  });
  it('a failed load says so and keeps a Reload button; the rest of the screen stays', async () => {
    const f = vi.fn(async () => ({ status: 500, json: async () => ({}) })) as unknown as typeof fetch; load(); render(<LiveScreen fetchFn={f} />);
    await waitFor(() => expect(screen.getByText(/could not be loaded/)).toBeTruthy()); expect(screen.getByTestId('node-1')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Reload event log' }).className).toContain('min-h-11');
  });
});

describe('CSV button (3.8)', () => {
  it('does an authenticated fetch of this session and saves a blob, never a plain link', async () => {
    const h = host([]), click = vi.fn(), deps = { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn(), click };
    load(); render(<LiveScreen fetchFn={h.fetchFn} saveDeps={deps} />); fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(screen.getByText('Saved session-4.csv.')).toBeTruthy());
    const i = h.urls.indexOf('/api/export.csv?session_id=4'); expect(i).toBeGreaterThan(-1); expect(h.headers[i]).toBe('Bearer t'); expect(click).toHaveBeenCalledWith('blob:x', 'session-4.csv'); expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:x');
    expect(document.querySelector('a[href*="export.csv"]')).toBeNull();
  });
  it('says so when the host refuses or does not have it yet', async () => {
    const h = host([], { status: 404 }), deps = { createObjectURL: vi.fn(), revokeObjectURL: vi.fn(), click: vi.fn() }; load(); render(<LiveScreen fetchFn={h.fetchFn} saveDeps={deps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' })); await waitFor(() => expect(screen.getByText('The CSV could not be downloaded. Try again.')).toBeTruthy()); expect(deps.click).not.toHaveBeenCalled();
  });
});
