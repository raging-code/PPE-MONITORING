// Pure rules of the side panel (design 3.2, 3.10): the 8 reading rows, "last seen", the advisory line. No DOM, no store, no clock.
import { BITS } from '../gen/abi.ts';
import { CONSTANTS } from '../gen/constants.ts';
import { LINK, type Tone } from '../jacket/hotspots.ts';
import type { NodeSnap } from '../gen/ws.ts';
import type { ReadingDetail } from '../store/reducer.ts';

// Asia/Manila, 24-hour clock (3.10). hourCycle h23 so midnight reads 00:05:00, never 24:05:00.
export const manilaClock = (ts: number): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ts));

// "Last seen" (3.10): relative under 60 s, clock time after that. `now` is server time (the authority), not the browser clock.
export function lastSeenText(last: number | null, now: number | null): string {
  if (last === null) return 'never';
  const d = now === null ? 0 : Math.max(0, (now - last) / 1000);
  return d < 60 ? `${Math.floor(d)} s ago` : manilaClock(last);
}

export interface ReadingLimits { bat_low_pct: number; bat_warn_pct: number; co_clamp_max_ppm: number; mandown_still_s: number }
// Every threshold comes from the snapshot constants, with the generated constants only as a fallback.
export const limitsOf = (c: Record<string, unknown>): ReadingLimits => {
  const n = (k: keyof ReadingLimits) => Number(c[k] ?? CONSTANTS[k]);
  return { bat_low_pct: n('bat_low_pct'), bat_warn_pct: n('bat_warn_pct'), co_clamp_max_ppm: n('co_clamp_max_ppm'), mandown_still_s: n('mandown_still_s') };
};

export interface ReadingRow { id: 'co' | 'climate' | 'motion' | 'battery' | 'scba' | 'link' | 'hr' | 'details'; label: string; text: string; tone: Tone }
const bit = (v: number | null, f: { shift: number }): boolean => v !== null && ((v >> f.shift) & 1) === 1;

// Exactly 8 rows (3.2): CO; temperature and humidity; chest motion and stillness; battery; SCBA; link and last seen; HR and COHb; Details (collapsed).
export function readingRows(n: NodeSnap, now: number | null, d: ReadingDetail | undefined, k: ReadingLimits): ReadingRow[] {
  const s2 = BITS.status2, s3 = BITS.status3, pct = n.bat_pct === null ? null : Math.round(n.bat_pct);
  const ppm = n.co_ppm === null ? '?' : n.co_ppm >= k.co_clamp_max_ppm ? `${k.co_clamp_max_ppm}+` : String(Math.round(n.co_ppm));
  const co: [Tone, string] = n.co_validity === 'UNRELIABLE'
    ? ['grey', n.co_reason === 'co_range' ? 'low confidence: CO sensor out of range' : `low confidence: CO sensor unreliable${n.co_reason ? ` (${n.co_reason})` : ''}`] // never a number: a stale 0 would look safe
    : ['neutral', `${ppm} ppm${n.co_validity === 'DERATED' ? ', warming up' : ''}`];
  const g = n.motion_g === null ? '?' : `${n.motion_g.toFixed(2)} g`;
  const still = d ? `, still ${Math.round(d.stillness_s)} s of ${k.mandown_still_s} s (backend estimate)` : ''; // the node's own man-down state always wins
  const bat: [Tone, string] = pct !== null && pct <= k.bat_warn_pct ? ['warning', `${pct}% LOW`] : bit(n.status2, s2.bat_low) ? ['neutral', `${pct ?? '?'}% low`] : ['neutral', `${pct ?? '?'}%`];
  const expired = bit(n.status3, s3.scba_expired);
  const db = (v: number | null | undefined, u: string) => (v === null || v === undefined ? '?' : `${v} ${u}`);
  return [
    { id: 'co', label: 'CO', tone: co[0], text: co[1] },
    { id: 'climate', label: 'Temperature and humidity', ...(bit(n.status2, s2.temp_fault) ? { tone: 'grey' as Tone, text: 'temperature unknown' }
      : { tone: 'neutral' as Tone, text: `${n.temp_c === null ? '?' : Math.round(n.temp_c)} °C ambient, ${n.hum_pct === null ? '?' : Math.round(n.hum_pct)} %` }) },
    { id: 'motion', label: 'Chest motion', ...(n.mandown === 1 ? { tone: 'danger' as Tone, text: `MAN-DOWN latched, ${g}${still}` } : { tone: 'neutral' as Tone, text: g + still }) },
    { id: 'battery', label: 'Battery', tone: bat[0], text: bat[1] },
    { id: 'scba', label: 'SCBA', tone: expired ? 'warning' : 'neutral', text: expired ? 'EXPIRED' : n.scba === 1 ? 'ON' : n.scba === 0 ? 'OFF' : '?' },
    { id: 'link', label: 'Link', tone: n.link_state === 'ok' ? 'neutral' : 'grey', text: `${LINK[n.link_state]}, last seen ${lastSeenText(n.last_rx_ts, now)}` },
    { id: 'hr', label: 'HR and COHb', tone: 'neutral', text: 'HR not fitted. COHb unavailable' },
    { id: 'details', label: 'Details', tone: 'neutral', text: d ? `posture ${d.posture.toLowerCase().replace('_', ' ')}, RSSI ${db(d.rssi, 'dBm')}, SNR ${db(d.snr, 'dB')}` : 'no reading yet' },
  ];
}

// Advisory line (3.5): risk and action in one line, quality as a word and three dots, greyed when low.
const DOTS = { high: '●●●', medium: '●●○', low: '●○○' } as const;
export const qualityMark = (q: keyof typeof DOTS): string => `${q} ${DOTS[q]}`;
const human = (s: string): string => { const t = s.toLowerCase().replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
export const advisoryLine = (a: { risk: string; action: string; quality: keyof typeof DOTS }) => ({ text: `${human(a.risk)}: ${a.action}`, mark: qualityMark(a.quality), grey: a.quality === 'low' });
