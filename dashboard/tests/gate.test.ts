import { describe, it, expect, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createGate, gateStore, sirenView, LOCK_NAME, type GateCtx, type GatePorts, type GateState, type LocksLike } from '../src/audio/gate.ts';
import type { AudioState } from '../src/audio/siren.ts';

class FakeCtx implements GateCtx {
  state = 'suspended'; sampleRate = 8000; destination = 'dest'; sources: { buffer: unknown; loop: boolean; connect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop(): void }[] = [];
  resume = vi.fn(async () => { this.state = 'running'; });
  createBuffer(_c: number, n: number) { const a = new Float32Array(n); return { getChannelData: () => a }; }
  createBufferSource() { const s = { buffer: null as unknown, loop: true, connect: vi.fn(), start: vi.fn(), stop() {} }; this.sources.push(s); return s; }
}
// One lock manager shared by every "tab", with the real semantics: ifAvailable gets null when held; a plain request queues.
class FakeLocks {
  held = false; q: (() => void)[] = [];
  request(name: string, a: unknown, b?: unknown): Promise<unknown> {
    const opts = (b ? a : {}) as { ifAvailable?: boolean }, cb = (b ?? a) as (l: unknown) => Promise<void>;
    const run = () => { this.held = true; return cb({ name }).finally(() => { this.held = false; this.q.shift()?.(); }); };
    if (!this.held) return run();
    if (opts.ifAvailable) return cb(null);
    return new Promise((res) => this.q.push(() => res(run())));
  }
}
class FakeWake {
  fail = false; listeners: (() => void)[] = []; sentinel = { released: false, addEventListener: (_t: 'release', f: () => void) => { this.listeners.push(f); } };
  request = vi.fn(async () => { if (this.fail) throw new Error('denied'); this.sentinel = { ...this.sentinel, released: false }; return this.sentinel; });
  lose() { this.sentinel.released = true; this.listeners.forEach((f) => f()); }
}
const reply = (status: number, body: unknown = {}) => vi.fn(async () => ({ status, json: async () => body }) as unknown as Response);

function tab(o: { locks?: FakeLocks; wake?: FakeWake; status?: number } = {}) {
  const ctx = new FakeCtx(), f = reply(o.status ?? 200, { session_id: 1, started_ts: 1, mode: 'LIVE', monitoring_active: true });
  const vis = { isHidden: false, fns: [] as (() => void)[] };
  const store = createStore<GateState>(() => ({ ...gateStore.getInitialState() })), audio = createStore<AudioState>(() => ({ unlocked: false, ctx: null }));
  const ports: GatePorts = { api: { fetchFn: f as unknown as typeof fetch, getToken: () => 'tok' }, makeCtx: () => ctx, locks: o.locks as unknown as LocksLike, wake: o.wake,
    visibility: { hidden: () => vis.isHidden, onChange: (fn) => vis.fns.push(fn) } };
  const gate = createGate(ports, { store, audio });
  const setHidden = (h: boolean) => { vis.isHidden = h; vis.fns.forEach((fn) => fn()); };
  return { gate, ctx, f, store, audio, setHidden };
}

describe('Test sound before Start monitoring (3.9, 3.12)', () => {
  it('Start monitoring is refused until the test tone has played, and sends nothing', async () => {
    const t = tab();
    expect(await t.gate.startMonitoring()).toBe('needs_test');
    expect(t.f).not.toHaveBeenCalled(); expect(t.audio.getState().unlocked).toBe(false);
    await t.gate.testSound();
    expect(t.store.getState().tested).toBe(true); expect(t.ctx.sources).toHaveLength(1); expect(t.ctx.sources[0].start).toHaveBeenCalledTimes(1);
    expect(t.audio.getState().unlocked).toBe(false); // a test tone alone unlocks nothing
  });
  it('a browser that blocks the tone leaves the gate closed with a message', async () => {
    const t = tab(); t.ctx.resume.mockRejectedValueOnce(new Error('blocked'));
    await t.gate.testSound();
    expect(t.store.getState().tested).toBe(false); expect(t.store.getState().msg).toMatch(/blocked the test sound/);
  });
  it('Start monitoring unlocks audio, then POSTs /api/session/start with the token', async () => {
    const t = tab(); await t.gate.testSound();
    expect(await t.gate.startMonitoring()).toBe('ok');
    expect(t.audio.getState()).toMatchObject({ unlocked: true }); expect(sirenView(t.store.getState())).toBe('on');
    const [url, init] = t.f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/session/start'); expect(init.method).toBe('POST'); expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('audio is unlocked even when the host does not answer: the siren is for a dead host', async () => {
    const t = tab({ status: 503 }); await t.gate.testSound();
    expect(await t.gate.startMonitoring()).toBe('retry');
    expect(t.audio.getState().unlocked).toBe(true); expect(t.store.getState().msg).toMatch(/host alarm still sounds/);
    expect(await t.gate.startMonitoring()).toBe('retry'); // clicking again is allowed and does not break the lock
    expect(t.store.getState().owner).toBe('me');
  });
});

