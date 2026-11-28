// @vitest-environment jsdom
// Requirements: REQ-API-007, REQ-UI-008
// S7-5b (ADR 0062): the Pause and Resume button and the "Replay paused" words, in the Shell and alone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import Shell from '../src/components/Shell.tsx';
import ReplayBar from '../src/components/ReplayBar.tsx';
import { liveStore } from '../src/store/live.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import { wdStore } from '../src/store/watchdog.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const deps = () => ({ controller: { start: vi.fn(), login: vi.fn() }, bridge: { init: vi.fn() } });
const RP = { speed: 16, paused: false, finished: false };
const live = (over: Record<string, unknown> = {}) => liveStore.setState(apply(initialState('CONNECTING'), snapshot(over) as unknown as ServerMessage).state);
const replay = (rp: Record<string, unknown> | null = RP, extra: Record<string, unknown> = {}) => live({ session: { session_id: 4, started_ts: 1000, mode: 'REPLAY', session_label: null }, replay: rp, ...extra });
const answer = (status: number, body: unknown = {}) => vi.fn(async () => ({ status, json: async () => body }) as unknown as Response);
const api = (f: ReturnType<typeof answer>) => ({ fetchFn: f as unknown as typeof fetch, getToken: () => 't' });
beforeEach(() => { window.sessionStorage.clear(); wdStore.setState({ noData: false, sirenOn: false }); });
afterEach(cleanup);

describe('the Pause button', () => {
  it('is in the Shell for REPLAY, under the mode bar, and is not there for LIVE or SIMULATOR', () => {
    replay(); const r = render(<Shell {...deps()} />);
    expect(screen.getByTestId('mode-bar').textContent).toContain('REPLAY'); expect(screen.getByRole('button', { name: 'Pause replay' })).not.toBeNull();
    cleanup(); live(); r.unmount(); render(<Shell {...deps()} />); expect(screen.queryByTestId('replay-bar')).toBeNull();
    cleanup(); live({ session: { session_id: 4, started_ts: 1, mode: 'SIMULATOR', session_label: null } }); render(<Shell {...deps()} />); expect(screen.queryByTestId('replay-bar')).toBeNull();
  });
  it('is not shown when the host sent no replay block, and the mode bar stays', () => {
    replay(null); render(<Shell {...deps()} />);
    expect(screen.queryByTestId('replay-bar')).toBeNull(); expect(screen.queryByTestId('mode-bar')).not.toBeNull();
  });
  it('is a dark neutral bar with no level colour and no close button, and the button is at least 44 px high', () => {
    replay(); render(<ReplayBar />);
    const bar = screen.getByTestId('replay-bar'); expect(bar.className).toContain('bg-slate-800'); expect(bar.className).not.toMatch(/level-/);
    expect(bar.querySelectorAll('button')).toHaveLength(1); expect(screen.getByRole('button', { name: 'Pause replay' }).className).toContain('min-h-11');
  });
  it('running: says "Replay running, ×16"; a press posts paused:true and the bar then says "Replay paused, ×16" with the button turned to Resume', async () => {
    replay(); const f = answer(200, { paused: true, finished: false }); render(<ReplayBar api={api(f)} />);
    expect(screen.getByTestId('replay-state').textContent).toBe('Replay running, ×16');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause replay' })); });
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ paused: true });
    await waitFor(() => expect(screen.getByTestId('replay-state').textContent).toContain('Replay paused, ×16'));
    expect(screen.getByRole('button', { name: 'Resume replay' })).not.toBeNull();
  });
  it('paused: a press posts paused:false and the bar goes back to running', async () => {
    replay({ ...RP, paused: true }); const f = answer(200, { paused: false, finished: false }); render(<ReplayBar api={api(f)} />);
    expect(screen.getByTestId('replay-state').textContent).toContain('Replay paused, ×16');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resume replay' })); });
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ paused: false });
    await waitFor(() => expect(screen.getByTestId('replay-state').textContent).toBe('Replay running, ×16'));
  });
  it('follows the host: a system message from another tab flips the words and the button', async () => {
    replay(); render(<ReplayBar />);
    await act(async () => { liveStore.setState({ replay: { ...RP, paused: true } }); });
    expect(screen.getByTestId('replay-state').textContent).toContain('Replay paused'); expect(screen.getByRole('button', { name: 'Resume replay' })).not.toBeNull();
  });
  it('is disabled once the replay has finished, and says so', () => {
    replay({ ...RP, finished: true }); const f = answer(200); render(<ReplayBar api={api(f)} />);
    const b = screen.getByRole('button', { name: 'Pause replay' }) as HTMLButtonElement; expect(b.disabled).toBe(true); expect(screen.getByTestId('replay-state').textContent).toBe('Replay finished');
    fireEvent.click(b); expect(f).not.toHaveBeenCalled();
  });
  it('is disabled while the host is recovering', () => {
    replay(RP, { recovering: true }); render(<ReplayBar />); expect((screen.getByRole('button', { name: 'Pause replay' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('is disabled while a press is on its way, so a double click sends one request', async () => {
    replay(); let release: (r: Response) => void = () => undefined;
    const f = vi.fn(() => new Promise<Response>((res) => { release = res; })); render(<ReplayBar api={api(f as unknown as ReturnType<typeof answer>)} />);
    const b = screen.getByRole('button', { name: 'Pause replay' }) as HTMLButtonElement;
    await act(async () => { fireEvent.click(b); }); expect(b.disabled).toBe(true); fireEvent.click(b); expect(f).toHaveBeenCalledTimes(1);
    await act(async () => { release({ status: 200, json: async () => ({ paused: true, finished: false }) } as unknown as Response); }); await waitFor(() => expect(b.disabled).toBe(false));
  });
  it('a refusal or a failure shows one sentence, keeps the words, and the button works again', async () => {
    for (const [f, text] of [[answer(409, { error_code: 'STATE_CONFLICT' }), 'The replay has finished.'], [answer(409, { error_code: 'RECOVERING' }), 'The replay has not started yet. Try again in a moment.'],
      [answer(503), 'The host did not answer. Try again.'], [answer(401), 'Not signed in. Log in again.']] as const) {
      replay(); const r = render(<ReplayBar api={api(f)} />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause replay' })); });
      await waitFor(() => expect(screen.getByTestId('replay-error').textContent).toBe(text));
      expect(screen.getByTestId('replay-state').textContent).toBe('Replay running, ×16'); expect((screen.getByRole('button', { name: 'Pause replay' }) as HTMLButtonElement).disabled).toBe(false);
      r.unmount();
    }
  });
  it('the next press clears the old error', async () => {
    replay(); const f = answer(503); render(<ReplayBar api={api(f)} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause replay' })); }); await waitFor(() => expect(screen.queryByTestId('replay-error')).not.toBeNull());
    f.mockImplementation(async () => ({ status: 200, json: async () => ({ paused: true, finished: false }) }) as unknown as Response);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause replay' })); }); await waitFor(() => expect(screen.queryByTestId('replay-error')).toBeNull());
  });
  it('does not cover the red NO LIVE DATA screen with a second bar', () => {
    replay(); wdStore.setState({ noData: true, sirenOn: false }); render(<Shell {...deps()} />); expect(screen.queryByTestId('replay-bar')).toBeNull();
  });
});
