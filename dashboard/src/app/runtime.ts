import { controller, liveStore } from '../store/live.ts';
import { TOKEN_KEY } from '../store/controller.ts';
import { createBridge, type Bridge } from '../worker/bridge.ts';
import { createWatchdogClient, wdStore } from '../store/watchdog.ts';
import { audioStore, bindSiren, createSiren, webAudioPort } from '../audio/siren.ts';
import { createGate, type Gate, type GateCtx, type LocksLike } from '../audio/gate.ts';
import type { Controller } from '../store/controller.ts'; // P22c-2

let cached: { controller: Controller; bridge: Bridge; gate: Gate } | null = null;

// Created on first use, once, so React StrictMode does not start two workers.
export function getRuntime(): { controller: Controller; bridge: Bridge; gate: Gate } {
  if (!cached) {
    const worker = new Worker(new URL('../worker/liveWatchdog.ts', import.meta.url), { type: 'module' });
    const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const bridge = createBridge(worker, scheme + window.location.host + '/ws/tick');
    const api = { fetchFn: (...a: Parameters<typeof fetch>) => fetch(...a), getToken: () => window.sessionStorage.getItem(TOKEN_KEY) };
    const client = createWatchdogClient({ api });
    worker.onmessage = (e: MessageEvent) => { void client.handle(e.data); };
    bindSiren(createSiren(webAudioPort(() => audioStore.getState().ctx)), wdStore, audioStore);
    // Start monitoring gate (3.7): Test sound, wake lock, audio-owner Web Lock, hidden-tab notice.
    const gate = createGate({
      api,
      makeCtx: () => new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)() as unknown as GateCtx,
      locks: navigator.locks as unknown as LocksLike | undefined,
      wake: navigator.wakeLock ? { request: (t) => navigator.wakeLock.request(t) as unknown as ReturnType<NonNullable<Parameters<typeof createGate>[0]['wake']>['request']> } : undefined,
      visibility: { hidden: () => document.hidden, onChange: (f) => document.addEventListener('visibilitychange', f) },
    });
    window.addEventListener('pagehide', () => gate.release());
    // The worker judges the data socket too (3.7; the gate checks audio on each tick): it hears of every message, and stops judging when the page needs a login.
    liveStore.subscribe((s, prev) => {
      if (s.conn === 'LIVE' && s.lastSrvTs !== prev.lastSrvTs) { bridge.dataAlive(); gate.check(); } // 3.9: the audio state is checked on each 1 Hz tick
      if ((s.conn === 'LOGIN' || s.conn === 'FORBIDDEN') && prev.conn !== s.conn) bridge.stop();
    });
    cached = { controller, bridge, gate };
  }
  return cached;
}
