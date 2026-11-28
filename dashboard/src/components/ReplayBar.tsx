import { useState } from 'react';
import { replayMessage, replayView } from '../alerts/replay.ts';
import { authFetch } from '../api/authfetch.ts';
import { liveStore, useLive } from '../store/live.ts';
import { setReplayPaused } from '../store/replay.ts';
import { readToken } from '../store/token.ts';

const defaultApi = { fetchFn: authFetch, getToken: readToken };
const BTN_ON_DARK = 'min-h-11 rounded-lg bg-white px-4 text-base font-bold text-ink disabled:opacity-50';

// Two bars drawn here, not the character U+23F8: the bundled Inter has no glyph for it and the browser shows a small square.
const PauseIcon = () => <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" className="mr-2 inline-block" fill="currentColor"><rect x="2" y="1" width="3.5" height="12" /><rect x="8.5" y="1" width="3.5" height="12" /></svg>;

// Pause or resume a REPLAY (S7-5b, ADR 0062). Dark and neutral like the mode bar (3.7), never a level colour. It exists only while session.mode is REPLAY, and it cannot be dismissed.
// The state is the host's: the button asks for the opposite of what the host last said, and the words follow the host's answer.
export default function ReplayBar({ api = defaultApi }: { api?: typeof defaultApi }) {
  const mode = useLive((s) => s.session?.mode), replay = useLive((s) => s.replay), recovering = useLive((s) => s.recovering);
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const v = replayView(mode, replay);
  if (!v) return null;
  const press = async () => {
    setBusy(true); setErr('');
    try { setErr(replayMessage(await setReplayPaused(!v.paused, api, liveStore)) ?? ''); } finally { setBusy(false); }
  };
  return (
    <section aria-label="Replay control" data-testid="replay-bar" className="flex flex-wrap items-center gap-3 border-t border-slate-600 bg-slate-800 px-4 py-2 text-base font-bold text-white">
      <span role="status" data-testid="replay-state" className={v.paused ? 'text-lg' : undefined}>{v.paused && !v.finished && <PauseIcon />}{v.text}</span>
      <button type="button" disabled={v.finished || busy || recovering} onClick={() => void press()} className={BTN_ON_DARK}>{v.buttonLabel}</button>
      {err && <span role="alert" data-testid="replay-error" className="text-base font-semibold">{err}</span>}
    </section>
  );
}
