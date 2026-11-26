import type { StoreApi } from 'zustand/vanilla';
import { postBannerAck, type ActionResult, type Api } from '../api/actions.ts';
import type { LiveState } from './reducer.ts';

// Acknowledge a system banner. The host answers with the time; a 409 means it was already acknowledged (another tab), so it counts too.
// The host also broadcasts the acknowledgement, so every tab agrees; a reload reads it from the snapshot.
export async function ackBanner(kind: string, api: Api, store: StoreApi<LiveState>, now: () => number = Date.now): Promise<ActionResult<{ kind: string; acknowledged_ts: number }>> {
  const r = await postBannerAck(api, kind);
  if (r.kind === 'ok') store.setState((s) => ({ bannerAck: { ...s.bannerAck, [kind]: r.body.acknowledged_ts } }));
  else if (r.kind === 'conflict') store.setState((s) => ({ bannerAck: { ...s.bannerAck, [kind]: s.bannerAck[kind] ?? now() } }));
  return r;
}
export const ackMessage = (r: ActionResult<unknown>): string | null =>
  r.kind === 'ok' || r.kind === 'conflict' ? null : r.kind === 'retry' ? 'The host did not answer. Try again.' : r.kind === 'auth' ? 'Not signed in. Log in again.' : 'Not accepted by the host.';
