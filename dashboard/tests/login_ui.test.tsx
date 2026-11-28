// @vitest-environment jsdom
// Requirements: REQ-SEC-003
// P28-5 (ADR 0056): the name and PIN login screen, the remember box, the admin token link, and Log out.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import Shell from '../src/components/Shell.tsx';
import { liveStore } from '../src/store/live.ts';
import { initialState, apply } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { TOKEN_KEY } from '../src/store/controller.ts';
import { snapshot } from './helpers.ts';

const deps = () => ({ controller: { start: vi.fn(), login: vi.fn(), logout: vi.fn() }, bridge: { init: vi.fn() } });
const reply = (status: number, body: unknown) => vi.fn(async () => ({ status, json: async () => body })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const GOOD = { operator_id: 2, display_name: 'Ana', session_id: 4, session_token: 'sess-abc', expires_ts: 99 };
const fill = (name: string, pin: string) => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('PIN'), { target: { value: pin } });
};
const signIn = () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
const signInBtn = () => screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;

beforeEach(() => { window.sessionStorage.clear(); window.localStorage.clear(); liveStore.setState(initialState('LOGIN')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Login page, name and PIN', () => {
  it('Sign in stays off until there is a name and a PIN of 6 to 12 digits', () => {
    render(<Shell {...deps()} />);
    expect(signInBtn().disabled).toBe(true);
    fill('Ana', '12345'); expect(signInBtn().disabled).toBe(true);
    fill('Ana', '12345a'); expect(signInBtn().disabled).toBe(true);
    fill('Ana', '1234567890123'); expect(signInBtn().disabled).toBe(true);
    fill('', '123456'); expect(signInBtn().disabled).toBe(true);
    fill('Ana', '123456'); expect(signInBtn().disabled).toBe(false);
    fill('Ana', '123456789012'); expect(signInBtn().disabled).toBe(false);
  });
  it('the PIN field hides what is typed, and Remember me is off by default', () => {
    render(<Shell {...deps()} />);
    expect((screen.getByLabelText('PIN') as HTMLInputElement).type).toBe('password');
    expect((screen.getByLabelText(/Remember me/) as HTMLInputElement).checked).toBe(false);
  });
  it('a good login sends the PIN form, starts the socket with the session token and passes INIT_AUTH once', async () => {
    const d = deps(), f = reply(200, GOOD);
    render(<Shell {...d} fetchFn={f} />);
    fill(' Ana ', '123456'); signIn();
    await vi.waitFor(() => expect(d.controller.login).toHaveBeenCalledWith('sess-abc', false));
    expect(d.bridge.init).toHaveBeenCalledWith('sess-abc');
    expect(JSON.parse(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string)).toEqual({ display_name: 'Ana', pin: '123456', remember: false });
  });
  it('with Remember me ticked the login says so to the host and to the controller', async () => {
    const d = deps(), f = reply(200, GOOD);
    render(<Shell {...d} fetchFn={f} />);
    fill('Ana', '123456'); fireEvent.click(screen.getByLabelText(/Remember me/)); signIn();
    await vi.waitFor(() => expect(d.controller.login).toHaveBeenCalledWith('sess-abc', true));
    expect(JSON.parse(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string).remember).toBe(true);
  });
  it('a wrong PIN shows the delay, starts nothing, and empties the PIN field', async () => {
    const d = deps();
    render(<Shell {...d} fetchFn={reply(401, { error_code: 'UNAUTHENTICATED', detail: 'invalid name or PIN', retry_after_s: 2 })} />);
    fill('Ana', '000000'); signIn();
    await screen.findByText(/Name or PIN not accepted\. Wait 2 s/);
    expect((screen.getByLabelText('PIN') as HTMLInputElement).value).toBe('');
    expect(d.controller.login).not.toHaveBeenCalled(); expect(d.bridge.init).not.toHaveBeenCalled();
  });
  it('a locked operator is told the minutes and pointed to the admin token', async () => {
    render(<Shell {...deps()} fetchFn={reply(401, { error_code: 'UNAUTHENTICATED', detail: 'x', retry_after_s: 840 })} />);
    fill('Ana', '000000'); signIn();
    await screen.findByText(/Too many wrong PINs\. Try again in 14 min, or sign in with the admin token\./);
  });
  it('an origin refusal and a host that is down have their own words', async () => {
    const { unmount } = render(<Shell {...deps()} fetchFn={reply(403, {})} />);
    fill('Ana', '123456'); signIn(); await screen.findByText(/refused this page address/);
    unmount(); cleanup();
    render(<Shell {...deps()} fetchFn={(async () => { throw new TypeError('x'); }) as unknown as typeof fetch} />);
    fill('Ana', '123456'); signIn(); await screen.findByText('Host not reachable.');
  });
  it('the admin token link switches to the token form and back, and clears the message', async () => {
    render(<Shell {...deps()} fetchFn={reply(401, { error_code: 'UNAUTHENTICATED', detail: 'x', retry_after_s: null })} />);
    fill('Ana', '123456'); signIn(); await screen.findByText('Name or PIN not accepted.');
    fireEvent.click(screen.getByRole('button', { name: 'Use the admin token instead' }));
    expect(screen.queryByText('Name or PIN not accepted.')).toBeNull();
    expect(screen.queryByLabelText('Token')).not.toBeNull(); expect(screen.queryByLabelText('PIN')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with name and PIN' }));
    expect(screen.queryByLabelText('PIN')).not.toBeNull();
  });
});

describe('Log out', () => {
  const live = () => liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state);
  // The live screen makes calls of its own (event log, banners): answer them quietly and keep every call for the asserts.
  const host = (down = false) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (down && url === '/api/logout') throw new TypeError('down');
      return { status: 200, json: async () => (url === '/api/logout' ? { logged_out: true } : { events: [], last_seq: 0 }) };
    }) as unknown as typeof fetch;
    return { calls, fetchFn, logout: () => calls.filter((c) => c.url === '/api/logout') };
  };
  it('shows no Log out button when the controller has no logout', () => {
    live(); render(<Shell controller={{ start: vi.fn(), login: vi.fn() }} bridge={{ init: vi.fn() }} />);
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
  });
  it('asks once, and Cancel changes nothing', () => {
    live(); const d = deps(), h = host();
    render(<Shell {...d} fetchFn={h.fetchFn} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(screen.queryByText('This screen stops monitoring.')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeNull();
    expect(d.controller.logout).not.toHaveBeenCalled(); expect(h.logout()).toHaveLength(0);
  });
  it('confirming ends the session on the host with the stored token, then clears this page', async () => {
    live(); window.sessionStorage.setItem(TOKEN_KEY, 'sess-abc');
    const d = deps(), h = host();
    render(<Shell {...d} fetchFn={h.fetchFn} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, log out' }));
    await vi.waitFor(() => expect(d.controller.logout).toHaveBeenCalledTimes(1));
    expect(h.logout()).toHaveLength(1);
    expect(h.logout()[0].init.method).toBe('POST');
    expect((h.logout()[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sess-abc');
  });
  it('logs out on this page even when the host is down', async () => {
    live(); window.localStorage.setItem(TOKEN_KEY, 'remembered');
    const d = deps(), h = host(true);
    render(<Shell {...d} fetchFn={h.fetchFn} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, log out' }));
    await vi.waitFor(() => expect(d.controller.logout).toHaveBeenCalledTimes(1));
    expect(h.logout()).toHaveLength(1); // it tried
  });
});
