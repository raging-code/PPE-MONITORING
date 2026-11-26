// CO trend chart logic (design 3.2). Pure: no DOM, no clock. The last 30 minutes of CO in ppm, with dotted lines at the warning and
// danger limits. Every limit comes from the snapshot constants (the generated constants only as a fallback), none is typed here.
import { CONSTANTS } from '../gen/constants.ts';

export const TREND_WINDOW_MS = 30 * 60 * 1000; // "the last 30 minutes" of 3.2, the same 30 as co_history_30m in the snapshot
const PAD = 4; // plot margin in percent of the chart height, so the top line and the bottom of the line are not cut off
export type Pt = number[]; // [ts_ms, ppm], the shape of co_history_30m

export interface TrendLimits { warn: number; danger: number; clampMax: number; gapMs: number }
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// gapMs = signal_lost_s: a node silent for longer than that breaks the line instead of joining two readings across the silence.
export function limitsFrom(c: Record<string, unknown>): TrendLimits {
  return {
    warn: num(c.co_warn_ppm, CONSTANTS.co_warn_ppm), danger: num(c.co_danger_ppm, CONSTANTS.co_danger_ppm),
    clampMax: num(c.co_clamp_max_ppm, CONSTANTS.co_clamp_max_ppm), gapMs: num(c.signal_lost_s, CONSTANTS.signal_lost_s) * 1000,
  };
}

// Adds one reading and drops everything older than 30 minutes, so a 24 h shift never grows the list. A point that is not newer than the last one is ignored.
export function appendPoint(hist: Pt[] | undefined, t: number, ppm: number): Pt[] {
  const h = hist ?? [];
  if (!Number.isFinite(t) || !Number.isFinite(ppm) || (h.length > 0 && t <= h[h.length - 1][0])) return h;
  const from = t - TREND_WINDOW_MS, i = h.findIndex((p) => p[0] >= from);
  return [...(i < 0 ? [] : h.slice(i)), [t, ppm]];
}

export interface Plot {
  segments: string[]; // SVG "x,y" point lists in a 0..100 box, one per unbroken run
  last: Pt | null; // newest point inside the window, for the number beside the title
  yWarn: number; yDanger: number; // line positions, percent from the top
  empty: boolean;
}

// y runs from 0 ppm to the larger of the danger limit and the highest reading (never above the display clamp), so the danger line is always on the chart.
export function plot(hist: Pt[] | undefined, now: number, lim: TrendLimits): Plot {
  const from = now - TREND_WINDOW_MS;
  const pts = (hist ?? []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= from && p[0] <= now).map((p): Pt => [p[0], Math.min(Math.max(p[1], 0), lim.clampMax)]);
  const top = Math.max(lim.danger, ...pts.map((p) => p[1])), y = (ppm: number) => PAD + (1 - ppm / top) * (100 - 2 * PAD);
  const runs: Pt[][] = [];
  for (const p of pts) { const r = runs[runs.length - 1]; if (r && p[0] - r[r.length - 1][0] <= lim.gapMs) r.push(p); else runs.push([p]); }
  const seg = (r: Pt[]) => (r.length === 1 ? [r[0], r[0]] : r).map((p) => `${(((p[0] - from) / TREND_WINDOW_MS) * 100).toFixed(2)},${y(p[1]).toFixed(2)}`).join(' ');
  return { segments: runs.map(seg), last: pts.length ? pts[pts.length - 1] : null, yWarn: y(lim.warn), yDanger: y(lim.danger), empty: pts.length === 0 };
}
