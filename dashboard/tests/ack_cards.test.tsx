// @vitest-environment jsdom
// Requirements: REQ-API-003, REQ-UI-003, REQ-UI-009
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import LiveScreen from '../src/components/LiveScreen.tsx';
import { liveStore } from '../src/store/live.ts';
import { uiStore } from '../src/store/ui.ts';
import { acksStore, createActions } from '../src/store/actions.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const node = (id: number, level: string) => ({
  node_id: id, alias: `FF-0${id}`, last_rx_ts: 900, co_ppm: 52.4, temp_c: 31.2, hum_pct: 44, motion_g: 0.08, bat_pct: 86, scba: 1, mandown: 0,
  level, link_state: 'ok', status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0, co_validity: 'VALID', co_reason: null, scba_correction: null,
});
const body = (id: number, type: string, level: string, over: Record<string, unknown> = {}) => ({
  alert_id: id, node_id: 1, alert_type: type, level, reasons: null, authenticated: 1, episode_id: null, raised_ts: 1000 + id,
  cleared_ts: null, acknowledged_ts: null, acknowledged_by: null, unauth_count: null, last_seen_ts: null, ...over,
});
const episode = (state: string) => ({ episode_id: 3, node_id: 1, kind: 'MAN_DOWN', state, man_down_motion_state: null, resolve_reason: null, operator: null });
const load = (alerts: unknown[], episodes: unknown[] = []) => act(() => {
  const nodes = [node(1, 'DANGER')], roster = [{ node_id: 1, alias: 'FF-01', active: 1 }];
  liveStore.setState(apply(initialState('CONNECTING'), snapshot({ roster, nodes, open_alerts: alerts, open_episodes: episodes }) as unknown as ServerMessage).state);
});
// A host that answers when the test says so.
function host() {
  const calls: { url: string; body: string }[] = [], waiting: ((r: { status: number; body: unknown }) => void)[] = [];
  const fetchFn = ((url: string, init: RequestInit) => new Promise((res) => {
    calls.push({ url, body: String(init.body) });
    waiting.push((r) => res({ status: r.status, json: async () => r.body } as Response));
  })) as unknown as typeof fetch;
  return { calls, answer: (status: number, b: unknown) => act(async () => { waiting.shift()?.({ status, body: b }); await Promise.resolve(); await Promise.resolve(); }), actions: createActions({ fetchFn, getToken: () => 't' }) };
}
const card = () => screen.getByTestId('card-n1');

beforeEach(() => { uiStore.setState({ selected: null, minimized: {}, dismissed: {} }); acksStore.setState({ acks: {} }); });
afterEach(cleanup);

