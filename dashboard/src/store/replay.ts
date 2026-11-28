import type { StoreApi } from 'zustand/vanilla';
import { postReplayPause, postReplaySpeed, type ActionResult, type Api, type ReplayBody, type ReplaySpeedBody } from '../api/actions.ts';
import type { LiveState } from './reducer.ts';

// Pause or resume the replay. The host answers with the state it now has; the store takes it at once, and the host's system message says the same to every tab,
// so a second tab agrees and a reload reads it from the snapshot. A refusal changes nothing here: the next system message or tick tells the truth.
export async function setReplayPaused(paused: boolean, api: Api, store: StoreApi<LiveState>): Promise<ActionResult<ReplayBody>> {
  const r = await postReplayPause(api, paused);
  if (r.kind === 'ok') store.setState((s) => (s.replay ? { replay: { ...s.replay, paused: r.body.paused, finished: r.body.finished } } : {}));
  return r;
}

// Choose the replay speed (S7-7b, ADR 0064). Same rule as above: the store takes the host's answer at once ({speed, paused, finished}), the system message tells every other screen,
// and a refusal changes nothing here. A speed chosen while paused is kept by the host and counts from the resume.
export async function setReplaySpeed(speed: number, api: Api, store: StoreApi<LiveState>): Promise<ActionResult<ReplaySpeedBody>> {
  const r = await postReplaySpeed(api, speed);
  if (r.kind === 'ok') store.setState((s) => (s.replay ? { replay: { speed: r.body.speed, paused: r.body.paused, finished: r.body.finished } } : {}));
  return r;
}
