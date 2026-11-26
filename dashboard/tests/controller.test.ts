import { describe, it, expect } from 'vitest';
import { createController, TOKEN_KEY } from '../src/store/controller.ts';
import { initialState, type LiveState } from '../src/store/reducer.ts';
import { FakeWs, FakeTimers, snapshot, tick } from './helpers.ts';

function rig(token: string | null) {
  const mem = new Map<string, string>(token ? [[TOKEN_KEY, token]] : []);
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  let st: LiveState = initialState('CONNECTING');
  const store = { getState: () => st, setState: (n: LiveState) => { st = n; } };
  const sockets: FakeWs[] = [];
  const timers = new FakeTimers();
  const c = createController({ store, storage, url: 'ws://x/ws', socketOptions: { timers, create: () => { const w = new FakeWs(); sockets.push(w); return w; } } });
  return { c, mem, sockets, timers, get: () => st };
}

describe('controller (design 3.8, P21 done-when)', () => {
  it('with no stored token it shows Login and opens no socket', () => {
    const r = rig(null); r.c.start();
    expect(r.get().conn).toBe('LOGIN');
    expect(r.sockets).toHaveLength(0);
  });
  it('login stores the token in sessionStorage and connects', () => {
    const r = rig(null); r.c.login('abc');
    expect(r.mem.get(TOKEN_KEY)).toBe('abc');
    expect(r.get().conn).toBe('CONNECTING');
    r.sockets[0].open();
    expect(JSON.parse(r.sockets[0].sent[0]).token).toBe('abc');
  });
  it('the page is LIVE only after the snapshot arrives', () => {
    const r = rig('abc'); r.c.start(); r.sockets[0].open();
    expect(r.get().conn).toBe('CONNECTING');
    r.sockets[0].push(snapshot());
    expect(r.get().conn).toBe('LIVE');
  });
  it('close 4401 clears sessionStorage, drops the data and shows Login', () => {
    const r = rig('abc'); r.c.start(); r.sockets[0].open(); r.sockets[0].push(snapshot());
    r.sockets[0].drop(4401);
    expect(r.mem.has(TOKEN_KEY)).toBe(false);
    expect(r.get().conn).toBe('LOGIN');
    expect(Object.keys(r.get().nodes)).toHaveLength(0);
  });
  it('close 4408 reconnects and the new snapshot comes first and replaces the state', () => {
    const r = rig('abc'); r.c.start(); r.sockets[0].open(); r.sockets[0].push(snapshot());
    r.sockets[0].drop(4408);
    expect(r.get().conn).toBe('CONNECTING');
    expect(r.get().nodes[1].alias).toBe('FF-01'); // stale data stays on screen meanwhile
    r.timers.tick(1000); r.sockets[1].open();
    r.sockets[1].push(snapshot({ epoch: 'e2' }));
    expect(r.get().conn).toBe('LIVE');
    expect(r.get().epoch).toBe('e2');
  });
  it('a gap in srv_seq triggers a reconnect and a fresh snapshot', () => {
    const r = rig('abc'); r.c.start(); r.sockets[0].open(); r.sockets[0].push(snapshot());
    r.sockets[0].push(tick(1)); r.sockets[0].push(tick(3)); // 2 is missing
    expect(r.sockets[0].closed).toBe(1000);
    r.timers.tick(0);
    expect(r.sockets).toHaveLength(2);
    r.sockets[1].open(); r.sockets[1].push(snapshot({ epoch: 'e1' }));
    expect(r.get().lastSeq).toBe(0);
  });
  it('logout removes the token and shows Login', () => {
    const r = rig('abc'); r.c.start(); r.c.logout();
    expect(r.mem.has(TOKEN_KEY)).toBe(false);
    expect(r.get().conn).toBe('LOGIN');
  });
});
