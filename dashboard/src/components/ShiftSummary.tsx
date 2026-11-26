import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../api/actions.ts';
import { downloadCsv, getSessions, realSaveDeps, type SaveDeps, type SessionRow } from '../api/shift.ts';
import { buildSummary } from '../alerts/shift.ts';
import { levelView } from '../alerts/style.ts';
import { useLive } from '../store/live.ts';
import { cn } from '../lib/utils.ts';
import { BTN } from './btn.ts';

export interface ShiftSummaryProps { api: Api; closedId: number; backupOk: boolean; onClose: () => void; saveDeps?: SaveDeps }

// The one-screen summary after End shift (3.10). It sits in normal flow above the live screen and covers nothing: monitoring continues in the new session.
export default function ShiftSummary({ api, closedId, backupOk, onClose, saveDeps }: ShiftSummaryProps) {
  const roster = useLive((s) => s.roster);
  const [row, setRow] = useState<SessionRow | null>(null), [failed, setFailed] = useState(false), [csv, setCsv] = useState<string | null>(null);
  const load = useCallback(async () => {
    setFailed(false);
    const r = await getSessions(api, 10);
    const found = r.kind === 'ok' ? r.body.find((x) => x.session_id === closedId) : undefined;
    if (found) setRow(found); else setFailed(true);
  }, [api, closedId]);
  useEffect(() => { void load(); }, [load]);
  const sum = row ? buildSummary(row, backupOk, roster) : null;
  const save = async () => {
    setCsv('Preparing the CSV...');
    const r = await downloadCsv(api, closedId, saveDeps ?? realSaveDeps());
    setCsv(r === 'saved' ? `Saved session-${closedId}.csv.` : r === 'auth' ? 'Not signed in. Log in again.' : 'The CSV could not be downloaded. Try again.');
  };
  return (
    <section aria-label="Shift summary" className="space-y-2 border-b-2 border-card-border bg-white p-3">
      <div className="flex items-center justify-between"><h2 className="text-xl font-bold">Shift ended</h2><button type="button" className={BTN} onClick={onClose}>Close summary</button></div>
      <p className="text-base">Monitoring continues in the new session. Open alerts and episodes carried over.</p>
      <p className={cn('text-base font-semibold', !backupOk && 'text-level-danger')}>{sum ? sum.backup : backupOk ? 'Backup saved' : 'Backup FAILED. The shift data is still on the host.'}</p>
      {sum && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-base">
          <dt className="font-semibold">Duration</dt><dd>{sum.duration}</dd>
          <dt className="font-semibold">Alerts raised</dt><dd>{sum.alerts}</dd>
          <dt className="font-semibold">Unresolved episodes</dt><dd>{sum.unresolved}</dd>
          <dt className="font-semibold">Highest level</dt>
          <dd><ul>{sum.perNode.map((n) => <li key={n.alias}>{n.alias}: {n.level === null ? <span className="text-stale-text">No warning or danger</span> : <span className={cn('rounded px-1 font-semibold', levelView(n.level).box)}>{levelView(n.level).icon} {levelView(n.level).word}</span>}</li>)}</ul></dd>
        </dl>
      )}
      {failed && <p role="status" className="text-base font-semibold">The figures could not be loaded. <button type="button" className={BTN} onClick={() => { void load(); }}>Try again</button></p>}
      {!sum && !failed && <p className="text-base">Loading the figures...</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN} onClick={() => { void save(); }}>Download CSV</button>
        {csv !== null && <span role="status" className="text-base font-semibold">{csv}</span>}
      </div>
    </section>
  );
}
