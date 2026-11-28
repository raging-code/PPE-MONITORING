import { useEffect } from 'react';
import type { Api } from '../api/actions.ts';
import { startBlocked, useWearers } from '../store/wearers.ts';
import WearerConfirm from './WearerConfirm.tsx';
import { BTN } from './btn.ts';

// After End shift (S8-6, ADR 0075): the host has ended every jacket, so the new shift has nobody on a jacket. This asks who wears what, the same check as before Start monitoring.
// It never blocks anything (alerts and sound continue) and goes away when the operator has confirmed, or presses Not now. The readings of the new shift stay unlinked until someone is put on.
export default function NewShiftJackets({ api, onClose }: { api: Api; onClose: () => void }) {
  const blocked = useWearers(startBlocked);
  useEffect(() => { if (!blocked) onClose(); }, [blocked, onClose]);
  if (!blocked) return null;
  return (
    <section aria-label="New shift jackets" className="space-y-2 border-b-2 border-slate-400 bg-slate-100 px-4 py-2 text-base text-slate-900">
      <p className="font-semibold">The shift has ended and every jacket was taken off. Until you confirm who wears each jacket, the readings are not linked to a person.</p>
      <WearerConfirm api={api} />
      <button type="button" className={BTN} onClick={onClose}>Not now</button>
    </section>
  );
}
