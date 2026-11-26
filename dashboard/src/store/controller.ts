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
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  url: string;
  socketOptions?: Partial<SocketOptions>; // tests inject create and timers
}
export interface Controller {
  start(): void;
  login(token: string): void;
  logout(): void;
}

export function createController(d: ControllerDeps): Controller {
  let sock: LiveSocket | null = null;
  const set = (p: Partial<LiveState>) => d.store.setState({ ...d.store.getState(), ...p });
  const open = () => {
    sock?.stop();
    sock = new LiveSocket({
      url: d.url,
      getToken: () => d.storage.getItem(TOKEN_KEY),
      onMessage: (m) => {
        const r = apply(d.store.getState(), m);
        if (!r.resync) d.store.setState(r.state);
        return r.resync;
      },
      onConnecting: () => set({ conn: 'CONNECTING' }),
      // 4401 (design 3.8): clear sessionStorage, drop the data of the old login and show Login.
      onAuthRejected: () => { d.storage.removeItem(TOKEN_KEY); d.store.setState(initialState('LOGIN')); },
      onForbidden: () => set({ conn: 'FORBIDDEN' }),
      ...d.socketOptions,
    });
    sock.start();
  };
  return {
    start: () => { if (d.storage.getItem(TOKEN_KEY)) open(); else d.store.setState(initialState('LOGIN')); },
    login: (token) => { d.storage.setItem(TOKEN_KEY, token); open(); },
    logout: () => { sock?.stop(); sock = null; d.storage.removeItem(TOKEN_KEY); d.store.setState(initialState('LOGIN')); },
  };
}
