// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import Shell from '../src/components/Shell.tsx';
import { liveStore } from '../src/store/live.ts';
import { initialState, apply } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { TOKEN_KEY } from '../src/store/controller.ts';
import { snapshot } from './helpers.ts';

const deps = () => ({ controller: { start: vi.fn(), login: vi.fn() }, bridge: { init: vi.fn() } });
const reply = (status: number, body: unknown) => (async () => ({ status, json: async () => body })) as unknown as typeof fetch;
const NLD = /NO LIVE DATA: responders are NOT being monitored/;
const adminToken = () => fireEvent.click(screen.getByRole('button', { name: 'Use the admin token instead' })); // P28-5: the PIN form is the default

beforeEach(() => { window.sessionStorage.clear(); liveStore.setState(initialState('LOGIN')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Shell (P21 done-when)', () => {
  it('shows the Login page with the name and PIN form first, and the one token field behind the admin link', () => {
    render(<Shell {...deps()} />);
    expect(screen.queryByLabelText('Name')).not.toBeNull();
    expect(screen.queryByLabelText('PIN')).not.toBeNull();
    expect(screen.queryByLabelText('Token')).toBeNull();
    adminToken();
    expect(screen.queryByLabelText('Token')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeNull();
    expect(screen.queryByText(NLD)).toBeNull();
  });
  it('with the server off it shows NO LIVE DATA once dashboard_stale_s (4 s) has passed', () => {
    vi.useFakeTimers();
    liveStore.setState(initialState('CONNECTING'));
    render(<Shell {...deps()} />);
    expect(screen.queryByText(NLD)).toBeNull();
    act(() => { vi.advanceTimersByTime(3999); });
    expect(screen.queryByText(NLD)).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText(NLD)).not.toBeNull();
    expect(screen.queryByRole('alert')).not.toBeNull();
  });
  it('NO LIVE DATA clears on a snapshot and the 4 s count starts again after a drop', () => {
    vi.useFakeTimers();
    liveStore.setState(initialState('CONNECTING'));
    render(<Shell {...deps()} />);
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByText(NLD)).not.toBeNull();
    act(() => { liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state); });
    expect(screen.queryByText(NLD)).toBeNull();
    expect(screen.queryByTestId('live')).not.toBeNull();
    act(() => { liveStore.setState({ ...liveStore.getState(), conn: 'CONNECTING' }); });
    act(() => { vi.advanceTimersByTime(3999); });
    expect(screen.queryByText(NLD)).toBeNull();
  });
  it('a stored token on reload starts the socket and passes INIT_AUTH to the worker', () => {
    window.sessionStorage.setItem(TOKEN_KEY, 'tok');
    const d = deps();
    render(<Shell {...d} />);
    expect(d.controller.start).toHaveBeenCalled();
    expect(d.bridge.init).toHaveBeenCalledWith('tok');
  });
  it('a good login starts the socket and passes INIT_AUTH once', async () => {
    const d = deps();
    render(<Shell {...d} fetchFn={reply(200, { operator_id: 1, display_name: 'Ana', session_id: 4 })} />);
    adminToken();
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(d.controller.login).toHaveBeenCalledWith('abc'));
    expect(d.bridge.init).toHaveBeenCalledWith('abc');
  });
  it('a rejected token shows "Token not accepted" with the delay and starts nothing', async () => {
    const d = deps();
    render(<Shell {...d} fetchFn={reply(401, { error_code: 'UNAUTHENTICATED', detail: 'x', retry_after_s: 2 })} />);
    adminToken();
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(/Token not accepted\. Wait 2 s/);
    expect(d.controller.login).not.toHaveBeenCalled();
    expect(d.bridge.init).not.toHaveBeenCalled();
  });
});
