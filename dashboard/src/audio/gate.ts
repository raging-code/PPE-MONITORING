// Test sound and Start monitoring gate (design 3.7, 3.9, 3.12). Browser audio needs a user gesture, so the page offers Test sound first
// and Start monitoring only after the test tone played. Start monitoring unlocks the siren, takes the audio-owner Web Lock and the
// screen wake lock. The host alarm never depends on any of this. Every outside thing is a port, so the logic is tested without a browser.
import { createStore, type StoreApi } from 'zustand/vanilla';
import { postSessionStart, type ActionResult, type Api } from '../api/actions.ts';
import { audioStore, type AudioCtxLike, type AudioState } from './siren.ts';

export const LOCK_NAME = 'ppe-siren-owner';
export const TEST_TONE_HZ = 880, TEST_TONE_S = 0.4; // ADR 0020 (Proposed): no design value; the host beep and siren have their own files

export interface GateCtx extends AudioCtxLike { state?: string; resume?(): Promise<void> }
export interface SentinelLike { released?: boolean; addEventListener(type: 'release', f: () => void): void }
export interface LocksLike {
  request(name: string, opts: { ifAvailable: true }, cb: (lock: unknown) => Promise<void>): Promise<unknown>;
  request(name: string, cb: (lock: unknown) => Promise<void>): Promise<unknown>;
}
export interface GatePorts {
  api: Api;
  makeCtx(): GateCtx;
  locks?: LocksLike; // absent: one tab is assumed
  wake?: { request(type: 'screen'): Promise<SentinelLike> }; // absent: the screen may sleep
  visibility?: { hidden(): boolean; onChange(f: () => void): void };
}

// owner: none = not asked yet, me = this tab plays, other = another tab plays, lost = the owner closed and this tab may take over by a click
export type Owner = 'none' | 'me' | 'other' | 'lost';
export interface GateState { tested: boolean; started: boolean; owner: Owner; running: boolean; wakeLost: boolean; hiddenReturn: boolean; msg: string | null }
export const gateStore = createStore<GateState>(() => ({ tested: false, started: false, owner: 'none', running: false, wakeLost: false, hiddenReturn: false, msg: null }));

export type SirenView = 'locked' | 'on' | 'off' | 'other';
export const sirenView = (g: GateState): SirenView => (!g.started ? 'locked' : g.owner === 'other' ? 'other' : g.owner === 'me' && g.running ? 'on' : 'off');

const startMsg = (r: ActionResult<unknown>): string | null => {
  switch (r.kind) {
    case 'ok': return null;
    case 'auth': return 'Not signed in. Log in again.';
    case 'retry': case 'conflict': return 'The host did not accept the start yet. The host alarm still sounds. Click Start monitoring again.';
    default: return 'Start monitoring was not accepted by the host.';
  }
};

export function createGate(p: GatePorts, o: { store?: StoreApi<GateState>; audio?: StoreApi<AudioState> } = {}) {
  const store = o.store ?? gateStore, audio = o.audio ?? audioStore;
  let ctx: GateCtx | null = null, hold: (() => void) | null = null, sentinel: SentinelLike | null = null, wasHidden = false, starting = false;
  const set = (x: Partial<GateState>) => store.setState(x);
  // Audio counts as unlocked only while this tab owns the siren and the browser is really running its audio clock.
  const sync = () => {
    store.setState({ running: !!ctx && (ctx.state === undefined || ctx.state === 'running') });
    const g = store.getState();
    audio.setState({ ctx, unlocked: g.started && g.owner === 'me' && g.running });
  };
  const holder = () => new Promise<void>((res) => { hold = res; });
  const takeLock = (): Promise<Owner> => {
    const l = p.locks;
    if (!l) return Promise.resolve('me');
    return new Promise((resolve) => {
      void l.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (lock) { resolve('me'); return holder(); }
        resolve('other');
        void l.request(LOCK_NAME, () => { set({ owner: 'lost' }); sync(); return holder(); }); // queued: runs when the owner closes
        return Promise.resolve();
      });
    });
  };
  const acquireWake = async () => {
    if (sentinel && sentinel.released === false) return;
    try {
      if (!p.wake) throw new Error('no wake lock');
      const s = await p.wake.request('screen');
      sentinel = s; s.addEventListener('release', () => set({ wakeLost: true }));
      set({ wakeLost: false });
    } catch { set({ wakeLost: true }); }
  };
  p.visibility?.onChange(() => {
    if (p.visibility?.hidden()) { wasHidden = true; return; }
    if (wasHidden) set({ hiddenReturn: true }); // 3.7: shown on return, whatever the length
    wasHidden = false;
    if (store.getState().started) void acquireWake(); // 3.7: re-acquired each time the tab becomes visible
    api.check();
  });
  const api = {
    store,
    async testSound(): Promise<void> {
      try {
        if (!ctx) ctx = p.makeCtx();
        await ctx.resume?.();
        const rate = ctx.sampleRate, n = Math.round(rate * TEST_TONE_S), buf = ctx.createBuffer(1, n, rate), d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = 0.3 * Math.sin((2 * Math.PI * TEST_TONE_HZ * i) / rate);
        const s = ctx.createBufferSource(); s.buffer = buf; s.loop = false; s.connect(ctx.destination); s.start();
        set({ tested: true, msg: null }); sync();
      } catch { set({ msg: 'This browser blocked the test sound. Click Test sound again.' }); }
    },
    // Unlock first, tell the host second: the browser siren is for the day the host is dead, so it must not wait for the host.
    async startMonitoring(): Promise<'needs_test' | 'busy' | ActionResult<unknown>['kind']> {
      if (!store.getState().tested || !ctx) return 'needs_test';
      if (starting) return 'busy';
      starting = true;
      try {
        set({ started: true, msg: null });
        try { await ctx.resume?.(); } catch { /* sync() shows SIREN OFF */ }
        if (store.getState().owner !== 'me') set({ owner: await takeLock() });
        sync();
        void acquireWake();
        const r = await postSessionStart(p.api);
        set({ msg: startMsg(r) });
        return r.kind;
      } finally { starting = false; }
    },
    // The SIREN OFF click: resume the audio clock and, if the old owner closed, take the siren over.
    async enable(): Promise<void> {
      try { await ctx?.resume?.(); } catch { /* still off */ }
      if (store.getState().owner === 'lost') set({ owner: 'me' });
      sync();
    },
    // Called every second from the data tick: has the browser suspended or blocked audio?
    check(): void {
      sync();
      const g = store.getState();
      if (g.started && g.owner === 'me' && !g.running) void ctx?.resume?.().then(sync, () => undefined);
    },
    dismissHidden(): void { set({ hiddenReturn: false }); },
    release(): void { hold?.(); hold = null; set({ owner: 'none' }); sync(); },
  };
  return api;
}
export type Gate = ReturnType<typeof createGate>;
