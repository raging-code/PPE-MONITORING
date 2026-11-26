// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import Shell from '../src/components/Shell.tsx';
import { liveStore } from '../src/store/live.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import { wdStore } from '../src/store/watchdog.ts';
import { audioStore } from '../src/audio/siren.ts';
import { createGate, gateStore } from '../src/audio/gate.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const mkGate = () => {
  const ctx = { state: 'suspended', sampleRate: 8000, destination: 'd', resume: vi.fn(async function (this: { state: string }) { ctx.state = 'running'; }),
    createBuffer: (_c: number, n: number) => { const a = new Float32Array(n); return { getChannelData: () => a }; },
    createBufferSource: () => ({ buffer: null, loop: false, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }) };
  const f = vi.fn(async () => ({ status: 200, json: async () => ({ monitoring_active: true }) }) as unknown as Response);
  return { gate: createGate({ api: { fetchFn: f as unknown as typeof fetch, getToken: () => 't' }, makeCtx: () => ctx }), f };
};
const deps = () => ({ controller: { start: vi.fn(), login: vi.fn() }, bridge: { init: vi.fn() } });
const live = () => liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state);
beforeEach(() => { window.sessionStorage.clear(); wdStore.setState({ noData: false, sirenOn: false }); audioStore.setState({ unlocked: false, ctx: null }); gateStore.setState(gateStore.getInitialState()); });
afterEach(cleanup);

describe('AudioBar in the Shell', () => {
  it('shows the siren-off line, keeps Start monitoring disabled until Test sound ran, then shows Siren ON', async () => {
    live(); const { gate, f } = mkGate(); render(<Shell {...deps()} gate={gate} />);
    expect(screen.queryByText('Browser siren off: click Start monitoring')).not.toBeNull();
    const start = screen.getByRole('button', { name: 'Start monitoring' }) as HTMLButtonElement, test = screen.getByRole('button', { name: 'Test sound' });
    expect(start.disabled).toBe(true); expect(start.className).toContain('min-h-11'); expect(test.className).toContain('min-h-11');
    await act(async () => { fireEvent.click(test); });
    expect(start.disabled).toBe(false);
    await act(async () => { fireEvent.click(start); });
    await waitFor(() => expect(screen.queryByText('Siren ON')).not.toBeNull());
    expect(f).toHaveBeenCalledTimes(1); expect(screen.queryByRole('button', { name: 'Start monitoring' })).toBeNull();
  });
  it('shows Screen may sleep after a failed wake lock, and the hidden-tab notice with Dismiss', async () => {
    live(); const { gate } = mkGate(); render(<Shell {...deps()} gate={gate} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Test sound' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start monitoring' })); });
    await waitFor(() => expect(screen.queryByText('Screen may sleep')).not.toBeNull());
    act(() => gateStore.setState({ hiddenReturn: true }));
    expect(screen.queryByText(/Dashboard was hidden: alarms may have been delayed/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Dashboard was hidden/)).toBeNull();
  });
  it('shows SIREN OFF: click to enable when audio is suspended after Start monitoring', async () => {
    live(); const { gate } = mkGate(); render(<Shell {...deps()} gate={gate} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Test sound' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start monitoring' })); });
    act(() => gateStore.setState({ running: false }));
    expect(screen.getByRole('button', { name: 'SIREN OFF: click to enable' })).not.toBeNull();
  });
  it('the red screen carries the same controls, so a reload with the host down can still unlock the siren', () => {
    liveStore.setState(initialState('CONNECTING')); wdStore.setState({ noData: true, sirenOn: true });
    const { gate } = mkGate(); render(<Shell {...deps()} gate={gate} />);
    expect(screen.queryByText(/NO LIVE DATA: responders are NOT being monitored/)).not.toBeNull();
    expect(screen.getAllByText('Browser siren off: click Start monitoring')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Test sound' })).not.toBeNull();
  });
  it('over the live screen only one set of controls shows while NO LIVE DATA covers it; Login shows none', () => {
    live(); const { gate } = mkGate(); render(<Shell {...deps()} gate={gate} />);
    act(() => wdStore.setState({ noData: true, sirenOn: true }));
    expect(screen.getAllByRole('button', { name: 'Test sound' })).toHaveLength(1);
    cleanup(); liveStore.setState(initialState('LOGIN')); render(<Shell {...deps()} gate={gate} />);
    expect(screen.queryByTestId('audio-bar')).toBeNull();
  });
});
