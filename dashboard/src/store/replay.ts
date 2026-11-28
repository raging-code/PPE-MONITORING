import type { StoreApi } from 'zustand/vanilla';
import { postReplayPause, type ActionResult, type Api, type ReplayBody } from '../api/actions.ts';
import type { LiveState } from './reducer.ts';

// Pause or resume the replay. The host answers with the state it now has; the store takes it at once, and the host's system message says the same to every tab,
// so a second tab agrees and a reload reads it from the snapshot. A refusal changes nothing here: the next system message or tick tells the truth.
export async function setReplayPaused(paused: boolean, api: Api, store: StoreApi<LiveState>): Promise<ActionResult<ReplayBody>> {
  const r = await postReplayPause(api, paused);
  if (r.kind === 'ok') store.setState((s) => (s.replay ? { replay: { ...s.replay, paused: r.body.paused, finished: r.body.finished } } : {}));
  return r;
}
