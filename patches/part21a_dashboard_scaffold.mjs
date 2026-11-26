// patches/part21a_dashboard_scaffold.mjs  (run from repo root: node patches/part21a_dashboard_scaffold.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
const putB64 = (p, b64) => put(p, Buffer.from(b64, 'base64').toString('utf8'));
const replace = (p, oldStr, newStr) => plan.push({ op: 'replace', p, oldStr, newStr });
const append = (p, text) => plan.push({ op: 'append', p, text });
function apply() {
  const state = new Map(), log = [];
  const get = (p) => state.has(p) ? state.get(p) : (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && cur !== s.content && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : cur === s.content ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) {
      throw new Error(`MISSING file: ${s.p}`);
    } else if (s.op === 'replace') {
      const n = cur.split(s.oldStr).length - 1;
      if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
      else if (n === 0 && cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else throw new Error(`ANCHOR found ${n} times in ${s.p}: ${s.oldStr.slice(0, 60)}`);
    } else if (s.op === 'append') {
      if (cur.includes(s.text)) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : '\n') + s.text); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : `OK: ${state.size} file(s) written`);
}
try { await run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }

// ---- write only this part below ----
async function run() {
  put('dashboard/package.json', String.raw`{
  "name": "ppe-dashboard",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fontsource-variable/inter": "^5.2.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "tailwind-merge": "^3.3.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.0",
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^5.0.0",
    "jsdom": "^26.1.0",
    "tailwindcss": "^4.1.0",
    "typescript": "~5.8.3",
    "vite": "^7.0.0",
    "vitest": "^3.2.0"
  }
}
`);
  put('dashboard/tsconfig.json', String.raw`{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": ["vite/client"],
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "tests", "vite.config.ts"]
}
`);
  put('dashboard/vite.config.ts', String.raw`import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The host only accepts Origin and Host 127.0.0.1:8420 or localhost:8420 (design 4, ADR 0008),
// so the dev proxy rewrites both. In production the host serves the built files itself.
const HOST = '127.0.0.1:8420';
const asHost = { Origin: 'http://' + HOST };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    proxy: {
      '/api': { target: 'http://' + HOST, changeOrigin: true, headers: asHost },
      '/ws': { target: 'ws://' + HOST, ws: true, changeOrigin: true, headers: asHost },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.{ts,tsx}'] },
});
`);
  put('dashboard/index.html', String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PPE Monitoring</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`);
  put('dashboard/components.json', String.raw`{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "", "css": "src/index.css", "baseColor": "slate", "cssVariables": true },
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" },
  "iconLibrary": "lucide"
}
`);
  put('dashboard/src/index.css', String.raw`@import '@fontsource-variable/inter';
@import 'tailwindcss';

/* Design 3.6 (Proposed): colours and type. Levels use only these three hues; buttons are slate. */
@theme {
  --font-sans: 'Inter Variable', system-ui, sans-serif;
  --color-page: #f7f8fa;
  --color-card-border: #e5e7eb;
  --color-ink: #111827;
  --color-level-normal: #15803d;
  --color-level-warning: #facc15;
  --color-level-danger: #b91c1c;
  --color-stale-text: #6b7280;
  --color-stale-fill: #e5e7eb;
  --radius-card: 14px;
}

body { margin: 0; background: var(--color-page); color: var(--color-ink); font-size: 16px; font-variant-numeric: tabular-nums; }
`);
  put('dashboard/src/lib/utils.ts', String.raw`import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
`);
  put('dashboard/src/main.tsx', String.raw`import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`);
  put('dashboard/src/App.tsx', String.raw`// P21a placeholder: P21b replaces this line with the Login page and the NO LIVE DATA page.
export default function App() {
  return <main className="p-4">PPE Monitoring dashboard (scaffold)</main>;
}
`);
  put('dashboard/src/store/reducer.ts', String.raw`// Pure state machine for the /ws data socket (design 3.8). No DOM, no timers, no socket.
// apply() returns resync = true when the message cannot be trusted (an increment before the
// snapshot, or a gap in srv_seq): the caller reconnects, and the host sends a snapshot first.
import type {
  AdvisoryMsg, AlertBody, Banners, EpisodeBody, NodeSnap, RosterRow, ServerMessage, SessionInfo,
} from '../gen/ws.ts';

export type Conn = 'CONNECTING' | 'LIVE' | 'LOGIN' | 'FORBIDDEN';

export interface LiveState {
  conn: Conn;
  epoch: string | null;
  lastSeq: number;
  lastSrvTs: number | null;
  recovering: boolean;
  monitoringActive: boolean;
  session: SessionInfo | null;
  roster: RosterRow[];
  nodes: Record<number, NodeSnap>;
  alerts: Record<number, AlertBody>;
  episodes: Record<number, EpisodeBody>;
  advisories: Record<number, Omit<AdvisoryMsg, 'v' | 'type' | 'srv_seq' | 'srv_ts'> & { srv_ts: number }>;
  coHistory: Record<string, number[][]>;
  banners: Banners | null;
  bannerAck: Record<string, number>;
  rejectedFrames: number;
  constants: Record<string, unknown>;
}

export function initialState(conn: Conn): LiveState {
  return {
    conn, epoch: null, lastSeq: -1, lastSrvTs: null, recovering: false, monitoringActive: false,
    session: null, roster: [], nodes: {}, alerts: {}, episodes: {}, advisories: {}, coHistory: {},
    banners: null, bannerAck: {}, rejectedFrames: 0, constants: {},
  };
}

const byId = <T,>(rows: T[], key: (r: T) => number): Record<number, T> => {
  const out: Record<number, T> = {};
  for (const r of rows) out[key(r)] = r;
  return out;
};

export function apply(s: LiveState, m: ServerMessage): { state: LiveState; resync: boolean } {
  if (m.type === 'snapshot') {
    if (m.srv_seq !== 0) return { state: s, resync: true };
    return {
      resync: false,
      state: {
        conn: 'LIVE', epoch: m.epoch, lastSeq: 0, lastSrvTs: m.srv_ts, recovering: m.recovering,
        monitoringActive: m.monitoring_active, session: m.session, roster: m.roster,
        nodes: byId(m.nodes, (n) => n.node_id), alerts: byId(m.open_alerts, (a) => a.alert_id),
        episodes: byId(m.open_episodes, (e) => e.episode_id), advisories: {},
        coHistory: m.co_history_30m, banners: m.banners, bannerAck: {}, rejectedFrames: 0,
        constants: m.constants,
      },
    };
  }
  if (s.epoch === null || m.srv_seq !== s.lastSeq + 1) return { state: s, resync: true };
  const n: LiveState = { ...s, lastSeq: m.srv_seq, lastSrvTs: m.srv_ts };
  switch (m.type) {
    case 'reading': {
      const old = s.nodes[m.node_id];
      n.nodes = {
        ...s.nodes,
        [m.node_id]: {
          link_state: 'ok', scba_correction: null, ...old, node_id: m.node_id, alias: m.alias,
          last_rx_ts: m.rx_ts, co_ppm: m.co_ppm, temp_c: m.temp_c, hum_pct: m.hum_pct,
          motion_g: m.motion_g, bat_pct: m.bat_pct, scba: m.scba, mandown: m.mandown, level: m.level,
          status2: m.status2, flags: m.flags, id_mode: m.id_mode, status3: m.status3, status4: m.status4,
          co_validity: m.co_validity, co_reason: m.co_reason,
        },
      };
      break;
    }
    case 'alert': {
      const { v, srv_seq, srv_ts, type, ...body } = m;
      const alerts = { ...s.alerts, [body.alert_id]: body };
      // Gone only when it has cleared AND someone acknowledged it: an unacknowledged cleared alert
      // stays for the card to show as "cleared" (P22).
      if (body.cleared_ts !== null && body.acknowledged_ts !== null) delete alerts[body.alert_id];
      n.alerts = alerts;
      break;
    }
    case 'episode': {
      const { v, srv_seq, srv_ts, type, ...body } = m;
      const episodes = { ...s.episodes, [body.episode_id]: body };
      if (body.state === 'RESOLVED') delete episodes[body.episode_id];
      n.episodes = episodes;
      break;
    }
    case 'link': {
      const old = s.nodes[m.node_id];
      if (old) n.nodes = { ...s.nodes, [m.node_id]: { ...old, link_state: m.state } };
      break;
    }
    case 'system': {
      n.recovering = m.recovering;
      n.rejectedFrames = m.rejected_frames;
      if (s.session) n.session = { ...s.session, session_id: m.session_id, mode: m.session_mode };
      n.banners = {
        base_offline: m.base === 'offline', logging_fault: m.logging_fault, host_gap: m.host_gap,
        host_power: m.host_power, audio_fault: m.audio_fault,
      };
      if (m.banner !== null && m.acknowledged_ts !== null) n.bannerAck = { ...s.bannerAck, [m.banner]: m.acknowledged_ts };
      break;
    }
    case 'advisory':
      n.advisories = { ...s.advisories, [m.node_id]: { node_id: m.node_id, risk: m.risk, reasons: m.reasons, action: m.action, quality: m.quality, source: m.source, srv_ts: m.srv_ts } };
      break;
    default:
      break; // tick and ml only move lastSeq and lastSrvTs
  }
  return { state: n, resync: false };
}
`);
  put('dashboard/src/net/socket.ts', String.raw`// Reconnecting client for /ws (design 3.8). Sends auth first, hb at 1 Hz, reconnects after a drop,
// a 4408, or a reducer resync. 4401 and 4403 are final: retrying cannot fix a bad token or origin.
import { SERVER_TYPES, type ServerMessage } from '../gen/ws.ts';

export interface WsLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
}
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}
export interface SocketOptions {
  url: string;
  getToken: () => string | null;
  /** Returns true when the message needs a new snapshot (gap or increment before snapshot). */
  onMessage: (m: ServerMessage) => boolean;
  onConnecting: () => void;
  onAuthRejected: () => void;
  onForbidden: () => void;
  create?: (url: string) => WsLike;
  timers?: Timers;
  reconnectMs?: number; // ADR 0013 (Proposed): no design value, defaults to 1000
  hbMs?: number; // design 3.8: the client heartbeat is 1 Hz
  now?: () => number;
}

