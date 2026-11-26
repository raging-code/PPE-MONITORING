import { useEffect, useState } from 'react';
import { CONSTANTS } from '../gen/constants.ts';
import { useLive } from '../store/live.ts';
import { TOKEN_KEY, type Controller } from '../store/controller.ts';
import type { Bridge } from '../worker/bridge.ts';
import { postLogin } from '../api/login.ts';
import LoginPage from './LoginPage.tsx';
import LiveScreen from './LiveScreen.tsx';
import NoLiveData from './NoLiveData.tsx';
import { useWd } from '../store/watchdog.ts';
import { useAudio } from '../audio/siren.ts'; // P22c-2: the gate and its bar
import type { Gate } from '../audio/gate.ts';
import AudioBar from './AudioBar.tsx'; // P22c-3: banners next
import SystemBanners, { ModeBar } from './SystemBanners.tsx'; // P22c-4: top strip next
import TopStrip from './TopStrip.tsx';

export interface ShellProps {
  controller: Pick<Controller, 'start' | 'login'>;
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
    const token = window.sessionStorage.getItem(TOKEN_KEY);
    if (token) bridge.init(token); // reload: the worker needs the token again
  }, [controller, bridge]);

  const onLogin = async (token: string) => {
    const r = await postLogin(token, fetchFn);
    if (r.kind === 'ok') { controller.login(token); bridge.init(token); }
    return r;
  };

  if (conn === 'LOGIN') return <LoginPage onLogin={onLogin} />;
  if (conn === 'FORBIDDEN') return <main className="p-8 text-xl">The host refused this page address. Open http://127.0.0.1:8420.</main>;
  if (conn === 'CONNECTING') return noData || wd.noData ? <NoLiveData sirenOn={wd.sirenOn} silenced={wd.noData && !wd.sirenOn} unlocked={unlocked} onSilence={silence} extra={bar} /> : <main className="p-8 text-xl">Connecting to the host...</main>;
  // The worker's verdict covers a quiet /ws/tick or a quiet data socket while this page still looks connected: the red screen goes over the live screen.
  // Layout (3.7): one frame the height of the window. The header (buttons, banners, sound bar) is capped and scrolls inside itself, the tray is capped at 40% and
  // scrolls inside itself, and the readings take the rest, so stacked banners can never push them off the screen.
  return <div data-testid="frame" className="flex h-dvh flex-col overflow-hidden">{!wd.noData && <header data-testid="top" className="max-h-[35dvh] shrink-0 overflow-y-auto"><TopStrip fetchFn={fetchFn}><ModeBar /><SystemBanners />{bar}</TopStrip></header>}<LiveScreen chipsInStrip fetchFn={fetchFn} />{wd.noData && <NoLiveData sirenOn={wd.sirenOn} silenced={!wd.sirenOn} unlocked={unlocked} onSilence={silence} extra={bar} />}</div>;
}
