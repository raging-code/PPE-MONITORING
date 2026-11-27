// @vitest-environment jsdom
// Requirements: REQ-UI-001
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import LiveScreen from '../src/components/LiveScreen.tsx';
import { liveStore } from '../src/store/live.ts';
import { uiStore } from '../src/store/ui.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { alert as alertMsg, snapshot } from './helpers.ts';

const node = (id: number, level: string) => ({
  node_id: id, alias: `FF-0${id}`, last_rx_ts: 900, co_ppm: 52.4, temp_c: 31.2, hum_pct: 44, motion_g: 0.08, bat_pct: 86, scba: 1, mandown: 0,
  level, link_state: 'ok', status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0, co_validity: 'VALID', co_reason: null, scba_correction: null,
});
const body = (id: number, type: string, level: string, nodeId: number, over: Record<string, unknown> = {}) => ({
  alert_id: id, node_id: nodeId, alert_type: type, level, reasons: null, authenticated: 1, episode_id: null, raised_ts: 1000 + id,
  cleared_ts: null, acknowledged_ts: null, acknowledged_by: null, unauth_count: null, last_seen_ts: null, ...over,
});
const LEVELS = ['NORMAL', 'WARNING', 'DANGER'];
const load = (alerts: unknown[], levels = LEVELS, srvTs = 126000) => act(() => {
  const nodes = levels.map((l, i) => node(i + 1, l));
  const roster = nodes.map((n) => ({ node_id: n.node_id, alias: n.alias, active: 1 }));
  liveStore.setState(apply(initialState('CONNECTING'), snapshot({ srv_ts: srvTs, roster, nodes, open_alerts: alerts }) as unknown as ServerMessage).state);
});
const card = (key: string) => screen.getByTestId(`card-${key}`);

beforeEach(() => uiStore.setState({ selected: null, minimized: {}, dismissed: {} }));
afterEach(cleanup);

describe('node cards', () => {
  it('colour, icon and word come from the level only', () => {
    load([body(1, 'battery_low', 'WARNING', 1), body(2, 'estimate', 'NONE', 1)]); // alerts on a NORMAL node do not recolour it
    render(<LiveScreen />);
    const [n1, n2, n3] = [1, 2, 3].map((i) => screen.getByTestId(`node-${i}`));
    expect(n1.className).toContain('bg-level-normal'); expect(n1.className).not.toContain('level-warning'); expect(n1.textContent).toContain('OK');
    expect(n2.className).toContain('bg-level-warning'); expect(n2.textContent).toContain('WARNING');
    expect(n3.className).toContain('bg-level-danger'); expect(n3.textContent).toContain('DANGER');
    expect(n3.textContent).toContain('✖');
  });
  it('shows at most 2 badges, the most severe first', () => {
    load([body(1, 'scba_expired', 'WARNING', 1), body(2, 'sensor_fault', 'WARNING', 1), body(3, 'co_threshold', 'DANGER', 1)]);
    render(<LiveScreen />);
    const n1 = screen.getByTestId('node-1');
    expect(within(n1).queryByText('CO 52 ppm, SCBA OFF')).not.toBeNull();
    expect(within(n1).queryByText('SCBA EXPIRED: CO alarms active')).not.toBeNull();
    expect(within(n1).queryByText('SENSOR FAULT: reading unknown')).toBeNull();
  });
});

