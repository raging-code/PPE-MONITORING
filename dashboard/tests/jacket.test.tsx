// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import LiveScreen from '../src/components/LiveScreen.tsx';
import { liveStore } from '../src/store/live.ts';
import { uiStore } from '../src/store/ui.ts';
import { acksStore, createActions } from '../src/store/actions.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const node = (id: number, over: Record<string, unknown> = {}) => ({
  node_id: id, alias: `FF-0${id}`, last_rx_ts: 900, co_ppm: 52.4, temp_c: 31.2, hum_pct: 44, motion_g: 0.08, bat_pct: 86, scba: 1, mandown: 0,
  level: 'NORMAL', link_state: 'ok', status2: 2, flags: 0, id_mode: 73, status3: 0, status4: 0, co_validity: 'VALID', co_reason: null, scba_correction: null, ...over,
});
const alertRow = { alert_id: 1, node_id: 1, alert_type: 'heat', level: 'WARNING', reasons: null, authenticated: 1, episode_id: null, raised_ts: 1001, cleared_ts: null, acknowledged_ts: null, acknowledged_by: null, unauth_count: null, last_seen_ts: null };
const load = (nodes: unknown[], alerts: unknown[] = []) => act(() => {
  const roster = (nodes as { node_id: number; alias: string }[]).map((n) => ({ node_id: n.node_id, alias: n.alias, active: 1 }));
  liveStore.setState(apply(initialState('CONNECTING'), snapshot({ roster, nodes, open_alerts: alerts }) as unknown as ServerMessage).state);
});
beforeEach(() => { uiStore.setState({ selected: null, minimized: {}, dismissed: {} }); acksStore.setState({ acks: {} }); });
afterEach(cleanup);

describe('flat component grid', () => {
  it('shows the nine components of the selected responder, and follows the selection', () => {
    load([node(1), node(2, { status3: 0x08 })]);
    render(<LiveScreen />);
    expect(within(screen.getByTestId('grid')).getAllByRole('listitem')).toHaveLength(9);
    expect(screen.getByTestId('hs-scba_coupling').textContent).toContain('ON');
    fireEvent.click(screen.getByTestId('node-2'));
    expect(screen.getByTestId('grid').textContent).toContain('FF-02 components');
    expect(screen.getByTestId('hs-scba_coupling').textContent).toContain('EXPIRED');
  });
  it('a coloured row also has an icon and a word, and a grey row says the reading is unknown', () => {
    load([node(1, { status2: 0x52 })], [alertRow]);
    render(<LiveScreen />);
    const heat = screen.getByTestId('hs-sht40'), co = screen.getByTestId('hs-co_sensor');
    expect(heat.getAttribute('data-tone')).toBe('grey'); // SHT40 fault wins over the heat alert
    expect(heat.textContent).toContain('temperature unknown');
    expect(co.textContent).toContain('CO unknown');
  });
  it('a heat alert gives the SHT40 row the level colour with its icon', () => {
    load([node(1)], [alertRow]);
    render(<LiveScreen />);
    const row = screen.getByTestId('hs-sht40');
    expect(row.className).toContain('bg-level-warning'); expect(row.textContent).toContain('▲');
  });
});

describe('grid failure', () => {
  const Broken = () => { throw new Error('webgl lost'); };
  it('a failing grid shows "Jacket view unavailable" and leaves cards, Acknowledge and Resolve working', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    const fetchFn = (async (url: string) => { calls.push(url); return { status: 200, json: async () => ({ acknowledged_ts: 5 }) } as Response; }) as unknown as typeof fetch;
    load([node(1, { level: 'DANGER' })], [{ ...alertRow, alert_type: 'man_down', level: 'DANGER', episode_id: 3 }]);
    render(<LiveScreen grid={Broken} actions={createActions({ fetchFn, getToken: () => 't' })} />);
    expect(screen.getByTestId('jacket-fallback').textContent).toBe('Jacket view unavailable');
    expect(screen.getByTestId('node-1').textContent).toContain('DANGER');
    expect(screen.getByTestId('card-n1').className).toContain('flash');
    await act(async () => { fireEvent.click(within(screen.getByTestId('card-n1')).getByRole('button', { name: 'Acknowledge' })); });
    expect(calls).toEqual(['/api/episodes/3/ack']);
    expect(screen.getByTestId('card-n1').className).not.toContain('flash');
    vi.restoreAllMocks();
  });
  it('a failure on one responder does not hide the grid of the next one', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Pick = ({ node: n }: { node: { node_id: number } }) => { if (n.node_id === 1) throw new Error('x'); return <p data-testid="ok-grid">fine</p>; };
    load([node(1), node(2)]);
    render(<LiveScreen grid={Pick as never} />);
    expect(screen.queryByTestId('jacket-fallback')).not.toBeNull();
    fireEvent.click(screen.getByTestId('node-2'));
    expect(screen.queryByTestId('ok-grid')).not.toBeNull(); expect(screen.queryByTestId('jacket-fallback')).toBeNull();
    vi.restoreAllMocks();
  });
});
