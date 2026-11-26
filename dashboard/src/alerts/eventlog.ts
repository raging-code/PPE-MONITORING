// Pure rules of the event log (design 3.11): merge rows, keep the newest, say each row in words. No DOM, no store.
import type { LogRow } from '../api/events.ts';
import type { NodeSnap } from '../gen/ws.ts';

export const KEEP_ROWS = 500; // newest rows kept in memory, so a 24 h shift cannot grow without limit
export const SHOW_ROWS = 100; // newest rows drawn
const key = (r: LogRow): string => `${r.event_seq}|${r.record_type}|${r.code}|${r.node_id}`; // one alert raised and cleared are two rows with two event_seq values; rows may share one event_seq

// Union by key, strictly in event_seq order (then time), newest `keep` rows. Repeated pages and reconnects add no duplicate.
export function mergeRows(old: LogRow[], incoming: LogRow[], keep = KEEP_ROWS): LogRow[] {
  const m = new Map<string, LogRow>();
  for (const r of old) m.set(key(r), r);
  for (const r of incoming) m.set(key(r), r);
  return [...m.values()].sort((a, b) => a.event_seq - b.event_seq || a.log_ts - b.log_ts).slice(-keep);
}

const human = (s: string): string => { const t = s.toLowerCase().replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
export const aliasOf = (id: number | null, nodes: Record<number, NodeSnap>): string => (id === null ? '' : nodes[id]?.alias ?? `Node ${id}`);

export function rowText(r: LogRow, nodes: Record<number, NodeSnap>): string {
  const who = aliasOf(r.node_id, nodes), by = r.operator_id === null ? '' : ` (operator ${r.operator_id})`, d = r.detail ? `: ${r.detail}` : '';
  switch (r.record_type) {
    case 'alert_raised': case 'alert_cleared':
      return `${who ? who + ' ' : ''}${human(r.code)}${r.level && r.level !== 'NONE' ? ` ${r.level}` : ''} ${r.record_type === 'alert_raised' ? 'raised' : 'cleared'}${by}`;
    case 'audit': return `${human(r.code)}${who ? ' ' + who : ''}${d}${by}`;
    case 'advisory': return `Advisory${who ? ' ' + who : ''}, ${human(r.code)}${d}`;
    default: return `${human(r.code)}${d}`;
  }
}
// The one line for frames the host rejected (3.11, hazard H7): a count and the "check key" message.
export const rejectedText = (n: number): string => `${n} ${n === 1 ? 'frame' : 'frames'} rejected (authentication): check key`;
