import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { postOutage, type Api, type OutageBody } from '../api/actions.ts';

// What the worker last said about NO LIVE DATA. sirenOn is false while the 60 s silence runs.
export interface WdState { noData: boolean; sirenOn: boolean }
export const wdStore = createStore<WdState>(() => ({ noData: false, sirenOn: false }));
export const useWd = <T,>(pick: (s: WdState) => T): T => useStore(wdStore, pick);

export const OUTAGE_RETRY_MS = 1000; // ADR 0019 (Proposed): no design value, same approach as ADR 0013 and 0017
export const OUTAGE_TRIES = 60;

export interface ClientOptions { store?: typeof wdStore; api: Api; wait?: (ms: number) => Promise<void>; retryMs?: number }

// Worker messages in, store and outage report out. The report goes only to a host that answers: a network failure or 5xx
// is retried, so it is sent once the host is back. Any other answer (401, 422 and so on) ends it: retrying cannot fix it.
export function createWatchdogClient(o: ClientOptions) {
  const store = o.store ?? wdStore, wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const report = async (b: OutageBody): Promise<void> => {
    for (let i = 0; i < OUTAGE_TRIES; i++) {
      if ((await postOutage(o.api, b)).kind !== 'retry') return;
      await wait(o.retryMs ?? OUTAGE_RETRY_MS);
    }
  };
  return {
    handle(m: unknown): Promise<void> | void {
      const x = m as { type?: string; noData?: unknown; sirenOn?: unknown } & Partial<OutageBody> | null;
      if (!x) return;
      if (x.type === 'WD_STATE') store.setState({ noData: x.noData === true, sirenOn: x.sirenOn === true });
      else if (x.type === 'OUTAGE' && typeof x.started_ts === 'number' && typeof x.ended_ts === 'number' && typeof x.duration_s === 'number') {
        return report({ started_ts: x.started_ts, ended_ts: x.ended_ts, duration_s: x.duration_s });
      }
    },
  };
}
