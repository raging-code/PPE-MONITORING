import { useEffect, useState } from 'react';
import { CONSTANTS } from '../gen/constants.ts';
import { useLive } from '../store/live.ts';
import type { Controller } from '../store/controller.ts';
import { readToken } from '../store/token.ts';
import type { Bridge } from '../worker/bridge.ts';
import { postLogin, postLogout, postPinLogin } from '../api/login.ts';
import LoginPage from './LoginPage.tsx';
import LiveScreen from './LiveScreen.tsx';
import NoLiveData from './NoLiveData.tsx';
import { useWd } from '../store/watchdog.ts';
import { useAudio } from '../audio/siren.ts'; // P22c-2: the gate and its bar
import type { Gate } from '../audio/gate.ts';
import AudioBar from './AudioBar.tsx'; // P22c-3: banners next
import SystemBanners, { ModeBar } from './SystemBanners.tsx'; // P22c-4: top strip next
import ReplayBar from './ReplayBar.tsx'; // S7-5b: Pause and Resume of a REPLAY host
import TopStrip from './TopStrip.tsx';

export interface ShellProps {
  controller: Pick<Controller, 'start' | 'login'> & Partial<Pick<Controller, 'logout'>>; // logout: the Log out button shows only when there is one
  bridge: Pick<Bridge, 'init'>;
  silence?: () => void; // Silence 60 s of the NO LIVE DATA siren, sent to the worker
  fetchFn?: typeof fetch;
  gate?: Gate; // Test sound and Start monitoring (P22c-2)
}

// True once active has been true for ms without a break.
function useActiveFor(active: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) { setLate(false); return; }
    const h = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(h);
  }, [active, ms]);
  return late;
}

export default function Shell({ controller, bridge, silence, fetchFn, gate }: ShellProps) {
  const conn = useLive((s) => s.conn);
  const staleS = useLive((s) => Number(s.constants.dashboard_stale_s ?? CONSTANTS.dashboard_stale_s));
  const noData = useActiveFor(conn === 'CONNECTING', staleS * 1000);
  const wd = useWd((s) => s), unlocked = useAudio((s) => s.unlocked), bar = gate ? <AudioBar gate={gate} /> : null;

  useEffect(() => {
    controller.start(); // opens /ws when a token is stored, otherwise shows Login
    const token = readToken(); // sessionStorage, or localStorage after "remember me"
    if (token) bridge.init(token); // reload: the worker needs the token again
  }, [controller, bridge]);

  const onLogin = async (token: string) => {
    const r = await postLogin(token, fetchFn);
    if (r.kind === 'ok') { controller.login(token); bridge.init(token); }
    return r;
  };

  // The PIN form (ADR 0056): the host answers with a session token, which is kept and used exactly like the operator token.
  const onPinLogin = async (name: string, pin: string, remember: boolean) => {
    const r = await postPinLogin(name, pin, remember, fetchFn);
    if (r.kind === 'ok' && r.sessionToken) { controller.login(r.sessionToken, remember); bridge.init(r.sessionToken); }
    return r;
  };
  // Log out: the host ends the login session (best effort), then this page forgets the token, stops the sockets and shows Login.
  const logout = controller.logout;
  const onLogout = logout ? async () => {
    const token = readToken();
    if (token) await postLogout(token, fetchFn);
    gate?.release();
    logout();
  } : undefined;

  if (conn === 'LOGIN') return <LoginPage onLogin={onLogin} onPinLogin={onPinLogin} />;
  if (conn === 'FORBIDDEN') return <main className="p-8 text-xl">The host refused this page address. Open http://127.0.0.1:8420.</main>;
  if (conn === 'CONNECTING') return noData || wd.noData ? <NoLiveData sirenOn={wd.sirenOn} silenced={wd.noData && !wd.sirenOn} unlocked={unlocked} onSilence={silence} extra={bar} /> : <main className="p-8 text-xl">Connecting to the host...</main>;
  // The worker's verdict covers a quiet /ws/tick or a quiet data socket while this page still looks connected: the red screen goes over the live screen.
  // Layout (3.7): one frame the height of the window. The header (buttons, banners, sound bar) is capped and scrolls inside itself, the tray is capped at 40% and
  // scrolls inside itself, and the readings take the rest, so stacked banners can never push them off the screen.
  return <div data-testid="frame" className="flex h-dvh flex-col overflow-hidden">{!wd.noData && <header data-testid="top" className="max-h-[35dvh] shrink-0 overflow-y-auto"><TopStrip fetchFn={fetchFn} onLogout={onLogout}><ModeBar /><ReplayBar /><SystemBanners />{bar}</TopStrip></header>}<LiveScreen chipsInStrip fetchFn={fetchFn} />{wd.noData && <NoLiveData sirenOn={wd.sirenOn} silenced={!wd.sirenOn} unlocked={unlocked} onSilence={silence} extra={bar} />}</div>;
}
