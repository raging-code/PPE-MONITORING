// Reconnecting client for /ws (design 3.8). Sends auth first, hb at 1 Hz, reconnects after a drop,
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
