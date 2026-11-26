// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within, waitFor } from '@testing-library/react';
import Shell from '../src/components/Shell.tsx';
import TopStrip from '../src/components/TopStrip.tsx';
import ShiftSummary from '../src/components/ShiftSummary.tsx';
import { liveStore } from '../src/store/live.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import { wdStore } from '../src/store/watchdog.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot, alert as alertMsg } from './helpers.ts';

const SESSIONS = [
  { session_id: 5, started_ts: Date.UTC(2026, 10, 27, 0, 10), ended_ts: null, duration_s: 60, mode: 'LIVE', session_label: null, end_kind: null, alert_count: 0, unresolved_episodes: 0, highest_level_by_node: {} },
  { session_id: 4, started_ts: Date.UTC(2026, 10, 26, 16, 5), ended_ts: Date.UTC(2026, 10, 27, 0, 10), duration_s: 29100, mode: 'LIVE', session_label: 'shift-1', end_kind: 'ENDED', alert_count: 6, unresolved_episodes: 1, highest_level_by_node: { '1': 'DANGER' } },
  { session_id: 3, started_ts: Date.UTC(2026, 10, 25, 2, 0), ended_ts: Date.UTC(2026, 10, 25, 3, 0), duration_s: 3600, mode: 'REPLAY', session_label: null, end_kind: 'ENDED', alert_count: 2, unresolved_episodes: 0, highest_level_by_node: {} },
];
type Reply = { status: number; body?: unknown };
// A host that routes by URL. A reply can be a function so a test can change it between calls.
function host(routes: Record<string, Reply | (() => Reply)>) {
  const calls: { url: string; method: string; body: string | undefined; auth: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: init.body as string | undefined, auth: (init.headers as Record<string, string>).Authorization });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const r = key ? (typeof routes[key] === 'function' ? (routes[key] as () => Reply)() : (routes[key] as Reply)) : { status: 500 };
    return { status: r.status, json: async () => r.body ?? {}, blob: async () => new Blob(['csv']) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const live = (over: Record<string, unknown> = {}) => liveStore.setState(apply(initialState('CONNECTING'), snapshot(over) as unknown as ServerMessage).state);
const deps = () => ({ controller: { start: vi.fn(), login: vi.fn() }, bridge: { init: vi.fn() } });
beforeEach(() => { window.sessionStorage.clear(); window.sessionStorage.setItem('ppe_token', 't'); wdStore.setState({ noData: false, sirenOn: false }); });
afterEach(cleanup);

describe('top strip and Sessions list', () => {
  it('Shell shows Sessions and End shift on the live screen, and not under the red NO LIVE DATA screen', () => {
    live(); const { unmount } = render(<Shell {...deps()} />);
    expect(screen.getByRole('button', { name: 'Sessions' })).not.toBeNull(); expect(screen.getByRole('button', { name: 'End shift' })).not.toBeNull();
    unmount(); act(() => wdStore.setState({ noData: true })); render(<Shell {...deps()} />);
    expect(screen.queryByRole('button', { name: 'Sessions' })).toBeNull();
  });
  it('the Sessions list opens from the strip with date, length, mode and alert count, in Manila time', async () => {
    live(); const h = host({ '/api/sessions': { status: 200, body: SESSIONS } }); render(<TopStrip fetchFn={h.fetchFn} />);
    expect(screen.queryByRole('region', { name: 'Sessions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    const rows = await waitFor(() => { const r = within(screen.getByRole('region', { name: 'Sessions' })).getAllByRole('row'); expect(r.length).toBe(4); return r; });
    expect(h.calls[0]).toMatchObject({ url: '/api/sessions?limit=50', method: 'GET', auth: 'Bearer t' });
    expect(rows[2].textContent).toContain('27/11/2026 00:05'); expect(rows[2].textContent).toContain('8 h 05 min'); expect(rows[2].textContent).toContain('LIVE'); expect(rows[2].textContent).toContain('6');
    expect(rows[1].textContent).toContain('(running)'); expect(rows[3].textContent).toContain('REPLAY');
    fireEvent.click(screen.getByRole('button', { name: 'Close sessions' })); expect(screen.queryByRole('region', { name: 'Sessions' })).toBeNull();
  });
  it('a host that does not answer shows Try again, and an empty list says so', async () => {
    live(); let r: Reply = { status: 500 }; const h = host({ '/api/sessions': () => r }); render(<TopStrip fetchFn={h.fetchFn} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    await screen.findByText(/The host did not answer/);
    r = { status: 200, body: [] }; fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No sessions yet.');
  });
});

describe('End shift (3.7)', () => {
  const withOpenItems = () => live({
    nodes: [{ ...snapshot().nodes[0], mandown: 1, level: 'DANGER' }],
    open_alerts: [alertMsg(0, { acknowledged_ts: null })], open_episodes: [{ episode_id: 3, node_id: 1, kind: 'MAN_DOWN', state: 'OPEN', man_down_motion_state: null, resolve_reason: null, operator: null }],
  });
  it('lists every open alert, open episode and latched node, and sends nothing until END is typed', () => {
    withOpenItems(); const h = host({}); render(<TopStrip fetchFn={h.fetchFn} />);
    fireEvent.click(screen.getByRole('button', { name: 'End shift' }));
    const dlg = screen.getByRole('dialog', { name: 'End shift' });
    expect(within(dlg).getByRole('region', { name: 'Open alerts' }).textContent).toContain('DANGER, not acknowledged');
    expect(within(dlg).getByRole('region', { name: 'Open episodes' }).textContent).toContain('man-down, episode 3, not acknowledged');
    expect(within(dlg).getByRole('region', { name: 'Latched jackets' }).textContent).toContain('FF-01: jacket latched');
    expect(dlg.textContent).toContain('does not silence or hide anything');
    const go = within(dlg).getByRole('button', { name: 'End shift' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText('Type END to confirm'), { target: { value: 'end' } }); expect(go.disabled).toBe(true);
    fireEvent.click(go); expect(h.calls).toHaveLength(0);
    fireEvent.change(within(dlg).getByLabelText('Type END to confirm'), { target: { value: 'END' } }); expect(go.disabled).toBe(false);
  });
  it('is never blocked: the button works with nothing open, before Start monitoring and while the host recovers', () => {
    live({ monitoring_active: false, recovering: true }); render(<TopStrip fetchFn={host({}).fetchFn} />);
    fireEvent.click(screen.getByRole('button', { name: 'End shift' }));
    expect(screen.getByRole('dialog').textContent).toContain('Nothing is open right now.');
  });
  it('Cancel and Escape close it with no call', () => {
    const h = host({}); live(); render(<TopStrip fetchFn={h.fetchFn} />);
    fireEvent.click(screen.getByRole('button', { name: 'End shift' })); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'End shift' })); fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.calls).toHaveLength(0);
  });
  it('sends END with the open session id, then shows the summary while the live screen stays', async () => {
    withOpenItems();
    const h = host({ '/api/session/end': { status: 200, body: { closed_session_id: 4, new_session_id: 5, backup_ok: true } }, '/api/sessions': { status: 200, body: SESSIONS } });
    render(<Shell {...deps()} fetchFn={h.fetchFn} />);
    fireEvent.click(screen.getByRole('button', { name: 'End shift' }));
    fireEvent.change(screen.getByLabelText('Type END to confirm'), { target: { value: 'END' } });
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'End shift' })); });
    expect(h.calls.find((c) => c.url === '/api/session/end')).toMatchObject({ url: '/api/session/end', method: 'POST', body: '{"confirm_text":"END","session_id":4}' });
    const sum = await screen.findByRole('region', { name: 'Shift summary' });
    await within(sum).findByText('8 h 05 min');
    expect(sum.textContent).toContain('Backup saved'); expect(sum.textContent).toContain('FF-01: ✖ DANGER'); expect(sum.textContent).toContain('Alerts raised6'); expect(sum.textContent).toContain('Unresolved episodes1');
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByTestId('live')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close summary' })); expect(screen.queryByRole('region', { name: 'Shift summary' })).toBeNull();
  });
  it('a refused End shift keeps the dialog and the words say why (recovering, another screen, no answer)', async () => {
    live(); let r: Reply = { status: 409, body: { error_code: 'RECOVERING', detail: 'x', retry_after_s: 3 } }; const h = host({ '/api/session/end': () => r });
    render(<TopStrip fetchFn={h.fetchFn} />);
    fireEvent.click(screen.getByRole('button', { name: 'End shift' })); fireEvent.change(screen.getByLabelText('Type END to confirm'), { target: { value: 'END' } });
    const go = () => act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'End shift' })); });
    await go(); expect(screen.getByRole('status').textContent).toBe('The host is recovering. Try again in 3 s.');
    r = { status: 409, body: { error_code: 'STATE_CONFLICT', detail: 'x', retry_after_s: null } }; await go(); expect(screen.getByRole('status').textContent).toBe('The shift was already ended from another screen.');
    r = { status: 503 }; await go(); expect(screen.getByRole('status').textContent).toBe('The host did not answer. Try again.');
    expect(screen.queryByRole('dialog')).not.toBeNull(); expect(screen.queryByRole('region', { name: 'Shift summary' })).toBeNull();
  });
});

