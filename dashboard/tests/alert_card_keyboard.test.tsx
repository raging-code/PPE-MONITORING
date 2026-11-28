// @vitest-environment jsdom
// Requirements: REQ-UI-001, REQ-UI-007
// ADR 0068: a responder alert card selects its node from the keyboard through a real button in its heading.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import LiveScreen from '../src/components/LiveScreen.tsx';
import { liveStore } from '../src/store/live.ts';
import { uiStore } from '../src/store/ui.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const node = (id: number, level: string) => ({
  node_id: id, alias: `FF-0${id}`, last_rx_ts: 900, co_ppm: 52.4, temp_c: 31.2, hum_pct: 44, motion_g: 0.08, bat_pct: 86, scba: 1, mandown: 0,
  level, link_state: 'ok', status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0, co_validity: 'VALID', co_reason: null, scba_correction: null,
});
const body = (id: number, type: string, level: string, nodeId: number) => ({
  alert_id: id, node_id: nodeId, alert_type: type, level, reasons: null, authenticated: 1, episode_id: null, raised_ts: 1000 + id,
  cleared_ts: null, acknowledged_ts: null, acknowledged_by: null, unauth_count: null, last_seen_ts: null,
});
const load = (alerts: unknown[]) => act(() => {
  const nodes = ['NORMAL', 'WARNING', 'DANGER'].map((l, i) => node(i + 1, l));
  const roster = nodes.map((n) => ({ node_id: n.node_id, alias: n.alias, active: 1 }));
  liveStore.setState(apply(initialState('CONNECTING'), snapshot({ srv_ts: 126000, roster, nodes, open_alerts: alerts }) as unknown as ServerMessage).state);
});
const card = (key: string) => screen.getByTestId(`card-${key}`);

beforeEach(() => uiStore.setState({ selected: null, minimized: {}, dismissed: {} }));
afterEach(cleanup);

describe('alert card keyboard selection', () => {
  it('the heading of a responder card holds a real, focusable button with the level and the alias', () => {
    load([body(1, 'man_down', 'DANGER', 1)]);
    render(<LiveScreen />);
    const btn = within(within(card('n1')).getByRole('heading')).getByRole('button');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.tabIndex).toBe(0);
    expect(btn.textContent).toContain('DANGER');
    expect(btn.textContent).toContain('FF-01');
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });
  it('pressing that button selects the responder of the card', () => {
    load([body(1, 'man_down', 'DANGER', 1)]);
    render(<LiveScreen />);
    uiStore.setState({ selected: 2 });
    fireEvent.click(within(within(card('n1')).getByRole('heading')).getByRole('button'));
    expect(uiStore.getState().selected).toBe(1);
  });
  it('the card itself stays a plain region: no role and no tabindex, so no button sits inside another interactive element', () => {
    load([body(1, 'man_down', 'DANGER', 1)]);
    render(<LiveScreen />);
    expect(card('n1').getAttribute('role')).toBeNull();
    expect(card('n1').getAttribute('tabindex')).toBeNull();
  });
  it('a card that is not a responder card has no heading button', () => {
    load([body(5, 'estimate', 'NONE', 1)]);
    render(<LiveScreen />);
    expect(within(card('e5')).queryByRole('heading')).toBeNull();
  });
});