describe('SIREN OFF: browser suspended or blocked audio (3.9)', () => {
  it('the 1 s check finds a suspended context, shows SIREN OFF and locks the siren; one click re-enables it', async () => {
    const t = tab(); await t.gate.testSound(); await t.gate.startMonitoring();
    t.ctx.state = 'suspended'; t.ctx.resume.mockImplementationOnce(async () => { /* still blocked */ });
    t.gate.check();
    expect(sirenView(t.store.getState())).toBe('off'); expect(t.audio.getState().unlocked).toBe(false);
    await t.gate.enable();
    expect(sirenView(t.store.getState())).toBe('on'); expect(t.audio.getState().unlocked).toBe(true);
  });
});

describe('One tab owns the siren (Web Lock, 3.3)', () => {
  it('the second tab shows "Sound in another tab" and plays nothing; when the owner closes it shows SIREN OFF and one click takes over', async () => {
    const locks = new FakeLocks(), a = tab({ locks }), b = tab({ locks });
    await a.gate.testSound(); await a.gate.startMonitoring(); await b.gate.testSound(); await b.gate.startMonitoring();
    expect(a.store.getState().owner).toBe('me'); expect(b.store.getState().owner).toBe('other');
    expect(sirenView(b.store.getState())).toBe('other'); expect(b.audio.getState().unlocked).toBe(false);
    a.gate.release(); await Promise.resolve(); await Promise.resolve();
    expect(b.store.getState().owner).toBe('lost'); expect(sirenView(b.store.getState())).toBe('off'); expect(b.audio.getState().unlocked).toBe(false);
    await b.gate.enable();
    expect(b.store.getState().owner).toBe('me'); expect(b.audio.getState().unlocked).toBe(true); expect(LOCK_NAME).toBe('ppe-siren-owner');
  });
});

describe('Screen wake lock (3.7)', () => {
  it('is requested at Start monitoring; a lost lock shows the badge; it is re-acquired when the tab is shown again', async () => {
    const w = new FakeWake(), t = tab({ wake: w }); await t.gate.testSound(); await t.gate.startMonitoring();
    expect(w.request).toHaveBeenCalledTimes(1); expect(t.store.getState().wakeLost).toBe(false);
    w.lose(); expect(t.store.getState().wakeLost).toBe(true);
    t.setHidden(true); t.setHidden(false); await Promise.resolve(); await Promise.resolve();
    expect(w.request).toHaveBeenCalledTimes(2); expect(t.store.getState().wakeLost).toBe(false);
  });
  it('a browser that refuses, or has no wake lock, shows the badge instead of failing', async () => {
    const w = new FakeWake(); w.fail = true;
    const t = tab({ wake: w }); await t.gate.testSound(); await t.gate.startMonitoring(); expect(t.store.getState().wakeLost).toBe(true);
    const n = tab(); await n.gate.testSound(); await n.gate.startMonitoring(); expect(n.store.getState().wakeLost).toBe(true);
  });
});

describe('Hidden tab (3.7)', () => {
  it('shows the notice on return, only after the tab was hidden, until dismissed', () => {
    const t = tab(); t.setHidden(false); expect(t.store.getState().hiddenReturn).toBe(false);
    t.setHidden(true); expect(t.store.getState().hiddenReturn).toBe(false);
    t.setHidden(false); expect(t.store.getState().hiddenReturn).toBe(true);
    t.gate.dismissHidden(); expect(t.store.getState().hiddenReturn).toBe(false);
  });
});