export const HB_MS = 1000;
export const RECONNECT_MS = 1000;

const realTimers: Timers = {
  setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as number),
  setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h as number),
};

export class LiveSocket {
  badMessages = 0;
  private ws: WsLike | null = null;
  private retry: unknown = null;
  private hb: unknown = null;
  private running = false;
  private lastTs = 0;
  private o: SocketOptions;
  constructor(o: SocketOptions) { this.o = o; }

  start(): void { this.running = true; this.open(); }

  stop(): void {
    this.running = false;
    this.clear();
    const w = this.ws; this.ws = null;
    if (w) { w.onclose = null; w.onmessage = null; w.close(1000); }
  }

  private t(): Timers { return this.o.timers ?? realTimers; }
  private clear(): void {
    if (this.retry !== null) this.t().clearTimeout(this.retry);
    if (this.hb !== null) this.t().clearInterval(this.hb);
    this.retry = null; this.hb = null;
  }

  private open(): void {
    const token = this.o.getToken();
    if (!token) { this.running = false; this.o.onAuthRejected(); return; }
    this.o.onConnecting();
    const ws = (this.o.create ?? ((u: string) => new WebSocket(u) as unknown as WsLike))(this.o.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ v: 1, type: 'auth', token }));
      this.hb = this.t().setInterval(() => {
        ws.send(JSON.stringify({ v: 1, type: 'hb', srv_ts: this.lastTs || (this.o.now ?? Date.now)() }));
      }, this.o.hbMs ?? HB_MS);
    };
    ws.onmessage = (ev) => this.recv(ws, ev.data);
    ws.onclose = (ev) => this.closed(ws, ev.code);
  }

  private recv(ws: WsLike, data: unknown): void {
    if (ws !== this.ws) return;
    let m: ServerMessage;
    try {
      m = JSON.parse(String(data));
    } catch {
      this.badMessages++; return;
    }
    if (!m || (m as { v?: unknown }).v !== 1 || !(SERVER_TYPES as readonly string[]).includes(m.type)) {
      this.badMessages++; return; // an unknown schema version or type is rejected (design 8)
    }
    this.lastTs = m.srv_ts;
    if (this.o.onMessage(m)) this.reconnect(0);
  }

  private reconnect(delay: number): void {
    this.clear();
    const w = this.ws; this.ws = null;
    if (w) { w.onclose = null; w.onmessage = null; w.close(1000); }
    this.o.onConnecting();
    this.retry = this.t().setTimeout(() => { this.retry = null; if (this.running) this.open(); }, delay);
  }

  private closed(ws: WsLike, code: number): void {
    if (ws !== this.ws) return;
    this.clear(); this.ws = null;
    if (!this.running) return;
    if (code === 4401) { this.running = false; this.o.onAuthRejected(); return; }
    if (code === 4403) { this.running = false; this.o.onForbidden(); return; }
    this.reconnect(this.o.reconnectMs ?? RECONNECT_MS); // 4408, 1000 (host restart), 1006 and the rest
  }
}
`);
  put('dashboard/src/store/controller.ts', String.raw`// Ties the socket to the store and to sessionStorage. Kept free of zustand so Vitest can run it.
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
`);
  put('dashboard/src/store/live.ts', String.raw`import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { createController } from './controller.ts';
