// @vitest-environment jsdom
// Requirements: REQ-SEC-003
// P28-5 (ADR 0056): the PIN form of the login call, the logout call, the one token slot with two homes, and the 401 hook.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postPinLogin, postLogout, postLogin } from '../src/api/login.ts';
import { authFetch, onAuthLost } from '../src/api/authfetch.ts';
import { createController, TOKEN_KEY } from '../src/store/controller.ts';
import { readToken, clearToken } from '../src/store/token.ts';
import { initialState, type LiveState } from '../src/store/reducer.ts';
import { FakeWs, FakeTimers, snapshot } from './helpers.ts';

const reply = (status: number, body: unknown) => vi.fn(async () => ({ status, json: async () => body })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const sentBody = (f: ReturnType<typeof vi.fn>) => JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
const GOOD = { operator_id: 2, display_name: 'Ana', session_id: 4, session_token: 'sess-abc', expires_ts: 99 };

describe('postPinLogin', () => {
  it('sends display_name, pin and remember, and no token field', async () => {
    const f = reply(200, GOOD);
    await postPinLogin('Ana', '123456', true, f);
    expect(sentBody(f as never)).toEqual({ display_name: 'Ana', pin: '123456', remember: true });
  });
  it('200 gives the operator and the session token', async () => {
    expect(await postPinLogin('Ana', '123456', false, reply(200, GOOD))).toEqual({ kind: 'ok', operatorId: 2, displayName: 'Ana', sessionId: 4, sessionToken: 'sess-abc' });
  });
  it('a 200 without a session token is an error, not a login', async () => {
    expect(await postPinLogin('Ana', '123456', false, reply(200, { operator_id: 2, display_name: 'Ana', session_id: 4 }))).toEqual({ kind: 'error', status: 200 });
  });
  it('401 carries retry_after_s, also the long wait of a locked operator', async () => {
    expect(await postPinLogin('Ana', '000000', false, reply(401, { error_code: 'UNAUTHENTICATED', detail: 'x', retry_after_s: 900 }))).toEqual({ kind: 'rejected', retryAfterS: 900 });
  });
  it('the token form still sends only the token and returns no session token', async () => {
    const f = reply(200, { operator_id: 1, display_name: 'Ana', session_id: 4 });
    const r = await postLogin('tok', f);
    expect(sentBody(f as never)).toEqual({ token: 'tok' });
    expect(r).not.toHaveProperty('sessionToken');
  });
});

describe('postLogout', () => {
  it('posts to /api/logout with the bearer token', async () => {
    const f = reply(200, { logged_out: true });
    expect(await postLogout('sess-abc', f)).toBe(true);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/logout');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sess-abc');
  });
  it('a host that is down gives false and no exception', async () => {
    expect(await postLogout('t', (async () => { throw new TypeError('down'); }) as unknown as typeof fetch)).toBe(false);
  });
});

describe('authFetch (a 401 on a logged-in call means Login)', () => {
  afterEach(() => { onAuthLost(null); vi.unstubAllGlobals(); });
  const withStatus = (status: number) => vi.stubGlobal('fetch', vi.fn(async () => ({ status })));
  it('calls the listener on 401 and still returns the response', async () => {
    const lost = vi.fn(); onAuthLost(lost); withStatus(401);
    expect((await authFetch('/api/events')).status).toBe(401);
    expect(lost).toHaveBeenCalledTimes(1);
  });
  it('does not call it on 200, 403 or 409', async () => {
    const lost = vi.fn(); onAuthLost(lost);
    for (const s of [200, 403, 409]) { withStatus(s); await authFetch('/api/events'); }
    expect(lost).not.toHaveBeenCalled();
  });
});

