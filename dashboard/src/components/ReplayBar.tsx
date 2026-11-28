import { useState } from 'react';
import { replayMessage, replayView } from '../alerts/replay.ts';
import type { ActionResult } from '../api/actions.ts';
import { authFetch } from '../api/authfetch.ts';
import { liveStore, useLive } from '../store/live.ts';
import { setReplayPaused, setReplaySpeed } from '../store/replay.ts';
import { readToken } from '../store/token.ts';

const defaultApi = { fetchFn: authFetch, getToken: readToken };
const BTN_ON_DARK = 'min-h-11 rounded-lg bg-white px-4 text-base font-bold text-ink disabled:opacity-50';
// The speed choices (S7-7b): the chosen one is a white button like Pause, the others are outlined on the dark bar. Both are at least 44 px high.
const SPEED_ON = 'min-h-11 min-w-11 rounded-lg bg-white px-3 text-base font-bold text-ink disabled:opacity-50';
const SPEED_OFF = 'min-h-11 min-w-11 rounded-lg border border-slate-400 bg-slate-800 px-3 text-base font-bold text-white disabled:opacity-50';

// Two bars drawn here, not the character U+23F8: the bundled Inter has no glyph for it and the browser shows a small square.
const PauseIcon = () => <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" className="mr-2 inline-block" fill="currentColor"><rect x="2" y="1" width="3.5" height="12" /><rect x="8.5" y="1" width="3.5" height="12" /></svg>;

// Pause or resume a REPLAY (S7-5b, ADR 0062), and choose its speed 1x, 4x or 16x (S7-7b, ADR 0065). Dark and neutral like the mode bar (3.7), never a level colour. It exists only while session.mode is REPLAY, and it cannot be dismissed.
// The state is the host's: the button asks for the opposite of what the host last said, and the words follow the host's answer.
export default function ReplayBar({ api = defaultApi }: { api?: typeof defaultApi }) {
  const mode = useLive((s) => s.session?.mode), replay = useLive((s) => s.replay), recovering = useLive((s) => s.recovering);
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const v = replayView(mode, replay);
  if (!v) return null;
  // One request at a time for both controls, so a double click or a click on the other control while one is on its way sends nothing.
  const run = async (job: () => Promise<ActionResult<unknown>>, what: 'pause' | 'speed') => {
    setBusy(true); setErr('');
    try { setErr(replayMessage(await job(), what) ?? ''); } finally { setBusy(false); }
  };
  const press = () => run(() => setReplayPaused(!v.paused, api, liveStore), 'pause');
  const pick = (speed: number) => { if (speed !== replay?.speed) void run(() => setReplaySpeed(speed, api, liveStore), 'speed'); };   // the speed it already has is not sent
  const off = v.finished || busy || recovering;
  return (
    <section aria-label="Replay control" data-testid="replay-bar" className="flex flex-wrap items-center gap-3 border-t border-slate-600 bg-slate-800 px-4 py-2 text-base font-bold text-white">
      <span role="status" data-testid="replay-state" className={v.paused ? 'text-lg' : undefined}>{v.paused && !v.finished && <PauseIcon />}{v.text}</span>
      <button type="button" disabled={off} onClick={() => void press()} className={BTN_ON_DARK}>{v.buttonLabel}</button>
      <div role="group" aria-label="Replay speed" data-testid="replay-speed" className="flex items-center gap-1">
        {v.choices.map((c) => <button key={c.speed} type="button" aria-pressed={c.selected} aria-label={c.name} data-testid={`speed-${c.speed}`} disabled={off} onClick={() => pick(c.speed)} className={c.selected ? SPEED_ON : SPEED_OFF}>{c.label}</button>)}
      </div>
      {err && <span role="alert" data-testid="replay-error" className="text-base font-semibold">{err}</span>}
    </section>
  );
}
