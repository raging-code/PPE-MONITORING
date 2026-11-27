import type { WsLike, Timers } from '../src/net/socket.ts';

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
  banners: { base_offline: false, logging_fault: false, host_gap: null, host_power: 'ac', audio_fault: false, abi_mismatch: false },
  constants: { co_warn_ppm: 35.0 }, ...over,
});
export const tick = (seq: number) => ({ v: 1, type: 'tick', srv_seq: seq, srv_ts: 1000 + seq * 1000 });
export const alert = (seq: number, over: Record<string, unknown> = {}) => ({
  v: 1, type: 'alert', srv_seq: seq, srv_ts: 1000 + seq * 1000, alert_id: 7, node_id: 1, alert_type: 'man_down', level: 'DANGER',
  reasons: null, authenticated: 1, episode_id: 3, raised_ts: 1500, cleared_ts: null, acknowledged_ts: null,
  acknowledged_by: null, unauth_count: null, last_seen_ts: null, ...over,
});
