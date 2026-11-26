import type { ReactNode } from 'react';

// Full-screen red state (design 3.7; the sound bar goes in `extra`). The Silence button silences the browser siren for 60 s and it sounds again after that (3.3).
export interface NoLiveDataProps { sirenOn?: boolean; silenced?: boolean; unlocked?: boolean; onSilence?: () => void; extra?: ReactNode }

export default function NoLiveData({ sirenOn = false, silenced = false, unlocked = true, onSilence, extra }: NoLiveDataProps) {
  return (
    <div role="alert" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-level-danger p-8 text-center text-white">
      <p className="text-3xl font-bold">NO LIVE DATA: responders are NOT being monitored</p>
      <p className="text-xl">Reconnecting to the host. Use the radio until this message clears.</p>
      {sirenOn && !unlocked && !extra && <p className="text-lg font-semibold">Browser siren off: click Start monitoring</p>}
      {silenced && <p className="text-lg font-semibold">Siren silenced for 60 s. It sounds again after that if this message is still showing.</p>}
      {sirenOn && onSilence && (
        <button type="button" onClick={onSilence} className="min-h-11 rounded-lg bg-slate-900 px-6 text-lg font-bold text-white">Silence 60 s</button>
      )}
      {extra}
    </div>
  );
}
