// Ties the socket to the store and to sessionStorage. Kept free of zustand so Vitest can run it.
import { apply, initialState, type LiveState } from './reducer.ts';
import { LiveSocket, type SocketOptions } from '../net/socket.ts';

export const TOKEN_KEY = 'ppe_token';

export interface StoreLike {
  getState(): LiveState;
  setState(next: LiveState): void;
}
export interface ControllerDeps {
  store: StoreLike;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; // sessionStorage: the default home of the token
  persistent?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; // localStorage: where "remember me" keeps it (ADR 0056)
  url: string;
  socketOptions?: Partial<SocketOptions>; // tests inject create and timers
}
export interface Controller {
  start(): void;
  login(token: string, remember?: boolean): void; // remember: keep the token in the persistent storage too (a PIN login with the box ticked)
  logout(): void;
  expire(): void; // the host said 401 on a REST call: same as close code 4401
}

export function createController(d: ControllerDeps): Controller {
  let sock: LiveSocket | null = null;
  const set = (p: Partial<LiveState>) => d.store.setState({ ...d.store.getState(), ...p });
  const read = (): string | null => {
    for (const s of [d.storage, d.persistent]) { try { const v = s?.getItem(TOKEN_KEY); if (v) return v; } catch { /* blocked: try the other */ } }
    return null;
  };
  const forget = () => { for (const s of [d.storage, d.persistent]) { try { s?.removeItem(TOKEN_KEY); } catch { /* nothing more to do */ } } };
  const open = () => {
    sock?.stop();
    sock = new LiveSocket({
      url: d.url,
      getToken: read,
      onMessage: (m) => {
        const r = apply(d.store.getState(), m);
        if (!r.resync) d.store.setState(r.state);
        return r.resync;
      },
      onConnecting: () => set({ conn: 'CONNECTING' }),
      // 4401 (design 3.8): clear the stored token (sessionStorage and localStorage), drop the data of the old login and show Login.
      onAuthRejected: () => { forget(); d.store.setState(initialState('LOGIN')); },
      onForbidden: () => set({ conn: 'FORBIDDEN' }),
      ...d.socketOptions,
    });
    sock.start();
  };
  return {
    start: () => { if (read()) open(); else d.store.setState(initialState('LOGIN')); },
    login: (token, remember = false) => {
      forget(); // one token, one home
      let kept = false;
      if (remember && d.persistent) { try { d.persistent.setItem(TOKEN_KEY, token); kept = true; } catch { /* storage blocked or full: this tab only */ } }
      if (!kept) d.storage.setItem(TOKEN_KEY, token);
      open();
    },
    logout: () => { sock?.stop(); sock = null; forget(); d.store.setState(initialState('LOGIN')); },
    expire: () => { sock?.stop(); sock = null; forget(); d.store.setState(initialState('LOGIN')); },
  };
}
