// Requirements: REQ-API-004
import { describe, it, expect } from 'vitest';
import { LiveSocket } from '../src/net/socket.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { FakeWs, FakeTimers, snapshot, tick } from './helpers.ts';

function rig(token: string | null = 'tok', resync: (m: ServerMessage) => boolean = () => false) {
  const sockets: FakeWs[] = [];
  const timers = new FakeTimers();
  const log: string[] = [];
  const got: ServerMessage[] = [];
  const s = new LiveSocket({
    url: 'ws://x/ws', getToken: () => token, timers, reconnectMs: 1000, hbMs: 1000, now: () => 5,
    create: () => { const w = new FakeWs(); sockets.push(w); return w; },
    onMessage: (m) => { got.push(m); return resync(m); },
    onConnecting: () => log.push('connecting'), onAuthRejected: () => log.push('auth'), onForbidden: () => log.push('forbidden'),
  });
  return { s, sockets, timers, log, got };
}

describe('LiveSocket (design 3.8, close codes)', () => {
  it('sends auth as the first message and then hb every second', () => {
    const r = rig(); r.s.start(); r.sockets[0].open();
    expect(JSON.parse(r.sockets[0].sent[0])).toEqual({ v: 1, type: 'auth', token: 'tok' });
    r.sockets[0].push(snapshot());
    r.timers.tick(2000);
    const hbs = r.sockets[0].sent.slice(1).map((x) => JSON.parse(x));
    expect(hbs).toHaveLength(2);
    expect(hbs[0]).toEqual({ v: 1, type: 'hb', srv_ts: 1000 });
  });
  it('close 4401 reports a rejected login and never reconnects', () => {
    const r = rig(); r.s.start(); r.sockets[0].open(); r.sockets[0].drop(4401);
    r.timers.tick(10000);
    expect(r.log).toEqual(['connecting', 'auth']);
    expect(r.sockets).toHaveLength(1);
  });
  it('close 4403 is final too', () => {
    const r = rig(); r.s.start(); r.sockets[0].open(); r.sockets[0].drop(4403);
    r.timers.tick(10000);
    expect(r.log).toEqual(['connecting', 'forbidden']);
    expect(r.sockets).toHaveLength(1);
  });
  it('close 4408 reconnects after the delay and authenticates again', () => {
    const r = rig(); r.s.start(); r.sockets[0].open(); r.sockets[0].drop(4408);
    expect(r.sockets).toHaveLength(1);
    r.timers.tick(999); expect(r.sockets).toHaveLength(1);
    r.timers.tick(1); expect(r.sockets).toHaveLength(2);
    r.sockets[1].open();
    expect(JSON.parse(r.sockets[1].sent[0]).type).toBe('auth');
  });
  it('a clean close 1000 from the host and an abnormal 1006 both reconnect', () => {
    for (const code of [1000, 1006]) {
      const r = rig(); r.s.start(); r.sockets[0].open(); r.sockets[0].drop(code); r.timers.tick(1000);
      expect(r.sockets).toHaveLength(2);
    }
  });
  it('a resync request closes the socket and opens a new one', () => {
    const r = rig('tok', (m) => m.type === 'tick');
    r.s.start(); r.sockets[0].open(); r.sockets[0].push(snapshot()); r.sockets[0].push(tick(5));
    expect(r.sockets[0].closed).toBe(1000);
    r.timers.tick(0); expect(r.sockets).toHaveLength(2);
    r.sockets[0].push(tick(6)); // a late message from the old socket is ignored
    expect(r.got).toHaveLength(2);
  });
  it('rejects bad JSON, an unknown v and an unknown type', () => {
    const r = rig(); r.s.start(); r.sockets[0].open();
    r.sockets[0].push('not json'); r.sockets[0].push({ v: 2, type: 'tick', srv_seq: 1, srv_ts: 1 }); r.sockets[0].push({ v: 1, type: 'nope' });
    expect(r.got).toHaveLength(0);
    expect(r.s.badMessages).toBe(3);
  });
  it('with no token it reports a rejected login without opening a socket', () => {
    const r = rig(null); r.s.start();
    expect(r.log).toEqual(['auth']);
    expect(r.sockets).toHaveLength(0);
  });
  it('stop() closes cleanly and does not reconnect', () => {
    const r = rig(); r.s.start(); r.sockets[0].open(); r.s.stop(); r.timers.tick(5000);
    expect(r.sockets[0].closed).toBe(1000);
    expect(r.sockets).toHaveLength(1);
  });
});
