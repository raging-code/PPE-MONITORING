import { useEffect, useState } from 'react';
import { CONSTANTS } from '../gen/constants.ts';
import { useLive } from '../store/live.ts';
import { TOKEN_KEY, type Controller } from '../store/controller.ts';
import type { Bridge } from '../worker/bridge.ts';
import { postLogin } from '../api/login.ts';
import LoginPage from './LoginPage.tsx';
import LiveScreen from './LiveScreen.tsx';
import NoLiveData from './NoLiveData.tsx';

export interface ShellProps {
  controller: Pick<Controller, 'start' | 'login'>;
  bridge: Bridge;
  fetchFn?: typeof fetch;
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

export default function Shell({ controller, bridge, fetchFn }: ShellProps) {
  const conn = useLive((s) => s.conn);
  const staleS = useLive((s) => Number(s.constants.dashboard_stale_s ?? CONSTANTS.dashboard_stale_s));
  const noData = useActiveFor(conn === 'CONNECTING', staleS * 1000);

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
  if (conn === 'CONNECTING') return noData ? <NoLiveData /> : <main className="p-8 text-xl">Connecting to the host...</main>;
  return <LiveScreen />;
}
