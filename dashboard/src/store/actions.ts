// Runs Acknowledge and Resolve (design 3.3). The click is shown at once and sent in the background; a failed call is retried and never
// un-silences the card. The host stores the Acknowledge, so a reload, a second tab or a host restart sees it from the snapshot.
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { postAlertAck, postEpisodeAck, postResolve, type ActionResult, type Api, type ResolveBody, type ResolveReason } from '../api/actions.ts';
import type { AckTargets, Acks } from '../alerts/ack.ts';
import { TOKEN_KEY } from './controller.ts';
import type { Timers } from '../net/socket.ts';

export const acksStore = createStore<{ acks: Acks }>(() => ({ acks: {} }));
export const useAcks = <T,>(pick: (s: { acks: Acks }) => T): T => useStore(acksStore, pick);

export interface Actions {
  acknowledge(t: AckTargets): void;
  resolve(episodeId: number, reason: ResolveReason): Promise<ActionResult<ResolveBody>>;
}
export interface ActionDeps extends Api { timers?: Timers; retryMs?: number; now?: () => number }

export function createActions(d: ActionDeps): Actions {
  const timers = d.timers ?? (globalThis as unknown as Timers), now = d.now ?? Date.now;
  const retryMs = d.retryMs ?? 1000; // ADR 0017 (Proposed): the design gives no retry time
  const mark = (ids: number[], ts: number, confirmed: boolean) => acksStore.setState((s) => ({ acks: { ...s.acks, ...Object.fromEntries(ids.map((i) => [i, { ts, confirmed }])) } }));
  // One call, tried again after retryMs while the host cannot be reached. Auth, conflict or a refusal stop it, and the card stays silenced.
  const run = (call: () => Promise<ActionResult<{ acknowledged_ts: number }>>, ids: number[], ts: number, onConflict?: () => void): void => {
    void call().then((r) => {
      if (r.kind === 'ok') mark(ids, r.body.acknowledged_ts, true);
      else if (r.kind === 'gone') mark(ids, ts, true);
      else if (r.kind === 'conflict') onConflict?.();
      else if (r.kind === 'retry') timers.setTimeout(() => run(call, ids, ts, onConflict), retryMs);
    });
  };
  return {
    acknowledge(t) {
      const ts = now();
      mark([...t.alerts, ...t.episodes.flatMap((e) => e.alertIds)], ts, false);
      for (const id of t.alerts) run(() => postAlertAck(d, id), [id], ts);
      // An episode that already resolved answers 409; its alerts can still be acknowledged one by one.
      for (const e of t.episodes) run(() => postEpisodeAck(d, e.id), e.alertIds, ts, () => e.alertIds.forEach((id) => run(() => postAlertAck(d, id), [id], ts)));
    },
    resolve: (episodeId, reason) => postResolve(d, episodeId, reason),
  };
}

export const defaultActions: Actions = createActions({ fetchFn: (...a) => fetch(...a), getToken: () => window.sessionStorage.getItem(TOKEN_KEY) });
