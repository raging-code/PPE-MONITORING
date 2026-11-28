// Pause control of a REPLAY host (ADR 0061 host side, ADR 0062 dashboard side). Pure: no DOM, no store. The words come from here so the bar and the tests agree.
import type { ReplayInfo } from '../gen/ws.ts';
import type { ActionResult, ReplayBody } from '../api/actions.ts';

export interface ReplayView { paused: boolean; finished: boolean; speedText: string; text: string; buttonLabel: 'Pause replay' | 'Resume replay' }

// 16 -> "×16", 0.5 -> "×0.5", 2.25 -> "×2.25"
export const speedText = (speed: number): string => `×${Number.isInteger(speed) ? speed : Number(speed.toFixed(2))}`;

// The bar exists only for a REPLAY session whose host sent the replay block (an older host does not, and then there is nothing to press).
export function replayView(mode: string | undefined, replay: ReplayInfo | null | undefined): ReplayView | null {
  if (mode !== 'REPLAY' || !replay) return null;
  const sp = speedText(replay.speed);
  const text = replay.finished ? 'Replay finished' : replay.paused ? `Replay paused, ${sp}` : `Replay running, ${sp}`;
  return { paused: replay.paused, finished: replay.finished, speedText: sp, text, buttonLabel: replay.paused ? 'Resume replay' : 'Pause replay' };
}

// Words for the outcome of a press; null when it worked.
export function replayMessage(r: ActionResult<ReplayBody>): string | null {
  switch (r.kind) {
    case 'ok': return null;
    case 'conflict': return r.code === 'RECOVERING' ? 'The replay has not started yet. Try again in a moment.' : 'The replay has finished.';
    case 'auth': return 'Not signed in. Log in again.';
    case 'retry': return 'The host did not answer. Try again.';
    case 'gone': return 'The host has no replay to pause.';
    case 'bad': return `Not accepted: ${r.detail}`;
  }
}
