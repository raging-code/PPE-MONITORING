// Pause control of a REPLAY host (ADR 0061 host side, ADR 0062 dashboard side). Pure: no DOM, no store. The words come from here so the bar and the tests agree.
import type { ReplayInfo } from '../gen/ws.ts';
import type { ActionResult } from '../api/actions.ts';

// The speeds the host accepts (SPEEDS in host/ppe_host/services/replay.py, ADR 0064; a test compares the two lists). Only these, not a free number.
export const REPLAY_SPEEDS = [1, 4, 16] as const;
export interface SpeedChoice { speed: number; label: string; name: string; selected: boolean }

export interface ReplayView { paused: boolean; finished: boolean; speedText: string; text: string; buttonLabel: 'Pause replay' | 'Resume replay'; choices: SpeedChoice[] }

// 16 -> "×16", 0.5 -> "×0.5", 2.25 -> "×2.25"
export const speedText = (speed: number): string => `×${Number.isInteger(speed) ? speed : Number(speed.toFixed(2))}`;

// One choice per host speed, in order; the one the host reports is selected (none is when the host reports another speed). The name is what a screen reader says.
export const speedChoices = (current: number): SpeedChoice[] => REPLAY_SPEEDS.map((s) => ({ speed: s, label: speedText(s), name: `Speed ${speedText(s)}`, selected: s === current }));

// The bar exists only for a REPLAY session whose host sent the replay block (an older host does not, and then there is nothing to press).
export function replayView(mode: string | undefined, replay: ReplayInfo | null | undefined): ReplayView | null {
  if (mode !== 'REPLAY' || !replay) return null;
  const sp = speedText(replay.speed);
  const text = replay.finished ? 'Replay finished' : replay.paused ? `Replay paused, ${sp}` : `Replay running, ${sp}`;
  return { paused: replay.paused, finished: replay.finished, speedText: sp, text, buttonLabel: replay.paused ? 'Resume replay' : 'Pause replay', choices: speedChoices(replay.speed) };
}

// Words for the outcome of a press (Pause or Resume, or a speed choice since S7-7b); null when it worked.
export function replayMessage(r: ActionResult<unknown>, what: 'pause' | 'speed' = 'pause'): string | null {
  switch (r.kind) {
    case 'ok': return null;
    case 'conflict': return r.code === 'RECOVERING' ? 'The replay has not started yet. Try again in a moment.' : 'The replay has finished.';
    case 'auth': return 'Not signed in. Log in again.';
    case 'retry': return 'The host did not answer. Try again.';
    case 'gone': return what === 'speed' ? 'This host cannot change the replay speed.' : 'The host has no replay to pause.';
    case 'bad': return `Not accepted: ${r.detail}`;
  }
}
