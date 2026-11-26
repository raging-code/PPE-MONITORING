import { controller } from '../store/live.ts';
import { createBridge, type Bridge } from '../worker/bridge.ts';
import type { Controller } from '../store/controller.ts';

let cached: { controller: Controller; bridge: Bridge } | null = null;

// Created on first use, once, so React StrictMode does not start two workers.
export function getRuntime(): { controller: Controller; bridge: Bridge } {
  if (!cached) {
    const worker = new Worker(new URL('../worker/liveWatchdog.ts', import.meta.url), { type: 'module' });
    const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    cached = { controller, bridge: createBridge(worker, scheme + window.location.host + '/ws/tick') };
  }
  return cached;
}