describe('Shift summary', () => {
  const api = (f: typeof fetch) => ({ fetchFn: f, getToken: () => 't' });
  it('a failed backup is shown as failed, and the CSV button downloads that session with the token', async () => {
    live(); const h = host({ '/api/sessions': { status: 200, body: SESSIONS }, '/api/export.csv': { status: 200 } }); const log: string[] = [];
    render(<ShiftSummary api={api(h.fetchFn)} closedId={4} backupOk={false} onClose={() => {}} saveDeps={{ createObjectURL: () => 'blob:9', revokeObjectURL: () => {}, click: (u, n) => log.push(`${u} ${n}`) }} />);
    expect(screen.getByText(/Backup FAILED/)).not.toBeNull();
    await screen.findByText('8 h 05 min');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download CSV' })); });
    expect(h.calls.find((c) => c.url.startsWith('/api/export.csv'))).toMatchObject({ url: '/api/export.csv?session_id=4', auth: 'Bearer t' });
    expect(log).toEqual(['blob:9 session-4.csv']); expect(screen.getByText('Saved session-4.csv.')).not.toBeNull();
  });
  it('figures that cannot be loaded say so and can be retried; the backup result and CSV still show', async () => {
    live(); let r: Reply = { status: 500 }; const h = host({ '/api/sessions': () => r });
    render(<ShiftSummary api={api(h.fetchFn)} closedId={4} backupOk={true} onClose={() => {}} />);
    await screen.findByText(/figures could not be loaded/); expect(screen.getByText('Backup saved')).not.toBeNull(); expect(screen.getByRole('button', { name: 'Download CSV' })).not.toBeNull();
    r = { status: 200, body: SESSIONS }; fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await screen.findByText('8 h 05 min');
  });
  it('a responder with no warning or danger says so', async () => {
    live({ roster: [{ node_id: 1, alias: 'FF-01', active: 1 }, { node_id: 2, alias: 'FF-02', active: 1 }] });
    const h = host({ '/api/sessions': { status: 200, body: SESSIONS } }); render(<ShiftSummary api={api(h.fetchFn)} closedId={4} backupOk={true} onClose={() => {}} />);
    await screen.findByText('8 h 05 min'); expect(screen.getByText('No warning or danger')).not.toBeNull();
  });
});
