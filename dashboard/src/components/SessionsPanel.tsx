import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../api/actions.ts';
import { getSessions, type SessionRow } from '../api/shift.ts';
import { sessionLine } from '../alerts/shift.ts';
import { BTN } from './btn.ts';

type Load = { kind: 'loading' } | { kind: 'ok'; rows: SessionRow[] } | { kind: 'failed'; text: string };

// Sessions list (3.10): date, length, mode and alert count. It opens from the top strip, sits in normal flow like the tray, and scrolls inside itself.
export default function SessionsPanel({ api, onClose }: { api: Api; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const run = useCallback(async () => {
    setLoad({ kind: 'loading' });
    const r = await getSessions(api);
    setLoad(r.kind === 'ok' ? { kind: 'ok', rows: r.body } : { kind: 'failed', text: r.kind === 'auth' ? 'Not signed in. Log in again.' : 'The host did not answer. Try again.' });
  }, [api]);
  useEffect(() => { void run(); }, [run]);
  return (
    <section aria-label="Sessions" className="space-y-2 border-b-2 border-card-border bg-white p-3">
      <div className="flex items-center justify-between"><h2 className="text-xl font-bold">Sessions</h2><button type="button" className={BTN} onClick={onClose}>Close sessions</button></div>
      {load.kind === 'loading' && <p className="text-base">Loading sessions...</p>}
      {load.kind === 'failed' && <p role="status" className="text-base font-semibold">{load.text} <button type="button" className={BTN} onClick={() => { void run(); }}>Try again</button></p>}
      {load.kind === 'ok' && (load.rows.length === 0 ? <p className="text-base">No sessions yet.</p> : (
        <div className="max-h-[40vh] overflow-auto">
          <table className="w-full text-left text-base">
            <thead><tr><th className="p-1">Date (Manila)</th><th className="p-1">Length</th><th className="p-1">Mode</th><th className="p-1">Alerts</th><th className="p-1">Notes</th></tr></thead>
            <tbody>{load.rows.map(sessionLine).map((l) => <tr key={l.id} className="border-t border-card-border"><td className="p-1">{l.date}</td><td className="p-1">{l.length}</td><td className="p-1">{l.mode}</td><td className="p-1">{l.alerts}</td><td className="p-1">{l.notes}</td></tr>)}</tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
