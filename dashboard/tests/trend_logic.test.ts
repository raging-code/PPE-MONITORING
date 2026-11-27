// Requirements: REQ-UI-008
import { describe, it, expect } from 'vitest';
import { appendPoint, limitsFrom, plot, TREND_WINDOW_MS as W, type TrendLimits } from '../src/alerts/trend.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const L: TrendLimits = { warn: 35, danger: 200, clampMax: 500, gapMs: 15000 };
const NOW = 10 * W;
const msg = (m: unknown) => m as ServerMessage;
const reading = (seq: number, over: Record<string, unknown> = {}) => ({ v: 1, type: 'reading', srv_seq: seq, srv_ts: 2000 + seq, node_id: 1, alias: 'FF-01', rx_ts: 1000 + seq * 2000, co_ppm: 52,
  co_over_range: 0, co_validity: 'VALID', co_reason: null, temp_c: 33, hum_pct: 40, motion_g: 0.1, posture: 'UPRIGHT', stillness_s: 0, bat_pct: 80, scba: 1, mandown: 0,
  level: 'NORMAL', reasons: [], seq_class: 'fresh', rssi: -80, snr: 7, status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0, ...over });

describe('limitsFrom: the lines come from the snapshot constants', () => {
  it('prefers the snapshot over the generated constants, and falls back when a key is missing or not a number', () => {
    expect(limitsFrom({ co_warn_ppm: 42, co_danger_ppm: 180, co_clamp_max_ppm: 400, signal_lost_s: 9 })).toEqual({ warn: 42, danger: 180, clampMax: 400, gapMs: 9000 });
    expect(limitsFrom({})).toEqual(L);
    expect(limitsFrom({ co_warn_ppm: 'x', co_danger_ppm: null }).warn).toBe(35);
  });
});

describe('appendPoint: 30 minutes, newest last', () => {
  it('adds a point, drops points older than 30 minutes, ignores a point that is not newer or not a number', () => {
    let h = appendPoint(undefined, 1000, 10);
    h = appendPoint(h, 1000 + W, 11); expect(h).toEqual([[1000, 10], [1000 + W, 11]]); // exactly 30 minutes old stays
    h = appendPoint(h, 1001 + W, 12); expect(h.map((p) => p[1])).toEqual([11, 12]);
    expect(appendPoint(h, 1001 + W, 99)).toBe(h); expect(appendPoint(h, 5, 99)).toBe(h); expect(appendPoint(h, 2 + W * 2, NaN)).toBe(h);
  });
  it('a 24 h shift of 2 s readings never holds more than 30 minutes of points', () => {
    let h: number[][] = [];
    for (let t = 0; t < 24 * 3600 * 1000; t += 2000) h = appendPoint(h, t, 5);
    expect(h.length).toBeLessThanOrEqual(W / 2000 + 1);
  });
});

describe('plot', () => {
  it('draws one run, 0 at the left edge of the window and the newest point at the right edge', () => {
    const p = plot([[NOW - W, 10], [NOW, 20]], NOW, { ...L, gapMs: 2 * W }); // a wide gap limit: the two ends are one run here
    expect(p.segments).toHaveLength(1); expect(p.segments[0].startsWith('0.00,')).toBe(true); expect(p.segments[0].split(' ')[1].startsWith('100.00,')).toBe(true);
    expect(p.last).toEqual([NOW, 20]); expect(p.empty).toBe(false);
  });
  it('keeps only the last 30 minutes and nothing from the future', () => {
    const p = plot([[NOW - W - 1, 5], [NOW - 1000, 6], [NOW + 1000, 7]], NOW, L);
    expect(p.last).toEqual([NOW - 1000, 6]); expect(p.segments[0].split(' ')).toHaveLength(2); // one point is drawn as a dot (the point twice)
  });
  it('the danger line is the top of the chart while readings stay below it, and the warning line sits in proportion', () => {
    const p = plot([[NOW, 12]], NOW, L);
    expect(p.yDanger).toBe(4); expect(p.yWarn).toBeCloseTo(4 + (1 - 35 / 200) * 92, 5);
  });
  it('a reading above the danger limit stretches the axis, so the danger line moves down', () => {
    const p = plot([[NOW, 400]], NOW, L);
    expect(p.yDanger).toBeCloseTo(4 + (1 - 200 / 400) * 92, 5); expect(p.segments[0].endsWith(',4.00')).toBe(true);
  });
  it('a reading above the display clamp is drawn at the clamp (500 ppm)', () => {
    expect(plot([[NOW, 900]], NOW, L).last).toEqual([NOW, 500]);
  });
  it('the line positions follow the limits it is given, none is typed in the function', () => {
    const p = plot([[NOW, 5]], NOW, { ...L, warn: 100, danger: 400 });
    expect(p.yWarn).toBeCloseTo(4 + 0.75 * 92, 5); expect(p.yDanger).toBe(4);
  });
  it('a silence longer than signal_lost_s breaks the line, a shorter one does not', () => {
    expect(plot([[NOW - 40000, 5], [NOW - 20000, 6], [NOW, 7]], NOW, L).segments).toHaveLength(3);
    expect(plot([[NOW - 30000, 5], [NOW - 15000, 6], [NOW, 7]], NOW, L).segments).toHaveLength(1);
  });
  it('no history is empty, not a line at 0 ppm', () => {
    for (const h of [undefined, [], [[NOW - W - 5, 9]]]) { const p = plot(h, NOW, L); expect(p.empty).toBe(true); expect(p.segments).toEqual([]); expect(p.last).toBeNull(); }
  });
});

describe('the store follows live readings (3.2)', () => {
  const live = () => apply(initialState('CONNECTING'), msg(snapshot({ co_history_30m: { '1': [[900, 12]] } }))).state;
  it('a reading adds a point to the snapshot history of its node', () => {
    const s = apply(live(), msg(reading(1))).state;
    expect(s.coHistory['1']).toEqual([[900, 12], [3000, 52]]);
  });
  it('an UNRELIABLE CO and a duplicate frame add no point, but the node still updates', () => {
    const a = apply(live(), msg(reading(1, { co_validity: 'UNRELIABLE', co_ppm: 0 }))).state;
    expect(a.coHistory['1']).toEqual([[900, 12]]); expect(a.nodes[1].co_validity).toBe('UNRELIABLE');
    const b = apply(a, msg(reading(2, { seq_class: 'duplicate' }))).state;
    expect(b.coHistory['1']).toEqual([[900, 12]]); expect(b.lastSeq).toBe(2);
  });
  it('a new snapshot replaces the history, so a reconnect redraws from the host', () => {
    const s = apply(apply(live(), msg(reading(1))).state, msg(snapshot({ epoch: 'e2', co_history_30m: { '1': [[950, 3]] } }))).state;
    expect(s.coHistory['1']).toEqual([[950, 3]]);
  });
});