describe('Acknowledge', () => {
  it('silences the card at once with "ack pending", then the host confirms; the card is silent after a reload too', async () => {
    const h = host();
    load([body(1, 'heat', 'WARNING')]);
    render(<LiveScreen actions={h.actions} />);
    expect(card().className).toContain('flash');
    fireEvent.click(within(card()).getByRole('button', { name: 'Acknowledge' }));
    expect(card().className).not.toContain('flash'); // before the host answered
    expect(within(card()).queryByText('ack pending')).not.toBeNull();
    expect(within(card()).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(h.calls[0].url).toBe('/api/alerts/1/ack');
    await h.answer(200, { alert_id: 1, acknowledged_ts: 5000, acknowledged_by: 1 });
    expect(within(card()).queryByText('ack pending')).toBeNull();
    expect(card().className).not.toContain('flash');
    cleanup(); acksStore.setState({ acks: {} }); // reload: the snapshot carries the host's acknowledgement
    load([body(1, 'heat', 'WARNING', { acknowledged_ts: 5000, acknowledged_by: 1 })]);
    render(<LiveScreen actions={h.actions} />);
    expect(card().className).not.toContain('flash');
    expect(within(card()).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  });
  it('a failed call keeps the card silenced', async () => {
    const h = host();
    load([body(1, 'heat', 'WARNING')]);
    render(<LiveScreen actions={h.actions} />);
    fireEvent.click(within(card()).getByRole('button', { name: 'Acknowledge' }));
    await h.answer(500, {});
    expect(card().className).not.toContain('flash');
    expect(within(card()).queryByText('ack pending')).not.toBeNull();
  });
  it('an estimate card has no Acknowledge; an unverified card does', () => {
    load([body(5, 'estimate', 'NONE'), body(6, 'unauth_alert', 'NONE')]);
    render(<LiveScreen actions={host().actions} />);
    expect(within(screen.getByTestId('card-e5')).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(within(screen.getByTestId('card-u6')).queryByRole('button', { name: 'Acknowledge' })).not.toBeNull();
  });
  it('an episode card is acknowledged through the episode call', () => {
    const h = host();
    load([body(1, 'man_down', 'DANGER', { episode_id: 3 })], [episode('OPEN')]);
    render(<LiveScreen actions={h.actions} />);
    fireEvent.click(within(card()).getByRole('button', { name: 'Acknowledge' }));
    expect(h.calls.map((c) => c.url)).toEqual(['/api/episodes/3/ack']);
  });
});

describe('Resolve', () => {
  it('is not offered before the host has acknowledged the episode', () => {
    load([body(1, 'man_down', 'DANGER', { episode_id: 3 })], [episode('OPEN')]);
    render(<LiveScreen actions={host().actions} />);
    expect(within(card()).queryByRole('button', { name: 'Resolve' })).toBeNull();
  });
  it('opens a dialog that names the node and the episode, needs a reason, and sends the reason once', async () => {
    const h = host();
    load([body(1, 'man_down', 'DANGER', { episode_id: 3, acknowledged_ts: 1200 })], [episode('ACKNOWLEDGED')]);
    render(<LiveScreen actions={h.actions} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(card()).getByRole('button', { name: 'Resolve' }));
    const dlg = screen.getByRole('dialog', { name: 'Resolve FF-01, episode 3' });
    expect(dlg.textContent).toContain('FF-01'); expect(dlg.textContent).toContain('episode 3'); expect(dlg.textContent).toContain('CANCEL button on the jacket');
    const confirm = within(dlg).getByRole('button', { name: 'Confirm resolve' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm); expect(h.calls).toHaveLength(0);
    fireEvent.click(within(dlg).getByLabelText('Rescued'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(h.calls).toEqual([{ url: '/api/episodes/3/resolve', body: '{"reason":"rescued"}' }]);
    await h.answer(200, { episode_id: 3, state: 'RESOLVED', resolved_ts: 9, resolve_reason: 'rescued', resolved_by: 1, latch_still_set: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(card()).getByRole('status').textContent).toContain('CANCEL');
  });
  it('offers the three reasons of the host and nothing else', () => {
    load([body(1, 'man_down', 'DANGER', { episode_id: 3, acknowledged_ts: 1200 })], [episode('ACKNOWLEDGED')]);
    render(<LiveScreen actions={host().actions} />);
    fireEvent.click(within(card()).getByRole('button', { name: 'Resolve' }));
    expect(screen.getAllByRole('radio').map((r) => r.parentElement?.textContent)).toEqual(['Rescued', 'False alarm', 'Device removed']);
  });
  it('Cancel and Escape close the dialog without a call, and the card stays unresolved', () => {
    const h = host();
    load([body(1, 'man_down', 'DANGER', { episode_id: 3, acknowledged_ts: 1200 })], [episode('ACKNOWLEDGED')]);
    render(<LiveScreen actions={h.actions} />);
    fireEvent.click(within(card()).getByRole('button', { name: 'Resolve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(card()).getByRole('button', { name: 'Resolve' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.calls).toHaveLength(0); expect(within(card()).queryByRole('button', { name: 'Resolve' })).not.toBeNull();
  });
  it('a call the host did not answer keeps the dialog open so the operator can try again', async () => {
    const h = host();
    load([body(1, 'man_down', 'DANGER', { episode_id: 3, acknowledged_ts: 1200 })], [episode('ACKNOWLEDGED')]);
    render(<LiveScreen actions={h.actions} />);
    fireEvent.click(within(card()).getByRole('button', { name: 'Resolve' }));
    fireEvent.click(screen.getByLabelText('False alarm')); fireEvent.click(screen.getByRole('button', { name: 'Confirm resolve' }));
    await h.answer(503, {});
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByRole('status').textContent).toBe('The host did not answer. Try again.');
    expect((within(dlg).getByLabelText('False alarm') as HTMLInputElement).checked).toBe(true);
  });
  it('a card of another kind never offers Resolve', () => {
    load([body(1, 'heat', 'WARNING')]);
    render(<LiveScreen actions={host().actions} />);
    expect(within(card()).queryByRole('button', { name: 'Resolve' })).toBeNull();
  });
});
