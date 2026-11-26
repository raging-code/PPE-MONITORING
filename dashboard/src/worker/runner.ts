// The worker's logic with every outside thing injected, so Vitest drives it with a fake clock and a fake socket.
// Main thread to worker: INIT_AUTH, DATA_ALIVE, SILENCE, STOP. Worker to main: INIT_ACK, WD_STATE, OUTAGE.
import { Watchdog } from './watchdog.ts';

export interface TickSocket { start(): void; stop(): void }
export interface RunnerDeps {
  post(m: unknown): void;
  makeSocket(o: { url: string; token: string; onTick(srvTs: number): void; onAuthLost(): void }): TickSocket;
  now(): number; // monotonic ms
  wall(): number; // UTC ms, for the outage report only
  every(fn: () => void, ms: number): () => void;
  staleMs: number;
  checkMs?: number;
}
export const CHECK_MS = 250;

export function createRunner(d: RunnerDeps) {
  const wd = new Watchdog(d.staleMs);
  let sock: TickSocket | null = null;
  let stopTimer: (() => void) | null = null;
  let last = '';
  const run = () => {
    const t = d.now(), v = wd.check(t);
    const key = `${v.noData}|${v.sirenOn}`;
    if (key !== last) { last = key; d.post({ type: 'WD_STATE', noData: v.noData, sirenOn: v.sirenOn }); }
    if (v.outage) {
      const w = d.wall(), ended = w, started = Math.max(w - (t - v.outage.startedAt), ended - 86_400_000);
      d.post({ type: 'OUTAGE', started_ts: Math.round(started), ended_ts: Math.round(ended), duration_s: (Math.round(ended) - Math.round(started)) / 1000 });
    }
  };
  const halt = () => { sock?.stop(); sock = null; wd.disarm(); run(); };
  return {
    handle(m: unknown): void {
      const x = m as { type?: unknown; token?: unknown; ws_tick_url?: unknown } | null;
      if (!x) return;
      if (x.type === 'INIT_AUTH' && typeof x.token === 'string' && typeof x.ws_tick_url === 'string') {
        sock?.stop();
        wd.arm(d.now());
        sock = d.makeSocket({ url: x.ws_tick_url, token: x.token, onTick: (ts) => { wd.tick(ts, d.now()); run(); }, onAuthLost: halt });
        sock.start();
        stopTimer ??= d.every(run, d.checkMs ?? CHECK_MS);
        d.post({ type: 'INIT_ACK', ws_tick_url: x.ws_tick_url });
      } else if (x.type === 'DATA_ALIVE') { wd.data(d.now()); run(); }
      else if (x.type === 'SILENCE') { wd.silence(d.now()); run(); }
      else if (x.type === 'STOP') halt();
    },
  };
}
