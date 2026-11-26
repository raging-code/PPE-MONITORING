import { describe, it, expect } from 'vitest';
import { Watchdog, SILENCE_MS } from '../src/worker/watchdog.ts';
import { createRunner, type RunnerDeps } from '../src/worker/runner.ts';
import { createBridge } from '../src/worker/bridge.ts';
import { LiveSocket } from '../src/net/socket.ts';
import { FakeTimers, FakeWs } from './helpers.ts';

const S = 4000;
// Keeps both sockets alive: a tick and a data message every second until `until`.
const feed = (w: Watchdog, from: number, until: number, srv0 = 1000) => { for (let t = from; t <= until; t += 1000) { w.tick(srv0 + t, t); w.data(t); } };

describe('Watchdog judgement (design 3.7)', () => {
  it('is quiet until armed, then fires at exactly 4 s without a tick', () => {
    const w = new Watchdog(S);
    expect(w.check(99999).noData).toBe(false);
    w.arm(0); w.data(0);
    expect(w.check(3999).noData).toBe(false);
    expect(w.check(4000)).toMatchObject({ noData: true, sirenOn: true });
  });
  it('steady ticks and data keep it quiet', () => {
    const w = new Watchdog(S); w.arm(0); feed(w, 1000, 20000);
    expect(w.check(20500).noData).toBe(false);
  });
  it('fires when only the data socket goes quiet, and when only the tick socket does', () => {
    const a = new Watchdog(S); a.arm(0);
    for (let t = 1000; t <= 6000; t += 1000) a.tick(1000 + t, t);
    expect(a.check(6000).noData).toBe(true); // data last heard at 0
    const b = new Watchdog(S); b.arm(0);
    for (let t = 1000; t <= 6000; t += 1000) b.data(t);
    expect(b.check(6000).noData).toBe(true); // ticks last heard at 0
  });
  it('a tick whose server time jumped by 4 s or more is not proof of life', () => {
    const w = new Watchdog(S); w.arm(0); feed(w, 1000, 3000);
    w.tick(1000 + 3000 + 4000, 3500); w.data(3500); // delivered on time, but the host was silent for 4 s
    expect(w.check(7500).noData).toBe(true);
    w.tick(1000 + 3000 + 5000, 7600); w.data(7600);
    expect(w.check(7600).noData).toBe(false);
  });
  it('recovery needs both sockets, and the outage starts at the oldest last-good mark', () => {
    const w = new Watchdog(S); w.arm(0); feed(w, 1000, 2000);
    expect(w.check(7000).noData).toBe(true);
    w.tick(4000, 8000); expect(w.check(8000).noData).toBe(true);
    w.data(8100);
    expect(w.check(8100)).toMatchObject({ noData: false, outage: { startedAt: 2000, endedAt: 8100 } });
    expect(w.check(8200).outage).toBeNull();
  });
  it('Silence 60 s: quiet for 59.999 s, sounds again at 60 s while still down, and only counts while down', () => {
    const w = new Watchdog(S); w.arm(0); w.silence(100); expect(w.check(100).sirenOn).toBe(false); // not down: ignored
    w.check(4000); w.silence(5000);
    expect(w.check(5000)).toMatchObject({ noData: true, sirenOn: false });
    expect(w.check(5000 + SILENCE_MS - 1).sirenOn).toBe(false);
    expect(w.check(5000 + SILENCE_MS)).toMatchObject({ noData: true, sirenOn: true });
  });
  it('recovering drops a silence, so the next outage sounds at once', () => {
    const w = new Watchdog(S); w.arm(0); w.check(4000); w.silence(4000);
    w.tick(1, 4100); w.data(4100); w.check(4100);
    w.check(9000); expect(w.check(9000).sirenOn).toBe(true);
  });
});

function rig(wall0 = 1_000_000) {
  const t = new FakeTimers(), posts: Record<string, unknown>[] = [], socks: { url: string; token: string; started: boolean; stopped: boolean; onTick(ts: number): void; onAuthLost(): void }[] = [];
  const deps: RunnerDeps = {
    post: (m) => posts.push(m as Record<string, unknown>),
    makeSocket: (o) => { const s = { ...o, started: false, stopped: false }; socks.push(s); return { start: () => { s.started = true; }, stop: () => { s.stopped = true; } }; },
    now: () => t.now, wall: () => wall0 + t.now, every: (f, ms) => { const h = t.setInterval(f, ms); return () => t.clearInterval(h); }, staleMs: S,
  };
  const r = createRunner(deps);
  const init = () => r.handle({ type: 'INIT_AUTH', token: 'tok', ws_tick_url: 'ws://h/ws/tick' });
  const states = () => posts.filter((p) => p.type === 'WD_STATE');
  return { t, r, posts, socks, init, states };
}

