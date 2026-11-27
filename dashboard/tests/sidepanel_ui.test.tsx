// @vitest-environment jsdom
// Requirements: REQ-SES-001, REQ-UI-001
// P22d-1: side panel, last seen on the cards, mode word and chips in the top strip. Layout is structural only (jsdom has no layout engine, ADR 0024).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import Shell from '../src/components/Shell.tsx';
import LiveScreen from '../src/components/LiveScreen.tsx';
import { liveStore } from '../src/store/live.ts';
import { uiStore } from '../src/store/ui.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import { wdStore } from '../src/store/watchdog.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const node = (id: number, over: Record<string, unknown> = {}) => ({ node_id: id, alias: `FF-0${id}`, last_rx_ts: 900, co_ppm: 12, temp_c: 31.2, hum_pct: 44, motion_g: 0.08, bat_pct: 86, scba: 1, mandown: 0,
  level: 'NORMAL', link_state: 'ok', status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0, co_validity: 'VALID', co_reason: null, scba_correction: null, ...over });
const dangerAlert = { alert_id: 2, node_id: 2, alert_type: 'man_down', level: 'DANGER', reasons: null, authenticated: 1, episode_id: null, raised_ts: 1002, cleared_ts: null, acknowledged_ts: null, acknowledged_by: null, unauth_count: null, last_seen_ts: null };
const load = (over: Record<string, unknown> = {}, nodes = [node(1), node(2)]) => act(() => {
  const roster = nodes.map((n) => ({ node_id: n.node_id, alias: n.alias, active: 1 }));
  liveStore.setState(apply(initialState('CONNECTING'), snapshot({ srv_ts: 2000, roster, nodes, ...over }) as unknown as ServerMessage).state);
});
const push = (m: Record<string, unknown>) => act(() => { liveStore.setState(apply(liveStore.getState(), { v: 1, ...m } as unknown as ServerMessage).state); });
const deps = () => ({ controller: { start: vi.fn(), login: vi.fn() }, bridge: { init: vi.fn() } });
beforeEach(() => { window.sessionStorage.clear(); wdStore.setState({ noData: false, sirenOn: false }); uiStore.setState({ selected: null, minimized: {}, dismissed: {} }); });
afterEach(cleanup);

describe('side panel (3.1, 3.2)', () => {
  it('shows 8 rows for the selected responder, Details collapsed, and the one chart in its slot', () => {
    load(); render(<LiveScreen />);
    const side = screen.getByTestId('side'); expect(side.querySelectorAll('[data-testid^="row-"]')).toHaveLength(8);
    expect((within(side).getByTestId('row-details') as HTMLDetailsElement).open).toBe(false);
    expect(within(within(side).getByTestId('chart-slot')).getByTestId('co-chart')).toBeTruthy(); expect(screen.getAllByTestId('co-chart')).toHaveLength(1);
    expect(within(side).getByTestId('row-co').textContent).toContain('12 ppm');
  });
  it('follows the selected jacket, and a new reading fills the backend-estimate stillness and the Details row', () => {
    load(); render(<LiveScreen />); fireEvent.click(screen.getByTestId('node-2')); expect(screen.getByTestId('side').textContent).toContain('FF-02 readings');
    push({ type: 'reading', srv_seq: 1, srv_ts: 2100, node_id: 2, alias: 'FF-02', rx_ts: 2050, co_ppm: 12, co_over_range: 0, co_validity: 'VALID', co_reason: null, temp_c: 31, hum_pct: 44, motion_g: 0.01, posture: 'HORIZONTAL',
      stillness_s: 12, bat_pct: 80, scba: 1, mandown: 0, level: 'NORMAL', reasons: [], seq_class: 'fresh', rssi: -90, snr: 5, status2: 0, flags: 0, id_mode: 74, status3: 0, status4: 0 });
    expect(screen.getByTestId('row-motion').textContent).toContain('(backend estimate)'); expect(screen.getByTestId('row-details').textContent).toContain('posture horizontal, RSSI -90 dBm');
  });
  it('an unreliable CO shows the low-confidence line and the grey tone', () => {
    load({}, [node(1, { co_validity: 'UNRELIABLE', co_reason: 'co_range' })]); render(<LiveScreen />);
    const r = screen.getByTestId('row-co'); expect(r.textContent).toContain('low confidence: CO sensor out of range'); expect(r.getAttribute('data-tone')).toBe('grey');
  });
  it('the advisory is one line with its quality as a word and dots, and a low one is grey', () => {
    load(); render(<LiveScreen />); expect(screen.queryByTestId('advisory-line')).toBeNull();
    push({ type: 'advisory', srv_seq: 1, srv_ts: 2100, node_id: 1, risk: 'ELEVATED_EXPOSURE', reasons: 'x', action: 'Review exposure', quality: 'low', source: 'table' });
    const a = screen.getByTestId('advisory-line'); expect(a.textContent).toContain('Elevated exposure: Review exposure'); expect(a.textContent).toContain('low ●○○'); expect(a.className).toContain('text-stale-text');
  });
  it('a side panel that fails leaves the node cards working', () => {
    load(); const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    liveStore.setState({ ...liveStore.getState(), advisories: { 1: { node_id: 1, risk: null, action: 'x', quality: 'high', reasons: '', source: 'table', srv_ts: 1 } as never } });
    render(<LiveScreen />); expect(screen.getByText('Readings unavailable')).toBeTruthy(); expect(screen.getByTestId('node-1')).toBeTruthy(); err.mockRestore();
  });
});

describe('node cards and top strip (3.1)', () => {
  it('each card shows the last seen time from server time', () => {
    load(); render(<LiveScreen />); expect(screen.getByTestId('node-1').textContent).toContain('Last seen 1 s ago');
    load({ srv_ts: 200000 }); expect(screen.getByTestId('node-1').textContent).toMatch(/Last seen \d\d:\d\d:\d\d/);
  });
  it('the strip shows LIVE, or TEST for a simulator or replay session', () => {
    load(); const r = render(<Shell {...deps()} />); expect(screen.getByTestId('mode-word').textContent).toBe('LIVE'); r.unmount();
    load({ session: { session_id: 5, started_ts: 1, mode: 'REPLAY', session_label: null } }); render(<Shell {...deps()} />); expect(screen.getByTestId('mode-word').textContent).toBe('TEST');
  });
  it('minimized chips sit in the header, first after the session row, once, and never in the readings area', () => {
    load({ open_alerts: [dangerAlert] }); render(<Shell {...deps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    const chips = screen.getAllByRole('navigation', { name: 'Minimized alerts' }); expect(chips).toHaveLength(1);
    const top = screen.getByTestId('top'); expect(top.contains(chips[0])).toBe(true); expect(screen.getByRole('main').contains(chips[0])).toBe(false);
    expect(top.firstElementChild!.nextElementSibling).toBe(chips[0]); // right after the Session row, above the banners
    fireEvent.click(chips[0].querySelector('button')!); expect(screen.getByTestId('tray').querySelectorAll('[data-kind="responder"]')).toHaveLength(1);
  });
});
