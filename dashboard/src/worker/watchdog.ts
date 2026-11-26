// NO LIVE DATA judgement (design 3.7, 3.9). Pure: no DOM, no timers, no socket. Times are one monotonic clock in ms.
// Alive means BOTH the worker's own /ws/tick socket and the main thread's /ws data socket delivered within staleMs.
// A tick whose server time jumped by staleMs or more since the previous one proves the host stalled, so it does not count.
export const SILENCE_MS = 60_000; // design 3.3: NO LIVE DATA has a 60 s local silence (no constants.json key: ADR 0019)

export interface Verdict { noData: boolean; sirenOn: boolean; outage: { startedAt: number; endedAt: number } | null }

export class Watchdog {
  private tickAt = 0;
  private dataAt = 0;
  private srv: number | null = null;
  private armed = false;
  private bad = false;
  private badStart = 0;
  private silencedUntil: number | null = null;
  constructor(private staleMs: number, private silenceMs = SILENCE_MS) {}

  /** Login or reload: the 4 s count starts now, so a host that never answers raises NO LIVE DATA too. */
  arm(now: number): void { this.armed = true; this.tickAt = now; this.dataAt = now; this.srv = null; }
  disarm(): void { this.armed = false; this.bad = false; this.silencedUntil = null; }
  tick(srvTs: number, now: number): void {
    if (!this.armed) return;
    const gap = this.srv !== null && srvTs - this.srv >= this.staleMs;
    this.srv = srvTs;
    if (!gap) this.tickAt = now;
  }
  data(now: number): void { if (this.armed) this.dataAt = now; }
  /** Silence 60 s: only while NO LIVE DATA is showing. It re-arms by itself. */
  silence(now: number): void { if (this.bad) this.silencedUntil = now + this.silenceMs; }

  check(now: number): Verdict {
    const stale = this.armed && (now - this.tickAt >= this.staleMs || now - this.dataAt >= this.staleMs);
    let outage: Verdict['outage'] = null;
    if (stale && !this.bad) { this.bad = true; this.badStart = Math.min(this.tickAt, this.dataAt); }
    if (!stale && this.bad) { this.bad = false; this.silencedUntil = null; outage = { startedAt: this.badStart, endedAt: now }; }
    if (this.silencedUntil !== null && now >= this.silencedUntil) this.silencedUntil = null;
    return { noData: this.bad, sirenOn: this.bad && this.silencedUntil === null, outage };
  }
}
