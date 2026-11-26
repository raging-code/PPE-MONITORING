// Browser siren (design 3.3, 3.9): only the NO LIVE DATA siren plays in the browser. It is a looping buffer on the Web Audio
// clock, so no page timer repeats it and a hidden tab cannot slow it. It plays only after Start monitoring unlocked audio.
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { WdState } from '../store/watchdog.ts';

export interface SirenPort { start(): void; stop(): void }
export interface AudioCtxLike {
  sampleRate: number;
  destination: unknown;
  createBuffer(channels: number, length: number, rate: number): { getChannelData(c: number): Float32Array };
  createBufferSource(): { buffer: unknown; loop: boolean; connect(d: unknown): void; start(): void; stop(): void };
}
// ctx is set by the Start monitoring click (P22c-2): a browser starts audio only after a user gesture.
export interface AudioState { unlocked: boolean; ctx: AudioCtxLike | null }
export const audioStore = createStore<AudioState>(() => ({ unlocked: false, ctx: null }));
export const useAudio = <T,>(pick: (s: AudioState) => T): T => useStore(audioStore, pick);

export function createSiren(port: SirenPort) {
  let on = false;
  return {
    get playing() { return on; },
    sync(want: boolean): void { if (want === on) return; on = want; if (want) port.start(); else port.stop(); },
  };
}

export function bindSiren(siren: ReturnType<typeof createSiren>, wd: StoreApi<WdState>, audio: StoreApi<AudioState>): void {
  const f = () => siren.sync(wd.getState().sirenOn && audio.getState().unlocked);
  wd.subscribe(f); audio.subscribe(f); f();
}

// Two-tone wail, one second: 700 Hz rising to 1100 Hz over 0.5 s and falling back. Distinct from the host chime and alarms (3.9).
export function webAudioPort(getCtx: () => AudioCtxLike | null): SirenPort {
  let src: { stop(): void } | null = null;
  return {
    start() {
      const ctx = getCtx();
      if (!ctx || src) return;
      const n = ctx.sampleRate, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
      let ph = 0;
      for (let i = 0; i < n; i++) { const t = i / n, f = 700 + 400 * (t < 0.5 ? t * 2 : 2 - t * 2); ph += (2 * Math.PI * f) / ctx.sampleRate; d[i] = 0.6 * Math.sin(ph); }
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.connect(ctx.destination); s.start(); src = s;
    },
    stop() { try { src?.stop(); } finally { src = null; } },
  };
}
