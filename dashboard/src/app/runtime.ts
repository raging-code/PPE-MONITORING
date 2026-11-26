import { controller, liveStore } from '../store/live.ts';
import { TOKEN_KEY } from '../store/controller.ts';
import { createBridge, type Bridge } from '../worker/bridge.ts';
import { createWatchdogClient, wdStore } from '../store/watchdog.ts';
import { audioStore, bindSiren, createSiren, webAudioPort } from '../audio/siren.ts';
import type { Controller } from '../store/controller.ts';

let cached: { controller: Controller; bridge: Bridge } | null = null;

// Created on first use, once, so React StrictMode does not start two workers.
export function getRuntime(): { controller: Controller; bridge: Bridge } {
  if (!cached) {
    const worker = new Worker(new URL('../worker/liveWatchdog.ts', import.meta.url), { type: 'module' });
    const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const bridge = createBridge(worker, scheme + window.location.host + '/ws/tick');
    const client = createWatchdogClient({ api: { fetchFn: (...a) => fetch(...a), getToken: () => window.sessionStorage.getItem(TOKEN_KEY) } });
    worker.onmessage = (e: MessageEvent) => { void client.handle(e.data); };
    bindSiren(createSiren(webAudioPort(() => audioStore.getState().ctx)), wdStore, audioStore);
    // The worker judges the data socket too (3.7): it hears of every message, and stops judging when the page needs a login.
    liveStore.subscribe((s, prev) => {
      if (s.conn === 'LIVE' && s.lastSrvTs !== prev.lastSrvTs) bridge.dataAlive();
      if ((s.conn === 'LOGIN' || s.conn === 'FORBIDDEN') && prev.conn !== s.conn) bridge.stop();
    });
    cached = { controller, bridge };
  }
  return cached;
}