import { initialState, type LiveState } from './reducer.ts';

export const liveStore = createStore<LiveState>(() => initialState('CONNECTING'));
export const useLive = <T,>(pick: (s: LiveState) => T): T => useStore(liveStore, pick);

export const controller = createController({
  store: liveStore,
  storage: window.sessionStorage,
  url: (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws',
});
`);
  put('dashboard/tests/helpers.ts', String.raw`import type { WsLike, Timers } from '../src/net/socket.ts';

export class FakeWs implements WsLike {
  sent: string[] = [];
  closed: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  send(d: string) { this.sent.push(d); }
  close(code?: number) { this.closed = code ?? 1000; }
  open() { this.onopen?.(); }
  push(m: unknown) { this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) }); }
  drop(code: number) { this.onclose?.({ code }); }
}

// Manual clock: tick(ms) runs due timers in order.
export class FakeTimers implements Timers {
  now = 0;
  private seq = 0;
  private jobs = new Map<number, { at: number; fn: () => void; every: number | null }>();
  setTimeout(fn: () => void, ms: number) { this.jobs.set(++this.seq, { at: this.now + ms, fn, every: null }); return this.seq; }
  setInterval(fn: () => void, ms: number) { this.jobs.set(++this.seq, { at: this.now + ms, fn, every: ms }); return this.seq; }
  clearTimeout(h: unknown) { this.jobs.delete(h as number); }
  clearInterval(h: unknown) { this.jobs.delete(h as number); }
  tick(ms: number) {
    const end = this.now + ms;
    for (;;) {
      let best: [number, { at: number; fn: () => void; every: number | null }] | null = null;
      for (const e of this.jobs) if (e[1].at <= end && (!best || e[1].at < best[1].at)) best = e;
      if (!best) break;
      this.now = best[1].at;
      if (best[1].every === null) this.jobs.delete(best[0]); else best[1].at += best[1].every;
      best[1].fn();
    }
    this.now = end;
  }
}

