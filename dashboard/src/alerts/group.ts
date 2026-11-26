// Turns the ordered tray (rules.ts) into cards (design 3.3): one card per responder with its alerts as lines,
// repeats joined into one line with a count, one dashed card per unverified alert, one slim card per estimate.
import type { AlertBody, NodeSnap } from '../gen/ws.ts';
import { entryFor, LEVEL_RANK, renderText, type Level } from './catalog.ts';
import { levelView } from './style.ts';
import type { TrayItem } from './rules.ts';

export const MAX_LINES = 3;
export interface Line { alert: AlertBody; ids: number[]; count: number; cleared: boolean }
export type CardKind = 'responder' | 'unauth' | 'slim';
export interface Card { key: string; kind: CardKind; node_id: number | null; level: Level; lines: Line[]; raised_ts: number; sig: string }

// Same type on the same responder, not yet acknowledged: one line with a count. An acknowledged alert stands
// alone, so a raise after Acknowledge starts a new line (and a new card sound).
export function mergeRepeats(items: TrayItem[]): Line[] {
  const groups = new Map<string, TrayItem[]>();
  for (const i of items) {
    const a = i.alert, key = a.acknowledged_ts === null ? `${a.node_id}|${a.alert_type}` : `#${a.alert_id}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return [...groups.values()].map((g) => {
    const live = g.filter((i) => !i.cleared);
    const head = (live.length ? live : g).reduce((x, y) => (y.alert.alert_id > x.alert.alert_id ? y : x)).alert;
    return { alert: head, ids: g.map((i) => i.alert.alert_id), count: g.reduce((n, i) => n + (i.alert.unauth_count ?? 1), 0), cleared: live.length === 0 };
  });
}

const lineSort = (a: Line, b: Line) =>
  LEVEL_RANK[b.alert.level] - LEVEL_RANK[a.alert.level] || a.alert.raised_ts - b.alert.raised_ts || a.alert.alert_id - b.alert.alert_id;
const cardSort = (a: Card, b: Card) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.raised_ts - b.raised_ts || a.key.localeCompare(b.key);

function mk(key: string, kind: CardKind, node_id: number | null, lines: Line[]): Card {
  const ls = [...lines].sort(lineSort), level = ls[0].alert.level;
  return { key, kind, node_id, level, lines: ls, raised_ts: Math.min(...ls.map((l) => l.alert.raised_ts)), sig: `${Math.max(...ls.flatMap((l) => l.ids))}:${level}` };
}

export function buildCards(t: { cards: TrayItem[]; slim: TrayItem[] }): { cards: Card[]; slim: Card[] } {
  const byNode = new Map<number | null, Line[]>(), cards: Card[] = [];
  for (const l of mergeRepeats(t.cards)) {
    if (entryFor(l.alert.alert_type)?.class === 'security') cards.push(mk(`u${l.alert.alert_id}`, 'unauth', l.alert.node_id, [l]));
    else byNode.set(l.alert.node_id, [...(byNode.get(l.alert.node_id) ?? []), l]);
  }
  for (const [n, ls] of byNode) cards.push(mk(`n${n ?? 0}`, 'responder', n, ls));
  return { cards: cards.sort(cardSort), slim: mergeRepeats(t.slim).map((l) => mk(`e${l.alert.alert_id}`, 'slim', l.alert.node_id, [l])).sort(cardSort) };
}

// A card flashes while a line is open and unacknowledged. Quiet cards never flash.
export const isFlashing = (c: Card): boolean => c.kind === 'responder' && c.lines.some((l) => !l.cleared && l.alert.acknowledged_ts === null);

const aliasOf = (id: number | null, node?: NodeSnap) => node?.alias ?? (id === null ? 'Unknown node' : `Node ${id}`);

// Catalog text with the live values of the node. A type the catalog lacks still reads as a line.
export function lineText(a: AlertBody, node?: NodeSnap): string {
  const e = entryFor(a.alert_type), alias = aliasOf(a.node_id, node);
  const r = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v));
  return e ? renderText(e, { alias, co_ppm: r(node?.co_ppm), temp_c: r(node?.temp_c), bat_pct: r(node?.bat_pct) }) : `${alias} ALERT: ${a.alert_type}`;
}
export const badgeText = (a: AlertBody, node?: NodeSnap): string => {
  const t = lineText(a, node), alias = aliasOf(a.node_id, node);
  return t.startsWith(alias + ' ') ? t.slice(alias.length + 1) : t;
};

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

// Chip of a minimized card (3.3): alias, level, count, elapsed time. Elapsed runs on server time.
export function chipText(c: Card, nodes: Record<number, NodeSnap>, now: number | null): string {
  const alias = aliasOf(c.node_id, c.node_id === null ? undefined : nodes[c.node_id]);
  const word = c.kind === 'responder' ? levelView(c.level).word : c.kind === 'slim' ? 'estimate' : 'unverified';
  return `${alias} ${word} ×${c.lines.reduce((n, l) => n + l.count, 0)} ${formatElapsed(now === null ? 0 : now - c.raised_ts)}`;
}