describe('alert cards', () => {
  it('every card shows its catalog text with the live value', () => {
    load([body(1, 'co_threshold', 'WARNING', 1)]);
    render(<LiveScreen />);
    expect(within(card('n1')).queryByText('FF-01 CO 52 ppm, SCBA OFF')).not.toBeNull();
    expect(card('n1').textContent).toContain('WARNING');
  });
  it('an estimate card has a dashed border and a grey label, never a level colour', () => {
    load([body(5, 'estimate', 'NONE', 1)]);
    render(<LiveScreen />);
    const c = card('e5');
    expect(c.className).toContain('border-dashed');
    expect(c.outerHTML).not.toContain('level-');
    expect(within(c).queryByText('estimate')).not.toBeNull();
  });
  it('an unverified alert is a dashed card with its repeat count', () => {
    load([body(6, 'unauth_alert', 'NONE', 1, { unauth_count: 3 })]);
    render(<LiveScreen />);
    const c = card('u6');
    expect(c.className).toContain('border-dashed');
    expect(within(c).queryByText('unverified')).not.toBeNull();
    expect(within(c).queryByText('×3')).not.toBeNull();
  });
  it('a repeat alert joins its card with a count; after Acknowledge a new raise is a new line', () => {
    load([body(5, 'co_threshold', 'WARNING', 1, { cleared_ts: 1100 }), body(6, 'co_threshold', 'WARNING', 1)]);
    const { unmount } = render(<LiveScreen />);
    expect(within(card('n1')).getAllByText('FF-01 CO 52 ppm, SCBA OFF')).toHaveLength(1);
    expect(within(card('n1')).queryByText('×2')).not.toBeNull();
    unmount();
    load([body(5, 'co_threshold', 'WARNING', 1, { acknowledged_ts: 1200 }), body(6, 'co_threshold', 'WARNING', 1)]);
    render(<LiveScreen />);
    expect(within(card('n1')).getAllByText('FF-01 CO 52 ppm, SCBA OFF')).toHaveLength(2);
    expect(within(card('n1')).queryByText('×2')).toBeNull();
  });
  it('a cleared alert that nobody acknowledged stays, marked cleared', () => {
    load([body(5, 'co_threshold', 'WARNING', 1, { cleared_ts: 1100 })]);
    render(<LiveScreen />);
    expect(within(card('n1')).queryByText('cleared')).not.toBeNull();
  });
  it('shows 3 lines and "+n more", which opens inside the card', () => {
    load([body(1, 'man_down', 'DANGER', 1), body(2, 'co_threshold', 'DANGER', 1), body(3, 'heat', 'WARNING', 1), body(4, 'battery_low', 'WARNING', 1)]);
    render(<LiveScreen />);
    expect(within(card('n1')).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(within(card('n1')).getByRole('button', { name: '+1 more' }));
    expect(within(card('n1')).getAllByRole('listitem')).toHaveLength(4);
  });
  it('Minimize turns a card into a chip with alias, level, count and elapsed time; the chip reopens it; a new raise reopens it too', () => {
    load([body(1, 'man_down', 'DANGER', 1), body(2, 'mayday', 'DANGER', 1)]);
    render(<LiveScreen />);
    fireEvent.click(within(card('n1')).getByRole('button', { name: 'Minimize' }));
    expect(screen.queryByTestId('card-n1')).toBeNull();
    expect(screen.getByTestId('chip-n1').textContent).toBe('FF-01 DANGER ×2 2:04');
    fireEvent.click(screen.getByTestId('chip-n1'));
    expect(screen.queryByTestId('card-n1')).not.toBeNull();
    fireEvent.click(within(card('n1')).getByRole('button', { name: 'Minimize' }));
    act(() => { liveStore.setState(apply(liveStore.getState(), alertMsg(1, { alert_id: 9, node_id: 1, alert_type: 'heat', level: 'WARNING', episode_id: null }) as unknown as ServerMessage).state); });
    expect(screen.queryByTestId('card-n1')).not.toBeNull();
  });
  it('a safety card cannot be dismissed; an estimate card can', () => {
    load([body(1, 'man_down', 'DANGER', 1), body(5, 'estimate', 'NONE', 2)]);
    render(<LiveScreen />);
    expect(within(card('n1')).queryByRole('button', { name: 'Dismiss' })).toBeNull();
    fireEvent.click(within(card('e5')).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('card-e5')).toBeNull();
    expect(screen.queryByTestId('card-n1')).not.toBeNull();
  });
  it('a card flashes only while an alert is open and unacknowledged', () => {
    load([body(1, 'heat', 'WARNING', 1)]);
    const { unmount } = render(<LiveScreen />);
    expect(card('n1').className).toContain('flash');
    expect(screen.getByTestId('node-1').className).toContain('flash');
    unmount();
    load([body(1, 'heat', 'WARNING', 1, { acknowledged_ts: 1200 })]);
    render(<LiveScreen />);
    expect(card('n1').className).not.toContain('flash');
  });
});

describe('selection and tray', () => {
  it('a new alert never switches the selected jacket; clicking a card selects that responder', () => {
    load([]);
    render(<LiveScreen />);
    fireEvent.click(screen.getByTestId('node-2'));
    expect(screen.getByTestId('node-2').getAttribute('aria-pressed')).toBe('true');
    act(() => { liveStore.setState(apply(liveStore.getState(), alertMsg(1, { alert_id: 9, node_id: 1, alert_type: 'man_down', level: 'DANGER' }) as unknown as ServerMessage).state); });
    expect(uiStore.getState().selected).toBe(2);
    expect(screen.getByTestId('node-2').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('node-1').className).toContain('flash'); // the entry flashes instead
    fireEvent.click(card('n1'));
    expect(uiStore.getState().selected).toBe(1);
  });
  it('3 responders in alert plus 1 estimate make 3 safety cards and 1 slim card, all in normal flow', () => {
    load([body(1, 'man_down', 'DANGER', 1), body(2, 'co_threshold', 'DANGER', 2), body(3, 'heat', 'WARNING', 3), body(4, 'estimate', 'NONE', 1)]);
    render(<LiveScreen />);
    const tray = screen.getByTestId('tray');
    expect(tray.querySelectorAll('[data-kind="responder"]')).toHaveLength(3);
    expect(tray.querySelectorAll('[data-kind="slim"]')).toHaveLength(1);
    expect(tray.outerHTML).not.toMatch(/\b(absolute|fixed|sticky)\b/); // the tray pushes the page down; real overlap is measured in P22c Playwright
  });
});