export const snapshot = (over: Record<string, unknown> = {}) => ({
  v: 1, type: 'snapshot', epoch: 'e1', srv_seq: 0, srv_ts: 1000, recovering: false, monitoring_active: true,
  session: { session_id: 4, started_ts: 1, mode: 'LIVE', session_label: 'shift-1' },
  roster: [{ node_id: 1, alias: 'FF-01', active: 1 }],
  nodes: [{ node_id: 1, alias: 'FF-01', last_rx_ts: 900, co_ppm: 12, temp_c: 31.2, hum_pct: 44, motion_g: 0.08, bat_pct: 86,
    scba: 1, mandown: 0, level: 'NORMAL', link_state: 'ok', status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0,
    co_validity: 'VALID', co_reason: null, scba_correction: null }],
  open_alerts: [], open_episodes: [], co_history_30m: { '1': [[900, 12]] },
  banners: { base_offline: false, logging_fault: false, host_gap: null, host_power: 'ac', audio_fault: false },
  constants: { co_warn_ppm: 35.0 }, ...over,
});
export const tick = (seq: number) => ({ v: 1, type: 'tick', srv_seq: seq, srv_ts: 1000 + seq * 1000 });
export const alert = (seq: number, over: Record<string, unknown> = {}) => ({
  v: 1, type: 'alert', srv_seq: seq, srv_ts: 1000 + seq * 1000, alert_id: 7, node_id: 1, alert_type: 'man_down', level: 'DANGER',
  reasons: null, authenticated: 1, episode_id: 3, raised_ts: 1500, cleared_ts: null, acknowledged_ts: null,
  acknowledged_by: null, unauth_count: null, last_seen_ts: null, ...over,
});
`);
  put('dashboard/tests/reducer.test.ts', String.raw`import { describe, it, expect } from 'vitest';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot, tick, alert } from './helpers.ts';

