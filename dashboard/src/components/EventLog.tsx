import { useEffect, useMemo, useState } from 'react';
import { realSaveDeps, downloadCsv, type SaveDeps } from '../api/shift.ts';
import { manilaClock } from '../alerts/readings.ts';
import { aliasOf, rejectedText, rowText, SHOW_ROWS } from '../alerts/eventlog.ts';
import { useLive } from '../store/live.ts';
import { refreshLog, useLog } from '../store/eventlog.ts';
import { defaultApi } from './TopStrip.tsx';
import { BTN } from './btn.ts';

export const REFRESH_MS = 500; // wait after a live message before asking the host for the new rows, so a burst is one request

// Event log and CSV (3.1 Bottom, 3.11): alerts, state changes, operator actions and system events. Newest first, clock time only (3.10).
export default function EventLog({ fetchFn, saveDeps }: { fetchFn?: typeof fetch; saveDeps?: SaveDeps }) {
  const api = useMemo(() => defaultApi(fetchFn), [fetchFn]);
  const rows = useLog((s) => s.rows), status = useLog((s) => s.status);
  const nodes = useLive((s) => s.nodes), session = useLive((s) => s.session), rejected = useLive((s) => s.rejectedFrames);
  const alerts = useLive((s) => s.alerts), episodes = useLive((s) => s.episodes), banners = useLive((s) => s.banners), advisories = useLive((s) => s.advisories);
  const [diag, setDiag] = useState(false), [csv, setCsv] = useState('');
  useEffect(() => { void refreshLog(api); }, [api]); // after a reload or reconnect
  useEffect(() => { const h = setTimeout(() => { void refreshLog(api); }, REFRESH_MS); return () => clearTimeout(h); }, [api, alerts, episodes, banners, advisories]); // then the live messages
  const save = async () => {
    if (!session) return;
    setCsv('Preparing the CSV...');
    const r = await downloadCsv(api, session.session_id, saveDeps ?? realSaveDeps());
    setCsv(r === 'saved' ? `Saved session-${session.session_id}.csv.` : r === 'auth' ? 'Not signed in. Log in again.' : 'The CSV could not be downloaded. Try again.');
  };
  const shown = rows.slice(-SHOW_ROWS).reverse();
  return (
    <section aria-label="Event log" data-testid="event-log" className="space-y-2 rounded-card border-2 border-card-border bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Event log</h2>
        <span className="flex gap-2">
          <button type="button" className={BTN} aria-pressed={diag} onClick={() => setDiag((v) => !v)}>Diagnostics {diag ? 'on' : 'off'}</button>
          <button type="button" className={BTN} disabled={!session} onClick={() => { void save(); }}>Download CSV</button>
        </span>
      </div>
      {rejected > 0 && <p role="status" data-testid="rejected" className="m-0 text-base font-semibold">{rejectedText(rejected)}</p>}
      {csv && <p role="status" className="m-0 text-base">{csv}</p>}
      {status === 'failed' && <p role="status" className="m-0 text-base font-semibold">The event log could not be loaded. <button type="button" className={BTN} onClick={() => { void refreshLog(api); }}>Reload event log</button></p>}
      {status === 'ok' && shown.length === 0 && <p className="m-0 text-base">No events yet.</p>}
      {shown.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-base">
            <thead><tr><th className="p-1">Time (Manila)</th><th className="p-1">Responder</th><th className="p-1">Event</th>{diag && <><th className="p-1">Type</th><th className="p-1">Code</th><th className="p-1">Seq</th></>}</tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={`${r.event_seq}|${r.record_type}|${r.code}|${r.node_id}`} className="border-t border-card-border">
                <td className="p-1">{manilaClock(r.log_ts)}</td><td className="p-1">{aliasOf(r.node_id, nodes)}</td><td className="p-1">{rowText(r, nodes)}</td>
                {diag && <><td className="p-1">{r.record_type}</td><td className="p-1">{r.code}</td><td className="p-1">{r.event_seq}</td></>}
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