function rig(opts: { session?: string; local?: string; blockLocalWrite?: boolean } = {}) {
  const mk = (init?: string, blockWrite = false) => {
    const m = new Map<string, string>(init ? [[TOKEN_KEY, init]] : []);
    return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { if (blockWrite) throw new Error('full'); m.set(k, v); }, removeItem: (k: string) => void m.delete(k) } };
  };
  const ses = mk(opts.session), loc = mk(opts.local, opts.blockLocalWrite);
  let st: LiveState = initialState('CONNECTING');
  const sockets: FakeWs[] = [];
  const c = createController({ store: { getState: () => st, setState: (n) => { st = n; } }, storage: ses.s, persistent: loc.s, url: 'ws://x/ws',
    socketOptions: { timers: new FakeTimers(), create: () => { const w = new FakeWs(); sockets.push(w); return w; } } });
  return { c, ses: ses.m, loc: loc.m, sockets, get: () => st };
}

describe('controller: remember me', () => {
  it('login without remember keeps the token in sessionStorage only', () => {
    const r = rig(); r.c.login('s1', false);
    expect(r.ses.get(TOKEN_KEY)).toBe('s1'); expect(r.loc.has(TOKEN_KEY)).toBe(false);
  });
  it('login with remember keeps it in localStorage only, and the socket still sends it', () => {
    const r = rig(); r.c.login('s1', true);
    expect(r.loc.get(TOKEN_KEY)).toBe('s1'); expect(r.ses.has(TOKEN_KEY)).toBe(false);
    r.sockets[0].open();
    expect(JSON.parse(r.sockets[0].sent[0]).token).toBe('s1');
  });
  it('a remembered token starts the socket on a fresh tab (nothing in sessionStorage)', () => {
    const r = rig({ local: 's1' }); r.c.start();
    expect(r.sockets).toHaveLength(1);
  });
  it('blocked or full localStorage falls back to this tab only', () => {
    const r = rig({ blockLocalWrite: true }); r.c.login('s1', true);
    expect(r.ses.get(TOKEN_KEY)).toBe('s1');
  });
  it('a new login moves the token: remembered, then not remembered leaves nothing in localStorage', () => {
    const r = rig(); r.c.login('s1', true); r.c.login('s2', false);
    expect(r.loc.has(TOKEN_KEY)).toBe(false); expect(r.ses.get(TOKEN_KEY)).toBe('s2');
  });
  it('close 4401 clears both storages and shows Login', () => {
    const r = rig({ local: 's1' }); r.c.start(); r.sockets[0].open(); r.sockets[0].push(snapshot()); r.sockets[0].drop(4401);
    expect(r.loc.has(TOKEN_KEY)).toBe(false); expect(r.ses.has(TOKEN_KEY)).toBe(false); expect(r.get().conn).toBe('LOGIN');
  });
  it('logout clears both storages, closes the socket and shows Login', () => {
    const r = rig({ session: 'a', local: 'b' }); r.c.start(); r.sockets[0].open(); r.c.logout();
    expect(r.loc.has(TOKEN_KEY)).toBe(false); expect(r.ses.has(TOKEN_KEY)).toBe(false);
    expect(r.sockets[0].closed).toBe(1000); expect(r.get().conn).toBe('LOGIN');
  });
  it('expire (a 401 from REST) does the same as logout without any host call', () => {
    const r = rig({ local: 's1' }); r.c.start(); r.sockets[0].open(); r.sockets[0].push(snapshot()); r.c.expire();
    expect(r.loc.has(TOKEN_KEY)).toBe(false); expect(r.get().conn).toBe('LOGIN'); expect(Object.keys(r.get().nodes)).toHaveLength(0);
  });
});

describe('readToken and clearToken', () => {
  beforeEach(() => { window.sessionStorage.clear(); window.localStorage.clear(); });
  it('reads sessionStorage first, then localStorage, and null when empty', () => {
    expect(readToken()).toBeNull();
    window.localStorage.setItem(TOKEN_KEY, 'remembered'); expect(readToken()).toBe('remembered');
    window.sessionStorage.setItem(TOKEN_KEY, 'tab'); expect(readToken()).toBe('tab');
  });
  it('clearToken empties both', () => {
    window.sessionStorage.setItem(TOKEN_KEY, 'a'); window.localStorage.setItem(TOKEN_KEY, 'b');
    clearToken(); expect(readToken()).toBeNull();
  });
});