const msg = (m: unknown) => m as ServerMessage;
const live = () => apply(initialState('CONNECTING'), msg(snapshot())).state;

describe('reducer (design 3.8)', () => {
  it('a snapshot fills the state and starts srv_seq at 0', () => {
    const s = live();
    expect(s.conn).toBe('LIVE');
    expect(s.epoch).toBe('e1');
    expect(s.lastSeq).toBe(0);
    expect(s.nodes[1].alias).toBe('FF-01');
    expect(s.constants.co_warn_ppm).toBe(35.0);
  });
  it('an increment before any snapshot asks for a resync and changes nothing', () => {
    const s0 = initialState('CONNECTING');
    const r = apply(s0, msg(tick(1)));
    expect(r.resync).toBe(true);
    expect(r.state).toBe(s0);
  });
  it('a gap in srv_seq asks for a resync and keeps the old state', () => {
    const s = live();
    const r = apply(s, msg(tick(2)));
    expect(r.resync).toBe(true);
    expect(r.state).toBe(s);
  });
  it('a duplicate or older srv_seq is also a resync', () => {
    const s1 = apply(live(), msg(tick(1))).state;
    expect(apply(s1, msg(tick(1))).resync).toBe(true);
  });
  it('a snapshot with srv_seq other than 0 is refused', () => {
    expect(apply(initialState('CONNECTING'), msg(snapshot({ srv_seq: 5 }))).resync).toBe(true);
  });
  it('a second snapshot (reconnect) replaces everything', () => {
    let s = apply(live(), msg(alert(1))).state;
    expect(Object.keys(s.alerts)).toEqual(['7']);
    s = apply(s, msg(snapshot({ epoch: 'e2' }))).state;
    expect(s.epoch).toBe('e2');
    expect(s.lastSeq).toBe(0);
    expect(Object.keys(s.alerts)).toEqual([]);
  });
  it('a reading updates the node and keeps its link state', () => {
    const r = { v: 1, type: 'reading', srv_seq: 1, srv_ts: 2000, node_id: 1, alias: 'FF-01', rx_ts: 1990, co_ppm: 52, co_over_range: 0,
      co_validity: 'VALID', co_reason: null, temp_c: 33, hum_pct: 40, motion_g: 0.1, posture: 'UPRIGHT', stillness_s: 0, bat_pct: 80,
      scba: 1, mandown: 0, level: 'WARNING', reasons: ['co'], seq_class: 'fresh', rssi: -80, snr: 7, status2: 0, flags: 1, id_mode: 73, status3: 0, status4: 0 };
    const s = apply(live(), msg(r)).state;
    expect(s.nodes[1].co_ppm).toBe(52);
    expect(s.nodes[1].level).toBe('WARNING');
    expect(s.nodes[1].link_state).toBe('ok');
    expect(s.lastSeq).toBe(1);
  });
  it('an alert is kept until it has cleared and been acknowledged', () => {
    let s = apply(live(), msg(alert(1))).state;
    expect(s.alerts[7].level).toBe('DANGER');
    s = apply(s, msg(alert(2, { cleared_ts: 1600 }))).state;
    expect(s.alerts[7].cleared_ts).toBe(1600); // cleared but unacknowledged: stays
    s = apply(s, msg(alert(3, { cleared_ts: 1600, acknowledged_ts: 1700, acknowledged_by: 1 }))).state;
    expect(s.alerts[7]).toBeUndefined();
  });
  it('an episode is dropped when it is RESOLVED', () => {
    const ep = (seq: number, state: string) => ({ v: 1, type: 'episode', srv_seq: seq, srv_ts: 1000 + seq, episode_id: 3, node_id: 1, kind: 'MAN_DOWN',
      state, man_down_motion_state: 'no_response', resolve_reason: state === 'RESOLVED' ? 'rescued' : null, operator: null });
    let s = apply(live(), msg(ep(1, 'OPEN'))).state;
    expect(s.episodes[3].state).toBe('OPEN');
    s = apply(s, msg(ep(2, 'RESOLVED'))).state;
    expect(s.episodes[3]).toBeUndefined();
  });
  it('a link message changes only that node', () => {
    const l = { v: 1, type: 'link', srv_seq: 1, srv_ts: 2000, node_id: 1, state: 'signal_lost', since_ts: 1900, last_state: 'ok' };
    expect(apply(live(), msg(l)).state.nodes[1].link_state).toBe('signal_lost');
  });
  it('a system message sets banners and records a banner acknowledgement', () => {
    const sys = { v: 1, type: 'system', srv_seq: 1, srv_ts: 2000, base: 'offline', recovering: false, session_id: 4, session_mode: 'LIVE', rejected_frames: 3,
      logging_fault: true, host_gap: null, host_power: 'ac', audio_fault: false, banner: 'logging_fault', acknowledged_ts: 1999 };
    const s = apply(live(), msg(sys)).state;
    expect(s.banners?.base_offline).toBe(true);
    expect(s.banners?.logging_fault).toBe(true);
    expect(s.rejectedFrames).toBe(3);
    expect(s.bannerAck.logging_fault).toBe(1999);
  });
  it('tick only moves the counters', () => {
    const s = apply(live(), msg(tick(1))).state;
    expect(s.lastSeq).toBe(1);
    expect(s.lastSrvTs).toBe(2000);
  });
});
`);
  put('dashboard/tests/socket.test.ts', String.raw`import { describe, it, expect } from 'vitest';
