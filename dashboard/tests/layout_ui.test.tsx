// @vitest-environment jsdom
// P22c-5. jsdom has no layout engine, so these tests check the structure that makes the layout hold (which box is capped, which scrolls, what sits where)
// and the chart drawing. What the screen looks like at 1366x768 and 150% zoom is a Playwright row (ADR 0023).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import Shell from '../src/components/Shell.tsx';
import LiveScreen from '../src/components/LiveScreen.tsx';
import { Boundary } from '../src/components/JacketView.tsx';
import { liveStore } from '../src/store/live.ts';
import { uiStore } from '../src/store/ui.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import { wdStore } from '../src/store/watchdog.ts';
import { audioStore } from '../src/audio/siren.ts';
import { createGate, gateStore } from '../src/audio/gate.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const node = (id: number, level = 'NORMAL', over: Record<string, unknown> = {}) => ({ node_id: id, alias: `FF-0${id}`, last_rx_ts: 900, co_ppm: 12, temp_c: 31.2, hum_pct: 44, motion_g: 0.08,
  bat_pct: 86, scba: 1, mandown: 0, level, link_state: 'ok', status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0, co_validity: 'VALID', co_reason: null, scba_correction: null, ...over });
const alertBody = (id: number, type: string, level: string, nodeId: number) => ({ alert_id: id, node_id: nodeId, alert_type: type, level, reasons: null, authenticated: 1, episode_id: null,
  raised_ts: 1000 + id, cleared_ts: null, acknowledged_ts: null, acknowledged_by: null, unauth_count: null, last_seen_ts: null });
const load = (over: Record<string, unknown> = {}, nodes = [node(1)]) => act(() => {
  const roster = nodes.map((n) => ({ node_id: n.node_id, alias: n.alias, active: 1 }));
  liveStore.setState(apply(initialState('CONNECTING'), snapshot({ srv_ts: 2000, roster, nodes, ...over }) as unknown as ServerMessage).state);
});
const deps = () => ({ controller: { start: vi.fn(), login: vi.fn() }, bridge: { init: vi.fn() } });
const ALL = { base_offline: true, logging_fault: true, host_gap: { gap_s: 7, reason: null }, host_power: 'battery 40', audio_fault: true };
const mkGate = () => createGate({ api: { fetchFn: (async () => ({ status: 200, json: async () => ({}) })) as unknown as typeof fetch, getToken: () => 't' },
  makeCtx: () => ({ state: 'suspended', sampleRate: 8000, destination: 'd', resume: async () => {}, createBuffer: (_c: number, n: number) => { const a = new Float32Array(n); return { getChannelData: () => a }; },
    createBufferSource: () => ({ buffer: null, loop: false, connect() {}, start() {}, stop() {} }) }) as never });
beforeEach(() => { window.sessionStorage.clear(); wdStore.setState({ noData: false, sirenOn: false }); audioStore.setState({ unlocked: false, ctx: null }); gateStore.setState(gateStore.getInitialState());
  uiStore.setState({ selected: null, minimized: {}, dismissed: {} }); });
afterEach(cleanup);

describe('CO chart (3.2)', () => {
  it('draws the snapshot history with dotted lines at the limits, labelled with the snapshot values', () => {
    load({ co_history_30m: { '1': [[1500, 10], [1800, 20]] }, constants: { co_warn_ppm: 42, co_danger_ppm: 210 } }); render(<LiveScreen />);
    const c = screen.getByTestId('co-chart');
    expect(within(c).getAllByTestId('co-line')).toHaveLength(1);
    expect(c.textContent).toContain('42 ppm warning'); expect(c.textContent).toContain('210 ppm danger'); expect(c.textContent).toContain('FF-01 CO, last 30 minutes');
    for (const id of ['line-warn', 'line-danger']) expect(within(c).getByTestId(id).getAttribute('stroke-dasharray')).toBeTruthy();
    expect(within(c).getByTestId('co-now').textContent).toBe('20.0 ppm');
  });
  it('uses the generated limits (35 and 200 ppm) when the snapshot has none', () => {
    load({ constants: {} }); render(<LiveScreen />);
    expect(screen.getByTestId('co-chart').textContent).toContain('35 ppm warning'); expect(screen.getByTestId('co-chart').textContent).toContain('200 ppm danger');
  });
  it('follows a live reading: the number and the line move with no reload', () => {
    load({ co_history_30m: { '1': [[1500, 10]] } }); render(<LiveScreen />);
    expect(screen.getByTestId('co-now').textContent).toBe('10.0 ppm');
    const r = { v: 1, type: 'reading', srv_seq: 1, srv_ts: 3000, node_id: 1, alias: 'FF-01', rx_ts: 2900, co_ppm: 48.5, co_over_range: 0, co_validity: 'VALID', co_reason: null, temp_c: 31, hum_pct: 44,
      motion_g: 0.1, posture: 'UPRIGHT', stillness_s: 0, bat_pct: 80, scba: 1, mandown: 0, level: 'WARNING', reasons: [], seq_class: 'fresh', rssi: -80, snr: 7, status2: 0, flags: 1, id_mode: 73, status3: 0, status4: 0 };
    act(() => { liveStore.setState(apply(liveStore.getState(), r as unknown as ServerMessage).state); });
    expect(screen.getByTestId('co-now').textContent).toBe('48.5 ppm');
  });
  it('shows "No CO readings yet" and no line when there is no history, and says so when CO is unreliable', () => {
    load({ co_history_30m: {} }, [node(1, 'NORMAL', { co_validity: 'UNRELIABLE' })]); render(<LiveScreen />);
    const c = screen.getByTestId('co-chart'); expect(c.textContent).toContain('No CO readings yet'); expect(within(c).queryAllByTestId('co-line')).toHaveLength(0);
    expect(within(c).getByRole('status').textContent).toBe('CO unreliable: no new points on the line');
  });
  it('shows the chart of the selected responder', () => {
    load({ co_history_30m: { '1': [[1500, 10]], '2': [[1500, 77]] } }, [node(1), node(2)]); render(<LiveScreen />);
    expect(screen.getByTestId('co-now').textContent).toBe('10.0 ppm');
    fireEvent.click(screen.getByTestId('node-2')); expect(screen.getByTestId('co-now').textContent).toBe('77.0 ppm');
  });
  it('a chart that cannot draw is replaced by one line and leaves the rest alone', () => {
    const Bad = (): never => { throw new Error('boom'); }; const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Boundary text="Chart unavailable"><Bad /></Boundary>); expect(screen.getByRole('status').textContent).toBe('Chart unavailable'); spy.mockRestore();
  });
});

