// Display rules for alerts (design 3.2 badges, 3.3 tray). Pure functions over AlertBody: the cards of
// P22-2 and the buttons of P22-3 call these and decide nothing themselves.
import type { AlertBody } from '../gen/ws.ts';
import { entryFor, LEVEL_RANK, type CatalogEntry } from './catalog.ts';

export const MAX_BADGES = 2;
const TRAY_SHOWS = new Set(['card', 'card_or_notice', 'dashed_card', 'slim_card']);

// A type the catalog does not know must stay visible: it is treated as a safety card, never dropped.
const UNKNOWN: CatalogEntry = {
  type: 'unknown', owner: 'alerts', class: 'safety', allowed_levels: ['NONE', 'WARNING', 'DANGER'], default_level: 'WARNING',
  sound_by_level: {}, show: 'card', badge_order: 999, text: '{alias} ALERT: unknown type',
};
const meta = (a: AlertBody): CatalogEntry => entryFor(a.alert_type) ?? UNKNOWN;

// (level_rank DESC, badge_order ASC, alert_id ASC): a DANGER badge is never hidden behind two WARNING badges.
export function badgeCompare(a: AlertBody, b: AlertBody): number {
  return LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || meta(a).badge_order - meta(b).badge_order || a.alert_id - b.alert_id;
}

// Badges of one node: its uncleared alerts, except hotspot-and-log-only types (wrist_open, wrist_close).
export function badgesFor(alerts: Iterable<AlertBody>, nodeId: number): AlertBody[] {
  return [...alerts]
    .filter((a) => a.node_id === nodeId && a.cleared_ts === null && meta(a).show !== 'hotspot_log')
    .sort(badgeCompare)
    .slice(0, MAX_BADGES);
}

export interface TrayItem { alert: AlertBody; cleared: boolean; dismissible: boolean }

// Does the alert have a card in the tray? An alert that cleared before anyone acknowledged it stays
// (shown as "cleared") so a short spike is never missed. An estimate or advisory leaves when it clears.
export function inTray(a: AlertBody): boolean {
  const m = meta(a);
  if (m.owner !== 'alerts' || !TRAY_SHOWS.has(m.show)) return false;
  if (m.show === 'card_or_notice' && a.level === 'NONE') return false; // a fall-only check-in is a notice, not a card
  return m.class === 'advisory' ? a.cleared_ts === null : a.cleared_ts === null || a.acknowledged_ts === null;
}

// Safety and security cards can be minimized but never closed; only estimate and advisory cards can be dismissed.
export const isDismissible = (a: AlertBody): boolean => meta(a).class === 'advisory';

// Order: danger before warning, then oldest first (3.3). Slim cards (estimate, advisory) sit under the safety cards.
export function trayOrder(alerts: Iterable<AlertBody>, dismissed: ReadonlySet<number> = new Set()): { cards: TrayItem[]; slim: TrayItem[] } {
  const items = [...alerts]
    .filter((a) => inTray(a) && !(isDismissible(a) && dismissed.has(a.alert_id)))
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.raised_ts - b.raised_ts || a.alert_id - b.alert_id)
    .map((a) => ({ alert: a, cleared: a.cleared_ts !== null, dismissible: isDismissible(a) }));
  return { cards: items.filter((i) => !i.dismissible), slim: items.filter((i) => i.dismissible) };
}