import { LiveSocket } from '../src/net/socket.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { FakeWs, FakeTimers, snapshot, tick } from './helpers.ts';

function rig(token: string | null = 'tok', resync: (m: ServerMessage) => boolean = () => false) {
  const sockets: FakeWs[] = [];
  const timers = new FakeTimers();
  const log: string[] = [];
  const got: ServerMessage[] = [];
  const s = new LiveSocket({
    url: 'ws://x/ws', getToken: () => token, timers, reconnectMs: 1000, hbMs: 1000, now: () => 5,
    create: () => { const w = new FakeWs(); sockets.push(w); return w; },
    onMessage: (m) => { got.push(m); return resync(m); },
    onConnecting: () => log.push('connecting'), onAuthRejected: () => log.push('auth'), onForbidden: () => log.push('forbidden'),
  });
  return { s, sockets, timers, log, got };
}

describe('LiveSocket (design 3.8, close codes)', () => {
  it('sends auth as the first message and then hb every second', () => {
    const r = rig(); r.s.start(); r.sockets[0].open();
    expect(JSON.parse(r.sockets[0].sent[0])).toEqual({ v: 1, type: 'auth', token: 'tok' });
    r.sockets[0].push(snapshot());
    r.timers.tick(2000);
    const hbs = r.sockets[0].sent.slice(1).map((x) => JSON.parse(x));
    expect(hbs).toHaveLength(2);
    expect(hbs[0]).toEqual({ v: 1, type: 'hb', srv_ts: 1000 });
  });
  it('close 4401 reports a rejected login and never reconnects', () => {
    const r = rig(); r.s.start(); r.sockets[0].open(); r.sockets[0].drop(4401);
    r.timers.tick(10000);
    expect(r.log).toEqual(['connecting', 'auth']);
    expect(r.sockets).toHaveLength(1);
  });
  it('close 4403 is final too', () => {
    const r = rig(); r.s.start(); r.sockets[0].open(); r.sockets[0].drop(4403);
    r.timers.tick(10000);
    expect(r.log).toEqual(['connecting', 'forbidden']);
    expect(r.sockets).toHaveLength(1);
  });
  it('close 4408 reconnects after the delay and authenticates again', () => {
    const r = rig(); r.s.start(); r.sockets[0].open(); r.sockets[0].drop(4408);
    expect(r.sockets).toHaveLength(1);
    r.timers.tick(999); expect(r.sockets).toHaveLength(1);
    r.timers.tick(1); expect(r.sockets).toHaveLength(2);
    r.sockets[1].open();
    expect(JSON.parse(r.sockets[1].sent[0]).type).toBe('auth');
  });
  it('a clean close 1000 from the host and an abnormal 1006 both reconnect', () => {
    for (const code of [1000, 1006]) {
      const r = rig(); r.s.start(); r.sockets[0].open(); r.sockets[0].drop(code); r.timers.tick(1000);
      expect(r.sockets).toHaveLength(2);
    }
  });
  it('a resync request closes the socket and opens a new one', () => {
    const r = rig('tok', (m) => m.type === 'tick');
    r.s.start(); r.sockets[0].open(); r.sockets[0].push(snapshot()); r.sockets[0].push(tick(5));
    expect(r.sockets[0].closed).toBe(1000);
    r.timers.tick(0); expect(r.sockets).toHaveLength(2);
    r.sockets[0].push(tick(6)); // a late message from the old socket is ignored
    expect(r.got).toHaveLength(2);
  });
  it('rejects bad JSON, an unknown v and an unknown type', () => {
    const r = rig(); r.s.start(); r.sockets[0].open();
    r.sockets[0].push('not json'); r.sockets[0].push({ v: 2, type: 'tick', srv_seq: 1, srv_ts: 1 }); r.sockets[0].push({ v: 1, type: 'nope' });
    expect(r.got).toHaveLength(0);
    expect(r.s.badMessages).toBe(3);
  });
  it('with no token it reports a rejected login without opening a socket', () => {
    const r = rig(null); r.s.start();
    expect(r.log).toEqual(['auth']);
    expect(r.sockets).toHaveLength(0);
  });
  it('stop() closes cleanly and does not reconnect', () => {
    const r = rig(); r.s.start(); r.sockets[0].open(); r.s.stop(); r.timers.tick(5000);
    expect(r.sockets[0].closed).toBe(1000);
    expect(r.sockets).toHaveLength(1);
  });
});
`);
  put('dashboard/tests/controller.test.ts', String.raw`import { describe, it, expect } from 'vitest';