describe('Worker runner', () => {
  it('opens its own /ws/tick socket with the token and answers INIT_ACK', () => {
    const g = rig(); g.init();
    expect(g.socks[0]).toMatchObject({ url: 'ws://h/ws/tick', token: 'tok', started: true });
    expect(g.posts).toContainEqual({ type: 'INIT_ACK', ws_tick_url: 'ws://h/ws/tick' });
  });
  it('says NO LIVE DATA once, at 4 s, even though nobody asks (tab hidden: the worker keeps its own timer)', () => {
    const g = rig(); g.init(); const down = () => g.states().filter((s) => s.noData);
    g.t.tick(3999); expect(down()).toHaveLength(0);
    g.t.tick(1); expect(down()).toEqual([{ type: 'WD_STATE', noData: true, sirenOn: true }]);
    g.t.tick(10000); expect(down()).toHaveLength(1);
  });
  it('with only the data socket blocked it still fires at 4 s', () => {
    const g = rig(); g.init();
    for (let i = 0; i < 6; i++) { g.t.tick(1000); g.socks[0].onTick(5000 + i * 1000); }
    expect(g.states().at(-1)).toMatchObject({ noData: true });
  });
  it('DATA_ALIVE and ticks together keep it quiet', () => {
    const g = rig(); g.init();
    for (let i = 0; i < 20; i++) { g.t.tick(1000); g.socks[0].onTick(5000 + i * 1000); g.r.handle({ type: 'DATA_ALIVE' }); }
    expect(g.states().every((s) => s.noData === false)).toBe(true);
  });
  it('SILENCE stops the siren, and it re-arms 60 s later while the host is still down', () => {
    const g = rig(); g.init(); g.t.tick(4000);
    g.r.handle({ type: 'SILENCE' });
    expect(g.states().at(-1)).toEqual({ type: 'WD_STATE', noData: true, sirenOn: false });
    g.t.tick(59750); expect(g.states().at(-1)).toMatchObject({ sirenOn: false });
    g.t.tick(250); expect(g.states().at(-1)).toEqual({ type: 'WD_STATE', noData: true, sirenOn: true });
  });
  it('reports the outage in UTC ms once the host is back, with the duration the host will check', () => {
    const g = rig(1_000_000); g.init(); g.t.tick(1000); g.socks[0].onTick(2000); g.r.handle({ type: 'DATA_ALIVE' });
    g.t.tick(9000); // last good at 1000, down since then
    g.socks[0].onTick(20000); g.r.handle({ type: 'DATA_ALIVE' }); // the first tick after a gap of 4 s or more is not proof (see watchdog.ts)
    expect(g.posts.find((p) => p.type === 'OUTAGE')).toBeUndefined();
    g.t.tick(1000); g.socks[0].onTick(21000); g.r.handle({ type: 'DATA_ALIVE' });
    const o = g.posts.find((p) => p.type === 'OUTAGE')!;
    expect(o).toEqual({ type: 'OUTAGE', started_ts: 1_001_000, ended_ts: 1_011_000, duration_s: 10 });
    expect(g.states().at(-1)).toMatchObject({ noData: false, sirenOn: false });
  });
  it('STOP and a rejected token end the judging, so the Login page never shows NO LIVE DATA', () => {
    const g = rig(); g.init(); g.r.handle({ type: 'STOP' });
    expect(g.socks[0].stopped).toBe(true); g.t.tick(30000);
    expect(g.states().every((s) => s.noData === false)).toBe(true);
    const h = rig(); h.init(); h.socks[0].onAuthLost(); h.t.tick(30000);
    expect(h.states().every((s) => s.noData === false)).toBe(true);
  });
  it('a second INIT_AUTH replaces the socket', () => {
    const g = rig(); g.init(); g.init();
    expect(g.socks).toHaveLength(2); expect(g.socks[0].stopped).toBe(true);
  });
});

describe('Bridge and tick socket', () => {
  it('sends DATA_ALIVE, SILENCE and STOP, and a login after STOP is sent again', () => {
    const sent: unknown[] = []; const b = createBridge({ postMessage: (m) => sent.push(m) }, 'u');
    b.init('a'); b.dataAlive(); b.silence(); b.stop(); b.init('a');
    expect(sent).toEqual([{ type: 'INIT_AUTH', token: 'a', ws_tick_url: 'u' }, { type: 'DATA_ALIVE' }, { type: 'SILENCE' }, { type: 'STOP' }, { type: 'INIT_AUTH', token: 'a', ws_tick_url: 'u' }]);
  });
  it('the tick socket sends auth and no heartbeat (only /ws takes one)', () => {
    const t = new FakeTimers(), ws = new FakeWs();
    new LiveSocket({ url: 'u', getToken: () => 'tok', noHb: true, onMessage: () => false, onConnecting: () => {}, onAuthRejected: () => {}, onForbidden: () => {}, create: () => ws, timers: t }).start();
    ws.open(); t.tick(5000);
    expect(ws.sent.map((s) => JSON.parse(s).type)).toEqual(['auth']);
  });
});