describe('layout (3.7): banners cannot push the readings off the screen', () => {
  const full = () => { load({ banners: ALL, recovering: true, session: { session_id: 1, started_ts: 1000, mode: 'SIMULATOR', session_label: null } }, [node(1), node(2, 'DANGER')]); };
  it('with every banner active, the frame is one window high; banners and sound bar sit in a capped header that scrolls, readings and tray sit outside it', () => {
    full(); render(<Shell {...deps()} gate={mkGate()} />);
    const frame = screen.getByTestId('frame'), top = screen.getByTestId('top');
    expect(frame.className).toMatch(/\bh-dvh\b/); expect(frame.className).toContain('flex-col');
    expect(top.className).toContain('max-h-[35dvh]'); expect(top.className).toContain('overflow-y-auto'); expect(top.className).toContain('shrink-0');
    for (const id of ['banner-base_offline', 'banner-logging_fault', 'banner-host_gap', 'banner-audio_fault', 'banner-host_power', 'banner-recovering', 'mode-bar', 'audio-bar']) expect(top.contains(screen.getByTestId(id)), id).toBe(true);
    expect(top.contains(screen.getByTestId('live'))).toBe(false); expect(top.contains(screen.getByTestId('tray'))).toBe(false);
    expect(screen.getByRole('button', { name: 'End shift' }).closest('header')).toBe(top); // End shift is in the header, above the banners
  });
  it('the readings area takes the rest of the window and scrolls inside itself', () => {
    full(); render(<Shell {...deps()} />); const main = screen.getByRole('main');
    for (const c of ['flex-1', 'min-h-0', 'overflow-y-auto']) expect(main.className).toContain(c);
    expect(main.contains(screen.getByTestId('co-chart'))).toBe(true); expect(main.contains(screen.getByTestId('grid'))).toBe(true);
  });
  it('the tray is at most 40% of the window high, scrolls inside itself, and holds danger cards first', () => {
    load({ open_alerts: [alertBody(1, 'heat', 'WARNING', 1), alertBody(2, 'man_down', 'DANGER', 2)] }, [node(1, 'WARNING'), node(2, 'DANGER')]); render(<LiveScreen />);
    const tray = screen.getByTestId('tray'); expect(tray.className).toContain('max-h-[40dvh]'); expect(tray.className).toContain('overflow-y-auto');
    const cards = tray.querySelectorAll('[data-kind="responder"]'); expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('DANGER'); expect(cards[1].textContent).toContain('WARNING'); // the danger card is first although the warning was raised first
    expect(screen.getByRole('main').contains(tray)).toBe(false);
  });
  it('an empty tray takes no room', () => {
    load(); render(<LiveScreen />); const t = screen.getByTestId('tray'); expect(t.className).not.toMatch(/\bp-4\b/); expect(t.className).not.toContain('border-t-2');
  });
  it('a minimized alert keeps a chip outside the scrolling readings area, and the chip restores the card', () => {
    load({ open_alerts: [alertBody(2, 'man_down', 'DANGER', 2)] }, [node(1), node(2, 'DANGER')]); render(<LiveScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    const chip = screen.getByRole('navigation', { name: 'Minimized alerts' }); expect(chip.querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByRole('main').contains(chip)).toBe(false);
    fireEvent.click(chip.querySelector('button')!); expect(screen.getByTestId('tray').querySelectorAll('[data-kind="responder"]')).toHaveLength(1);
  });
  it('the red NO LIVE DATA screen replaces the header and still covers the whole window', () => {
    full(); wdStore.setState({ noData: true, sirenOn: true }); render(<Shell {...deps()} />);
    expect(screen.queryByTestId('top')).toBeNull(); expect(screen.getByText(/NO LIVE DATA/).closest('[role="alert"]')!.className).toContain('fixed');
  });
  it('every button on the full screen is at least 44 px high (min-h-11), with every banner, a card, a chip and the sound bar', () => {
    full(); act(() => { liveStore.setState({ ...liveStore.getState(), alerts: { 2: alertBody(2, 'man_down', 'DANGER', 2) as never } }); });
    const { container } = render(<Shell {...deps()} gate={mkGate()} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Minimize' })[0]);
    const bad = [...container.querySelectorAll('button')].filter((b) => !b.className.includes('min-h-11')).map((b) => b.textContent);
    expect(container.querySelectorAll('button').length).toBeGreaterThan(8); expect(bad).toEqual([]);
  });
});
