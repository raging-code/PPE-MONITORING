// @vitest-environment jsdom
// Requirements: REQ-UI-001, REQ-UI-009
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import Shell from '../src/components/Shell.tsx';
import { liveStore } from '../src/store/live.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import { wdStore, createWatchdogClient } from '../src/store/watchdog.ts';
import { audioStore, bindSiren, createSiren, webAudioPort, type AudioCtxLike } from '../src/audio/siren.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const NLD = /NO LIVE DATA: responders are NOT being monitored/;
const deps = () => ({ controller: { start: vi.fn(), login: vi.fn() }, bridge: { init: vi.fn() } });
const live = () => liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state);
beforeEach(() => { window.sessionStorage.clear(); wdStore.setState({ noData: false, sirenOn: false }); audioStore.setState({ unlocked: false, ctx: null }); });
afterEach(cleanup);

describe('NO LIVE DATA screen from the worker verdict', () => {
  it('goes over the live screen when the page still looks connected, and clears with the verdict', () => {
    live(); render(<Shell {...deps()} />);
    expect(screen.queryByText(NLD)).toBeNull();
    act(() => wdStore.setState({ noData: true, sirenOn: true }));
    expect(screen.queryByText(NLD)).not.toBeNull(); expect(screen.queryByTestId('live')).not.toBeNull();
    act(() => wdStore.setState({ noData: false, sirenOn: false }));
    expect(screen.queryByText(NLD)).toBeNull();
  });
  it('shows Silence 60 s while the siren sounds, then the silenced line in its place', () => {
    live(); const silence = vi.fn(); render(<Shell {...deps()} silence={silence} />);
    act(() => wdStore.setState({ noData: true, sirenOn: true }));
    const b = screen.getByRole('button', { name: 'Silence 60 s' }); expect(b.className).toContain('min-h-11');
    fireEvent.click(b); expect(silence).toHaveBeenCalledTimes(1);
    act(() => wdStore.setState({ noData: true, sirenOn: false }));
    expect(screen.queryByRole('button', { name: 'Silence 60 s' })).toBeNull();
    expect(screen.queryByText(/Siren silenced for 60 s/)).not.toBeNull();
  });
  it('says the browser siren is off until Start monitoring unlocks audio', () => {
    live(); render(<Shell {...deps()} />);
    act(() => wdStore.setState({ noData: true, sirenOn: true }));
    expect(screen.queryByText('Browser siren off: click Start monitoring')).not.toBeNull();
    act(() => audioStore.setState({ unlocked: true }));
    expect(screen.queryByText('Browser siren off: click Start monitoring')).toBeNull();
  });
  it('never covers the Login page', () => {
    liveStore.setState(initialState('LOGIN')); wdStore.setState({ noData: true, sirenOn: true });
    render(<Shell {...deps()} />);
    expect(screen.queryByText(NLD)).toBeNull(); expect(screen.queryByLabelText('PIN')).not.toBeNull();
  });
});

describe('Watchdog client', () => {
  const api = (f: unknown) => ({ fetchFn: f as typeof fetch, getToken: () => 'tok' });
  const body = { started_ts: 1000, ended_ts: 10000, duration_s: 9 };
  it('WD_STATE goes to the store', () => {
    const c = createWatchdogClient({ api: api(vi.fn()) });
    c.handle({ type: 'WD_STATE', noData: true, sirenOn: false });
    expect(wdStore.getState()).toEqual({ noData: true, sirenOn: false });
  });
  it('OUTAGE posts /api/dashboard-outage with the token, retries while the host is down, and stops on ok', async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError('down')).mockResolvedValueOnce({ status: 503, json: async () => ({}) }).mockResolvedValue({ status: 200, json: async () => ({ logged: true }) });
    const waits: number[] = [];
    await createWatchdogClient({ api: api(f), wait: async (ms) => { waits.push(ms); } }).handle({ type: 'OUTAGE', ...body });
    expect(f).toHaveBeenCalledTimes(3); expect(waits).toEqual([1000, 1000]);
    const [url, init] = f.mock.calls[2] as [string, RequestInit];
    expect(url).toBe('/api/dashboard-outage'); expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok'); expect(JSON.parse(String(init.body))).toEqual(body);
  });
  it('a 401 or 422 is not retried', async () => {
    for (const status of [401, 422]) {
      const f = vi.fn().mockResolvedValue({ status, json: async () => ({ detail: 'x' }) });
      await createWatchdogClient({ api: api(f), wait: async () => {} }).handle({ type: 'OUTAGE', ...body });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });
  it('ignores a message it does not know', () => {
    const f = vi.fn(); createWatchdogClient({ api: api(f) }).handle({ type: 'INIT_ACK' }); createWatchdogClient({ api: api(f) }).handle(null);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('Browser siren', () => {
  it('plays only while the worker says so AND audio is unlocked, and stops when either ends', () => {
    const calls: string[] = []; const siren = createSiren({ start: () => calls.push('start'), stop: () => calls.push('stop') });
    bindSiren(siren, wdStore, audioStore);
    act(() => wdStore.setState({ noData: true, sirenOn: true })); expect(calls).toEqual([]);
    act(() => audioStore.setState({ unlocked: true })); expect(calls).toEqual(['start']);
    act(() => wdStore.setState({ noData: true, sirenOn: false })); expect(calls).toEqual(['start', 'stop']);
    act(() => wdStore.setState({ noData: true, sirenOn: true })); expect(calls).toEqual(['start', 'stop', 'start']);
    act(() => wdStore.setState({ noData: false, sirenOn: false })); expect(calls.at(-1)).toBe('stop');
  });
  it('the Web Audio port is one looping buffer on the audio clock, started once and stopped on request', () => {
    const src = { buffer: null as unknown, loop: false, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const samples: Float32Array[] = [];
    const ctx: AudioCtxLike = { sampleRate: 8000, destination: 'dest', createBuffer: (_c, n) => { const a = new Float32Array(n); samples.push(a); return { getChannelData: () => a }; }, createBufferSource: () => src };
    const p = webAudioPort(() => ctx); p.start(); p.start();
    expect(src.loop).toBe(true); expect(src.start).toHaveBeenCalledTimes(1); expect(src.connect).toHaveBeenCalledWith('dest');
    expect(samples).toHaveLength(1); expect(Math.max(...samples[0])).toBeGreaterThan(0.5);
    p.stop(); expect(src.stop).toHaveBeenCalledTimes(1);
    webAudioPort(() => null).start(); // no context yet (before Start monitoring): nothing happens
  });
});