import { createController, TOKEN_KEY } from '../src/store/controller.ts';
import { initialState, type LiveState } from '../src/store/reducer.ts';
import { FakeWs, FakeTimers, snapshot, tick } from './helpers.ts';

function rig(token: string | null) {
  const mem = new Map<string, string>(token ? [[TOKEN_KEY, token]] : []);
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  let st: LiveState = initialState('CONNECTING');
  const store = { getState: () => st, setState: (n: LiveState) => { st = n; } };
  const sockets: FakeWs[] = [];
  const timers = new FakeTimers();
  const c = createController({ store, storage, url: 'ws://x/ws', socketOptions: { timers, create: () => { const w = new FakeWs(); sockets.push(w); return w; } } });
  return { c, mem, sockets, timers, get: () => st };
}

describe('controller (design 3.8, P21 done-when)', () => {
  it('with no stored token it shows Login and opens no socket', () => {
    const r = rig(null); r.c.start();
    expect(r.get().conn).toBe('LOGIN');
    expect(r.sockets).toHaveLength(0);
  });
  it('login stores the token in sessionStorage and connects', () => {
    const r = rig(null); r.c.login('abc');
    expect(r.mem.get(TOKEN_KEY)).toBe('abc');
    expect(r.get().conn).toBe('CONNECTING');
    r.sockets[0].open();
    expect(JSON.parse(r.sockets[0].sent[0]).token).toBe('abc');
  });
  it('the page is LIVE only after the snapshot arrives', () => {
    const r = rig('abc'); r.c.start(); r.sockets[0].open();
    expect(r.get().conn).toBe('CONNECTING');
    r.sockets[0].push(snapshot());
    expect(r.get().conn).toBe('LIVE');
  });
  it('close 4401 clears sessionStorage, drops the data and shows Login', () => {
    const r = rig('abc'); r.c.start(); r.sockets[0].open(); r.sockets[0].push(snapshot());
    r.sockets[0].drop(4401);
    expect(r.mem.has(TOKEN_KEY)).toBe(false);
    expect(r.get().conn).toBe('LOGIN');
    expect(Object.keys(r.get().nodes)).toHaveLength(0);
  });
  it('close 4408 reconnects and the new snapshot comes first and replaces the state', () => {
    const r = rig('abc'); r.c.start(); r.sockets[0].open(); r.sockets[0].push(snapshot());
    r.sockets[0].drop(4408);
    expect(r.get().conn).toBe('CONNECTING');
    expect(r.get().nodes[1].alias).toBe('FF-01'); // stale data stays on screen meanwhile
    r.timers.tick(1000); r.sockets[1].open();
    r.sockets[1].push(snapshot({ epoch: 'e2' }));
    expect(r.get().conn).toBe('LIVE');
    expect(r.get().epoch).toBe('e2');
  });
  it('a gap in srv_seq triggers a reconnect and a fresh snapshot', () => {
    const r = rig('abc'); r.c.start(); r.sockets[0].open(); r.sockets[0].push(snapshot());
    r.sockets[0].push(tick(1)); r.sockets[0].push(tick(3)); // 2 is missing
    expect(r.sockets[0].closed).toBe(1000);
    r.timers.tick(0);
    expect(r.sockets).toHaveLength(2);
    r.sockets[1].open(); r.sockets[1].push(snapshot({ epoch: 'e1' }));
    expect(r.get().lastSeq).toBe(0);
  });
  it('logout removes the token and shows Login', () => {
    const r = rig('abc'); r.c.start(); r.c.logout();
    expect(r.mem.has(TOKEN_KEY)).toBe(false);
    expect(r.get().conn).toBe('LOGIN');
  });
});
`);
  put('docs/adr/0013.md', String.raw`# ADR 0013: Dashboard scaffold and data socket (P21a)

