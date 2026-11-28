// @vitest-environment jsdom
// Requirements: REQ-API-007, REQ-UI-008
// S7-7b (ADR 0065): the speed selector of the replay bar, in the Shell and alone.
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
const speedBtn = (n: 1 | 4 | 16) => screen.getByRole('button', { name: `Speed ×${n}` }) as HTMLButtonElement;
const pressed = (n: 1 | 4 | 16) => speedBtn(n).getAttribute('aria-pressed');
const sent = (f: ReturnType<typeof answer>, i = 0) => JSON.parse((f.mock.calls[i] as unknown as [string, RequestInit])[1].body as string);
beforeEach(() => { window.sessionStorage.clear(); wdStore.setState({ noData: false, sirenOn: false }); });
afterEach(cleanup);

describe('the speed selector', () => {
  it('is in the Shell for REPLAY with three buttons in a labelled group, and not for LIVE or SIMULATOR', () => {
    replay(); const r = render(<Shell {...deps()} />);
    const g = screen.getByRole('group', { name: 'Replay speed' }); expect(g.querySelectorAll('button')).toHaveLength(3);
    expect(['×1', '×4', '×16'].map((t) => speedBtn(Number(t.slice(1)) as 1 | 4 | 16).textContent)).toEqual(['×1', '×4', '×16']);
    cleanup(); live(); r.unmount(); render(<Shell {...deps()} />); expect(screen.queryByTestId('replay-speed')).toBeNull();
    cleanup(); live({ session: { session_id: 4, started_ts: 1, mode: 'SIMULATOR', session_label: null } }); render(<Shell {...deps()} />); expect(screen.queryByTestId('replay-speed')).toBeNull();
  });
  it('is not shown when the host sent no replay block', () => {
    replay(null); render(<Shell {...deps()} />); expect(screen.queryByTestId('replay-speed')).toBeNull();
  });
  it('marks the host\'s speed as pressed and the others not, whatever the speed', () => {
    for (const s of [1, 4, 16] as const) {
      replay({ ...RP, speed: s }); const r = render(<ReplayBar />);
      expect([1, 4, 16].map((n) => pressed(n as 1 | 4 | 16))).toEqual([1, 4, 16].map((n) => (n === s ? 'true' : 'false'))); r.unmount();
    }
  });
  it('marks none as pressed for a speed it does not offer', () => {
    replay({ ...RP, speed: 2 }); render(<ReplayBar />); expect([1, 4, 16].map((n) => pressed(n as 1 | 4 | 16))).toEqual(['false', 'false', 'false']);
  });
  it('every button is at least 44 px high, and the group sits in the same dark bar as Pause', () => {
    replay(); render(<ReplayBar />);
    for (const n of [1, 4, 16] as const) expect(speedBtn(n).className).toContain('min-h-11');
    expect(screen.getByTestId('replay-bar').contains(screen.getByTestId('replay-speed'))).toBe(true);
  });
  it('a press posts {speed} and the words, the pressed button and the store follow the host\'s answer', async () => {
    replay(); const f = answer(200, { speed: 4, paused: false, finished: false }); render(<ReplayBar api={api(f)} />);
    await act(async () => { fireEvent.click(speedBtn(4)); });
    expect(f).toHaveBeenCalledTimes(1); expect((f.mock.calls[0] as unknown as [string])[0]).toBe('/api/replay/speed'); expect(sent(f)).toEqual({ speed: 4 });
    await waitFor(() => expect(screen.getByTestId('replay-state').textContent).toBe('Replay running, ×4'));
    expect(pressed(4)).toBe('true'); expect(pressed(16)).toBe('false'); expect(liveStore.getState().replay).toEqual({ speed: 4, paused: false, finished: false });
  });
  it('each of the three speeds can be chosen', async () => {
    for (const [from, to] of [[16, 1], [1, 4], [4, 16]] as const) {
      replay({ ...RP, speed: from }); const f = answer(200, { speed: to, paused: false, finished: false }); const r = render(<ReplayBar api={api(f)} />);
      await act(async () => { fireEvent.click(speedBtn(to)); }); expect(sent(f)).toEqual({ speed: to });
      await waitFor(() => expect(pressed(to)).toBe('true')); r.unmount();
    }
  });
  it('the speed it already has sends nothing', async () => {
    replay(); const f = answer(200); render(<ReplayBar api={api(f)} />);
    await act(async () => { fireEvent.click(speedBtn(16)); }); expect(f).not.toHaveBeenCalled(); expect(pressed(16)).toBe('true');
  });
  it('while paused a press keeps it paused: "Replay paused, ×1", and the Resume button stays', async () => {
    replay({ ...RP, paused: true }); const f = answer(200, { speed: 1, paused: true, finished: false }); render(<ReplayBar api={api(f)} />);
    expect(screen.getByRole('button', { name: 'Resume replay' })).not.toBeNull();
    await act(async () => { fireEvent.click(speedBtn(1)); });
    await waitFor(() => expect(screen.getByTestId('replay-state').textContent).toContain('Replay paused, ×1'));
    expect(screen.getByRole('button', { name: 'Resume replay' })).not.toBeNull(); expect(pressed(1)).toBe('true');
  });
  it('follows the host: a system message from another tab moves the pressed button and the words', async () => {
    replay(); render(<ReplayBar />);
    await act(async () => { liveStore.setState({ replay: { ...RP, speed: 4 } }); });
    expect(pressed(4)).toBe('true'); expect(pressed(16)).toBe('false'); expect(screen.getByTestId('replay-state').textContent).toBe('Replay running, ×4');
  });
  it('is disabled once the replay has finished, and sends nothing', () => {
    replay({ ...RP, finished: true }); const f = answer(200); render(<ReplayBar api={api(f)} />);
    for (const n of [1, 4, 16] as const) { expect(speedBtn(n).disabled).toBe(true); fireEvent.click(speedBtn(n)); }
    expect(f).not.toHaveBeenCalled();
  });
  it('is disabled while the host is recovering', () => {
    replay(RP, { recovering: true }); render(<ReplayBar />); for (const n of [1, 4, 16] as const) expect(speedBtn(n).disabled).toBe(true);
  });
  it('one request at a time: while a speed press is on its way every control is disabled, so a double click or Pause sends nothing more', async () => {
    replay(); let release: (r: Response) => void = () => undefined;
    const f = vi.fn(() => new Promise<Response>((res) => { release = res; })); render(<ReplayBar api={api(f as unknown as ReturnType<typeof answer>)} />);
    await act(async () => { fireEvent.click(speedBtn(4)); });
    for (const n of [1, 4, 16] as const) expect(speedBtn(n).disabled).toBe(true);
    const pause = screen.getByRole('button', { name: 'Pause replay' }) as HTMLButtonElement; expect(pause.disabled).toBe(true);
    fireEvent.click(speedBtn(1)); fireEvent.click(speedBtn(4)); fireEvent.click(pause); expect(f).toHaveBeenCalledTimes(1);
    await act(async () => { release({ status: 200, json: async () => ({ speed: 4, paused: false, finished: false }) } as unknown as Response); });
    await waitFor(() => expect(speedBtn(1).disabled).toBe(false)); expect(pause.disabled).toBe(false);
  });
  it('Pause is disabled the same way while a pause press is on its way, and the speeds with it', async () => {
    replay(); let release: (r: Response) => void = () => undefined;
    const f = vi.fn(() => new Promise<Response>((res) => { release = res; })); render(<ReplayBar api={api(f as unknown as ReturnType<typeof answer>)} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause replay' })); });
    for (const n of [1, 4, 16] as const) expect(speedBtn(n).disabled).toBe(true);
    await act(async () => { release({ status: 200, json: async () => ({ paused: true, finished: false }) } as unknown as Response); });
    await waitFor(() => expect(speedBtn(4).disabled).toBe(false));
  });
  it('a refusal or a failure shows one sentence, keeps the old speed, and the buttons work again', async () => {
    for (const [f, text] of [[answer(409, { error_code: 'STATE_CONFLICT' }), 'The replay has finished.'], [answer(409, { error_code: 'RECOVERING' }), 'The replay has not started yet. Try again in a moment.'],
      [answer(503), 'The host did not answer. Try again.'], [answer(401), 'Not signed in. Log in again.'], [answer(404), 'This host cannot change the replay speed.'],
      [answer(422, { detail: 'speed must be 1, 4 or 16' }), 'Not accepted: speed must be 1, 4 or 16']] as const) {
      replay(); const r = render(<ReplayBar api={api(f)} />);
      await act(async () => { fireEvent.click(speedBtn(4)); });
      await waitFor(() => expect(screen.getByTestId('replay-error').textContent).toBe(text));
      expect(screen.getByTestId('replay-state').textContent).toBe('Replay running, ×16'); expect(pressed(16)).toBe('true'); expect(speedBtn(4).disabled).toBe(false);
      r.unmount();
    }
  });
  it('the next press clears the old error', async () => {
    replay(); const f = answer(503); render(<ReplayBar api={api(f)} />);
    await act(async () => { fireEvent.click(speedBtn(4)); }); await waitFor(() => expect(screen.queryByTestId('replay-error')).not.toBeNull());
    f.mockImplementation(async () => ({ status: 200, json: async () => ({ speed: 4, paused: false, finished: false }) }) as unknown as Response);
    await act(async () => { fireEvent.click(speedBtn(4)); }); await waitFor(() => expect(screen.queryByTestId('replay-error')).toBeNull());
  });
  it('is not drawn on the red NO LIVE DATA screen', () => {
    replay(); wdStore.setState({ noData: true, sirenOn: false }); render(<Shell {...deps()} />); expect(screen.queryByTestId('replay-speed')).toBeNull();
  });
});
