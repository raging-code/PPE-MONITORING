// Pure rules for Acknowledge and Resolve (design 3.3). The host stores the Acknowledge; this file only decides what to send
// and how a click is shown before the host answers.
import type { AlertBody, EpisodeBody } from '../gen/ws.ts';
import type { Card } from './group.ts';

export interface PendingAck { ts: number; confirmed: boolean }
export type Acks = Record<number, PendingAck>;
export interface AckTargets { episodes: { id: number; alertIds: number[] }[]; alerts: number[] }

// What one Acknowledge click sends. A line with an episode goes through the episode call, which acknowledges its linked alerts too;
// other lines go one by one. A cleared line is included (the host accepts it), an acknowledged line is not.
export function ackTargets(card: Card): AckTargets {
  const eps = new Map<number, number[]>(), alerts: number[] = [];
  for (const l of card.lines) {
    if (l.alert.acknowledged_ts !== null) continue; // a merged line holds only unacknowledged rows; an acknowledged row stands alone
    const e = l.alert.episode_id;
    if (e === null) alerts.push(...l.ids); else eps.set(e, [...(eps.get(e) ?? []), ...l.ids]);
  }
  return { episodes: [...eps].map(([id, alertIds]) => ({ id, alertIds })), alerts };
}
export const hasUnacknowledged = (c: Card): boolean => c.kind !== 'slim' && c.lines.some((l) => l.alert.acknowledged_ts === null);

// The click silences the card at once: an unconfirmed ack counts as acknowledged on screen. A failed call never removes it.
export function overlayAcks(list: AlertBody[], acks: Acks): AlertBody[] {
  return list.map((a) => (a.acknowledged_ts === null && acks[a.alert_id] ? { ...a, acknowledged_ts: acks[a.alert_id].ts } : a));
}
export const pendingIds = (acks: Acks): Set<number> => new Set(Object.keys(acks).map(Number).filter((i) => !acks[i].confirmed));

// An entry has done its job once the host's own alert shows the acknowledgement, or the alert is gone.
export function pruneAcks(acks: Acks, alerts: Record<number, AlertBody>): Acks {
  const keep = Object.keys(acks).map(Number).filter((i) => alerts[i] !== undefined && alerts[i].acknowledged_ts === null);
  return keep.length === Object.keys(acks).length ? acks : Object.fromEntries(keep.map((i) => [i, acks[i]]));
}

// Resolve belongs to an episode the host has confirmed as ACKNOWLEDGED (two steps: Acknowledge, then Resolve).
export function resolvable(card: Card, episodes: Record<number, EpisodeBody>): EpisodeBody[] {
  const seen = new Set<number>(), out: EpisodeBody[] = [];
  for (const l of card.lines) {
    const id = l.alert.episode_id, e = id === null ? undefined : episodes[id];
    if (e && e.state === 'ACKNOWLEDGED' && !seen.has(e.episode_id)) { seen.add(e.episode_id); out.push(e); }
  }
  return out;
}