Status: Proposed (decided in the P21a session; confirm at the next design review).
Design: Rev 3.45 is frozen. Nothing in the frame, the migration, constants.json or ws.schema.json changes.

- **Split:** P21 is split into P21a (toolchain, store, socket client; this patch) and P21b (Login page, NO LIVE DATA page, INIT_AUTH to the Web Worker, component tests), as CODING_GUIDE Section 4 allows. P21b replaces the one placeholder line in src/App.tsx.
- **Logic is kept free of React and zustand:** store/reducer.ts (pure apply), net/socket.ts (reconnecting client with injected socket and timers) and store/controller.ts (socket, store and sessionStorage) run under plain Node, so their tests do not need a browser. store/live.ts is the only zustand file.
- **Resync rule:** the host sends a snapshot only on connect, so a gap in srv_seq, a duplicate or older srv_seq, or any increment before a snapshot makes the client close its socket and reconnect; the new snapshot replaces all state. A snapshot whose srv_seq is not 0 is refused the same way. A message with an unknown v or type, or bad JSON, is dropped and counted (badMessages).
- **Close codes:** 4401 clears sessionStorage, drops all data and shows Login, with no retry. 4403 shows a final Forbidden state, no retry. 4408, 1000 (host restart) and 1006 reconnect. While reconnecting, the old values stay in the store (stale values stay on screen, design 3.7); the page is LIVE only after a snapshot.
- **Proposed numbers, not in constants.json:** the reconnect delay is 1000 ms (RECONNECT_MS in net/socket.ts). The design gives no value. The client hb interval is 1000 ms, which is the design's "1 Hz". Please confirm or add a constant.
- **Alert and episode retention:** an alert leaves the store when it has both cleared and been acknowledged; an episode leaves when RESOLVED. A cleared, unacknowledged alert stays so P22 can show it as "cleared". P22 may also drop cleared notices by catalog class.
- **Dev proxy:** vite.config.ts proxies /api and /ws to 127.0.0.1:8420 and sets Host and Origin to that address, because the host's allowlist (ADR 0008) refuses any other Origin. Untested until the first dev run.
- **Dependency ranges** in package.json are not locked. The lockfile belongs to P27b.
- **Not done here:** the UI, the Web Worker and /ws/tick (P21b, P22c), alert text and cards (P22).
`);
  replace('justfile', '    @echo "dev: nothing to run yet"', '    Set-Location dashboard; npm run dev');
  append('docs/PROGRESS.md', '- Part 21a done: dashboard toolchain (package.json, tsconfig, vite.config.ts with the Origin-rewriting dev proxy, Tailwind theme from 3.6, shadcn components.json and cn helper, placeholder App) and the data-socket logic: store/reducer.ts (snapshot first, srv_seq gap or increment before snapshot asks for a resync, alert and episode upkeep), net/socket.ts (auth, 1 Hz hb, reconnect after 4408, 1000 and 1006, final 4401 and 4403, unknown v dropped), store/controller.ts (4401 clears sessionStorage and shows Login), store/live.ts (zustand); dashboard/tests (28 tests), docs/adr/0013.md; P21b is the Login page, NO LIVE DATA page and INIT_AUTH to the Web Worker');
}
