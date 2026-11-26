// P22d-1: the pure rules of the side panel (3.2, 3.10). Thresholds in these tests are test values only, never in code.
import { describe, it, expect } from 'vitest';
import { advisoryLine, lastSeenText, limitsOf, manilaClock, qualityMark, readingRows, type ReadingLimits } from '../src/alerts/readings.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { NodeSnap, ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const K: ReadingLimits = { bat_low_pct: 20, bat_warn_pct: 10, co_clamp_max_ppm: 500, mandown_still_s: 30 };
const N = (o: Partial<NodeSnap> = {}): NodeSnap => ({ node_id: 1, alias: 'FF-01', last_rx_ts: 900, co_ppm: 12, temp_c: 31.2, hum_pct: 44, motion_g: 0.08, bat_pct: 86, scba: 1, mandown: 0, level: 'NORMAL',
  link_state: 'ok', status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0, co_validity: 'VALID', co_reason: null, scba_correction: null, ...o });
const D = { posture: 'LOW_LEANING' as const, stillness_s: 12, rssi: -85, snr: 7.5 };
const row = (id: string, n = N(), d: typeof D | null = D, k = K) => readingRows(n, 1000, d ?? undefined, k).find((r) => r.id === id)!;

describe('last seen and clock (3.10)', () => {
  it('is relative under 60 s and clock time from 60 s, in Manila 24-hour time', () => {
    const t = Date.UTC(2026, 10, 26, 0, 5, 9); // 08:05:09 in Manila
    expect(lastSeenText(t, t + 4000)).toBe('4 s ago'); expect(lastSeenText(t, t + 59999)).toBe('59 s ago'); expect(lastSeenText(t, t + 60000)).toBe('08:05:09');
    expect(lastSeenText(null, t)).toBe('never'); expect(lastSeenText(t, t - 5000)).toBe('0 s ago'); // a clock step back never shows a negative age
  });
  it('midnight reads 00:05:00, never 24:05:00', () => { expect(manilaClock(Date.UTC(2026, 10, 25, 16, 5, 0))).toBe('00:05:00'); });
});

describe('the 8 reading rows (3.2)', () => {
  it('are exactly 8, in the design order, with Details last', () => {
    expect(readingRows(N(), 1000, D, K).map((r) => r.id)).toEqual(['co', 'climate', 'motion', 'battery', 'scba', 'link', 'hr', 'details']);
  });
  it('HR is "not fitted" and COHb "unavailable" in Tier 1', () => { expect(row('hr').text).toBe('HR not fitted. COHb unavailable'); });
  it('an unreliable CO shows "low confidence: CO sensor out of range" and never a number', () => {
    const r = row('co', N({ co_validity: 'UNRELIABLE', co_reason: 'co_range', co_ppm: 12 }));
    expect(r.text).toBe('low confidence: CO sensor out of range'); expect(r.tone).toBe('grey'); expect(r.text).not.toMatch(/\d/);
    expect(row('co', N({ co_validity: 'UNRELIABLE', co_reason: 'co_fault', co_ppm: 0 })).text).toBe('low confidence: CO sensor unreliable (co_fault)');
  });
  it('CO above the clamp reads 500+ and a warm-up reads "warming up"', () => {
    expect(row('co', N({ co_ppm: 520 })).text).toBe('500+ ppm'); expect(row('co', N({ co_ppm: 12.4 })).text).toBe('12 ppm');
    expect(row('co', N({ co_validity: 'DERATED' })).text).toBe('12 ppm, warming up');
  });
  it('the stillness timer is labelled "backend estimate" and its limit is the constant, not a typed 30', () => {
    expect(row('motion').text).toBe('0.08 g, still 12 s of 30 s (backend estimate)');
    expect(row('motion', N(), D, { ...K, mandown_still_s: 45 }).text).toContain('of 45 s');
    expect(row('motion', N(), null).text).toBe('0.08 g');
    const m = row('motion', N({ mandown: 1 })); expect(m.tone).toBe('danger'); expect(m.text).toContain('MAN-DOWN latched');
  });
  it('the battery warning follows the constants', () => {
    expect(row('battery', N({ bat_pct: 10 })).tone).toBe('warning'); expect(row('battery', N({ bat_pct: 11 })).tone).toBe('neutral');
    expect(row('battery', N({ bat_pct: 25 }), D, { ...K, bat_warn_pct: 30 }).text).toBe('25% LOW');
  });
  it('temperature is labelled ambient, and a temperature fault shows unknown', () => {
    expect(row('climate').text).toBe('31 °C ambient, 44 %'); expect(row('climate', N({ status2: 1 << 6 })).text).toBe('temperature unknown');
  });
  it('SCBA ON, OFF and EXPIRED; link word with last seen; Details with posture, RSSI and SNR', () => {
    expect(row('scba').text).toBe('ON'); expect(row('scba', N({ scba: 0 })).text).toBe('OFF'); expect(row('scba', N({ status3: 1 << 3 })).text).toBe('EXPIRED');
    expect(row('link').text).toBe('link OK, last seen 0 s ago'); expect(row('link', N({ link_state: 'link_lost' })).tone).toBe('grey');
    expect(row('details').text).toBe('posture low leaning, RSSI -85 dBm, SNR 7.5 dB'); expect(row('details', N(), null).text).toBe('no reading yet');
  });
  it('limitsOf takes the snapshot value first and the generated constant as fallback', () => {
    expect(limitsOf({ bat_warn_pct: 33 }).bat_warn_pct).toBe(33); expect(limitsOf({}).co_clamp_max_ppm).toBe(500);
  });
});

describe('advisory line (3.5)', () => {
  it('is one line with risk and action, quality as a word and three dots, greyed only when low', () => {
    expect(qualityMark('high')).toBe('high ●●●'); expect(qualityMark('medium')).toBe('medium ●●○'); expect(qualityMark('low')).toBe('low ●○○');
    expect(advisoryLine({ risk: 'TOXIC_ATMOSPHERE', action: 'Check air', quality: 'low' })).toEqual({ text: 'Toxic atmosphere: Check air', mark: 'low ●○○', grey: true });
    expect(advisoryLine({ risk: 'NOMINAL', action: 'None', quality: 'medium' }).grey).toBe(false);
  });
});

describe('reducer keeps what the readings carry beyond the snapshot', () => {
  const rd = (seq: number, o: Record<string, unknown> = {}) => ({ v: 1, type: 'reading', srv_seq: seq, srv_ts: 1000 + seq, node_id: 1, alias: 'FF-01', rx_ts: 1500, co_ppm: 12, co_over_range: 0, co_validity: 'VALID', co_reason: null,
    temp_c: 31, hum_pct: 44, motion_g: 0.08, posture: 'UPRIGHT', stillness_s: 7, bat_pct: 86, scba: 1, mandown: 0, level: 'NORMAL', reasons: [], seq_class: 'fresh', rssi: -80, snr: 6, status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0, ...o });
  it('a reading stores posture, stillness, RSSI and SNR, and a new snapshot clears them', () => {
    let s = apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state;
    s = apply(s, rd(1) as unknown as ServerMessage).state;
    expect(s.detail[1]).toEqual({ posture: 'UPRIGHT', stillness_s: 7, rssi: -80, snr: 6 });
    s = apply(s, snapshot({ epoch: 'e2' }) as unknown as ServerMessage).state; expect(s.detail).toEqual({});
  });
});
