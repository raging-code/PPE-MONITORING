import { useMemo, useState, type ReactNode } from 'react';
import type { Api } from '../api/actions.ts';
import type { EndBody } from '../api/shift.ts';
import { openItems } from '../alerts/shift.ts';
import { useLive } from '../store/live.ts';
import { readToken } from '../store/token.ts';
import { authFetch } from '../api/authfetch.ts';
import EndShiftDialog from './EndShiftDialog.tsx';
import Chips from './Chips.tsx';
import SessionsPanel from './SessionsPanel.tsx';
import SettingsPanel from './SettingsPanel.tsx'; // S8-2b: firefighters and who wears the jacket
import ShiftSummary from './ShiftSummary.tsx';
import { BTN } from './btn.ts';

export const defaultApi = (fetchFn?: typeof fetch): Api => ({ fetchFn: fetchFn ?? authFetch, getToken: readToken });

// The top strip (3.10): the Sessions list and End shift open from here, not from the main screen. The chips of minimized alerts and the LIVE or TEST word sit here too (P22d-1).
export default function TopStrip({ fetchFn, onLogout, children }: { fetchFn?: typeof fetch; onLogout?: () => Promise<void>; children?: ReactNode }) {
  const api = useMemo(() => defaultApi(fetchFn), [fetchFn]);
  const session = useLive((s) => s.session), alerts = useLive((s) => s.alerts), episodes = useLive((s) => s.episodes), nodes = useLive((s) => s.nodes);
  const [sessions, setSessions] = useState(false), [settings, setSettings] = useState(false), [ending, setEnding] = useState(false), [ended, setEnded] = useState<EndBody | null>(null);
  const [confirmOut, setConfirmOut] = useState(false), [outBusy, setOutBusy] = useState(false); // Log out asks once: it stops monitoring on this screen
  const items = useMemo(() => openItems(alerts, episodes, nodes), [alerts, episodes, nodes]);
  return (
    <>
      <nav aria-label="Session" className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-card-border bg-white px-4 py-2">
        <span className="flex items-center gap-2">
          <span className="text-base font-semibold">{session ? (session.session_label ?? `Session ${session.session_id}`) : 'No session'}</span>
          {session && <span data-testid="mode-word" className="rounded border-2 border-ink px-2 text-base font-bold">{session.mode === 'LIVE' ? 'LIVE' : 'TEST'}</span>}
        </span>
        <span className="flex gap-2">
          <button type="button" className={BTN} aria-expanded={sessions} onClick={() => setSessions((v) => !v)}>Sessions</button>
          <button type="button" className={BTN} aria-expanded={settings} onClick={() => setSettings((v) => !v)}>Settings</button>
          <button type="button" className={BTN} onClick={() => setEnding(true)}>End shift</button>
          {onLogout && !confirmOut && <button type="button" className={BTN} onClick={() => setConfirmOut(true)}>Log out</button>}
          {onLogout && confirmOut && (
            <span role="group" aria-label="Confirm log out" className="flex flex-wrap items-center gap-2">
              <span className="text-base">This screen stops monitoring.</span>
              <button type="button" className={BTN} disabled={outBusy} onClick={() => { setOutBusy(true); void onLogout(); }}>Yes, log out</button>
              <button type="button" className={BTN} disabled={outBusy} onClick={() => setConfirmOut(false)}>Cancel</button>
            </span>
          )}
        </span>
      </nav>
      <Chips />
      {children}
      {sessions && <SessionsPanel api={api} onClose={() => setSessions(false)} />}
      {settings && <SettingsPanel api={api} onClose={() => setSettings(false)} />}
      {ended && <ShiftSummary key={ended.closed_session_id} api={api} closedId={ended.closed_session_id} backupOk={ended.backup_ok} onClose={() => setEnded(null)} />}
      {ending && <EndShiftDialog api={api} sessionId={session?.session_id ?? null} items={items} onClose={() => setEnding(false)} onEnded={(b) => { setEnding(false); setEnded(b); }} />}
    </>
  );
}
