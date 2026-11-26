// Pure rules of the shift screens (design 3.7 End shift, 3.10 Sessions and the summary after End shift). No DOM, no store.
import type { AlertBody, EpisodeBody, NodeSnap, RosterRow } from '../gen/ws.ts';
import type { SessionRow } from '../api/shift.ts';
import { lineText } from './group.ts';

// Asia/Manila, 24-hour clock (3.10). hourCycle h23 so midnight reads 00:05, never 24:05.
export const manilaStamp = (ts: number): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts)).replace(',', '');

export function durationText(totalS: number): string {
  const s = Math.max(0, Math.round(totalS)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${s} s`;
}

export const modeWord = (m: SessionRow['mode']): string => (m === 'LIVE' ? 'LIVE' : m === 'SIMULATOR' ? 'TEST: simulator' : 'REPLAY');
// Wording of the end kinds is Proposed (ADR 0022); an empty string means nothing to add.
export const endKindWord = (k: SessionRow['end_kind']): string => (k === 'CLEAN_SHUTDOWN' ? 'Host shut down cleanly' : k === 'ABANDONED' ? 'Host stopped without ending the shift' : '');

export interface SessionLine { id: number; date: string; length: string; mode: string; alerts: number; notes: string }
export function sessionLine(r: SessionRow): SessionLine {
  const notes = [r.session_label, endKindWord(r.end_kind), r.unresolved_episodes > 0 ? `${r.unresolved_episodes} unresolved` : ''].filter((x): x is string => !!x);
  return { id: r.session_id, date: manilaStamp(r.started_ts), length: durationText(r.duration_s) + (r.ended_ts === null ? ' (running)' : ''), mode: modeWord(r.mode), alerts: r.alert_count, notes: notes.join('; ') };
}

// What the End shift confirmation lists (3.7): every open alert, every open episode and every latched node.
export interface OpenItems { alerts: string[]; episodes: string[]; latched: string[] }
export function openItems(alerts: Record<number, AlertBody>, episodes: Record<number, EpisodeBody>, nodes: Record<number, NodeSnap>): OpenItems {
  const alias = (id: number) => nodes[id]?.alias ?? `Node ${id}`;
  return {
    alerts: Object.values(alerts).filter((a) => a.cleared_ts === null).sort((a, b) => a.alert_id - b.alert_id)
      .map((a) => `${lineText(a, a.node_id === null ? undefined : nodes[a.node_id])} (${a.level}${a.acknowledged_ts === null ? ', not acknowledged' : ', acknowledged'})`),
    episodes: Object.values(episodes).filter((e) => e.state !== 'RESOLVED').sort((a, b) => a.episode_id - b.episode_id)
      .map((e) => `${alias(e.node_id)}: ${e.kind === 'MAYDAY' ? 'MAYDAY' : 'man-down'}, episode ${e.episode_id}, ${e.state === 'OPEN' ? 'not acknowledged' : 'acknowledged, not resolved'}`),
    latched: Object.values(nodes).filter((n) => n.mandown === 1).sort((a, b) => a.node_id - b.node_id).map((n) => `${n.alias}: jacket latched (only the CANCEL button on the jacket clears it)`),
  };
}
export const nothingOpen = (o: OpenItems): boolean => o.alerts.length + o.episodes.length + o.latched.length === 0;

// The one-screen summary after End shift (3.10): duration, highest level per responder, alerts raised, unresolved episodes, backup result.
export interface Summary { sessionId: number; duration: string; alerts: number; unresolved: number; backup: string; backupOk: boolean; perNode: { alias: string; level: 'WARNING' | 'DANGER' | null }[] }
export function buildSummary(row: SessionRow, backupOk: boolean, roster: RosterRow[]): Summary {
  return {
    sessionId: row.session_id, duration: durationText(row.duration_s), alerts: row.alert_count, unresolved: row.unresolved_episodes, backupOk,
    backup: backupOk ? 'Backup saved' : 'Backup FAILED. The shift data is still on the host.',
    perNode: roster.map((r) => ({ alias: r.alias, level: row.highest_level_by_node[String(r.node_id)] ?? null })),
  };
}
