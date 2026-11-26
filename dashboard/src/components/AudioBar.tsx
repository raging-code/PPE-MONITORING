import { useStore } from 'zustand';
import { sirenView, type Gate } from '../audio/gate.ts';

const btn = 'min-h-11 rounded-lg bg-slate-900 px-4 text-base font-bold text-white disabled:opacity-50';

// Sound and screen state (design 3.7, 3.9): Test sound and Start monitoring, Siren ON or SIREN OFF, which tab plays, the wake lock and the hidden-tab notice.
export default function AudioBar({ gate }: { gate: Gate }) {
  const g = useStore(gate.store), view = sirenView(g);
  return (
    <section aria-label="Sound and screen" data-testid="audio-bar" className="flex flex-wrap items-center gap-3 border-b-2 border-slate-400 bg-slate-100 px-4 py-2 text-base text-slate-900">
      {view === 'locked' && (
        <>
          <p className="font-semibold">Browser siren off: click Start monitoring</p>
          <button type="button" className={btn} onClick={() => void gate.testSound()}>Test sound</button>
          <button type="button" className={btn} disabled={!g.tested} onClick={() => void gate.startMonitoring()}>Start monitoring</button>
          {!g.tested && <p>Play the test sound first.</p>}
        </>
      )}
      {view === 'on' && <p className="font-semibold">Siren ON</p>}
      {view === 'off' && <button type="button" className={btn} onClick={() => void gate.enable()}>SIREN OFF: click to enable</button>}
      {view === 'other' && <p className="font-semibold">Sound in another tab</p>}
      {g.started && g.wakeLost && <p className="font-semibold">Screen may sleep</p>}
      {g.msg && <p role="alert">{g.msg}</p>}
      {g.hiddenReturn && (
        <p role="alert" className="flex items-center gap-3 font-semibold">
          Dashboard was hidden: alarms may have been delayed
          <button type="button" className={btn} onClick={() => gate.dismissHidden()}>Dismiss</button>
        </p>
      )}
    </section>
  );
}
