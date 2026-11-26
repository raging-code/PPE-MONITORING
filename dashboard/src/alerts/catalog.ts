// Alert catalog loader (design 3.4). shared/alert_catalog.json is the single source for the host, the
// dashboard and the completeness test. The loader validates the file, so a bad edit fails loudly
// here and not as a blank card on a safety screen. No DOM, no store: pure data.
import raw from '../../../shared/alert_catalog.json';

export type Level = 'NONE' | 'WARNING' | 'DANGER';
export type AlertClass = 'safety' | 'notice' | 'security' | 'advisory' | 'system';
export interface CatalogEntry {
  type: string;
  owner: 'alerts' | 'system_banner';
  class: AlertClass;
  allowed_levels: Level[];
  default_level: Level;
  sound_by_level: Partial<Record<Level, string>>;
  show: string;
  badge_order: number;
  text: string;
}

export const LEVEL_RANK: Record<Level, number> = { NONE: 0, WARNING: 1, DANGER: 2 };
const LEVELS = Object.keys(LEVEL_RANK) as Level[];
const CLASSES: AlertClass[] = ['safety', 'notice', 'security', 'advisory', 'system'];

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function loadCatalog(data: unknown): CatalogEntry[] {
  if (!Array.isArray(data) || data.length === 0) throw new Error('catalog: not a non-empty list');
  const types = new Set<string>(), orders = new Set<number>();
  return data.map((r: Record<string, unknown>, i) => {
    const bad = (why: string): never => { throw new Error(`catalog[${i}] ${String(r?.type)}: ${why}`); };
    if (!isStr(r.type)) bad('type missing');
    if (types.has(r.type as string)) bad('duplicate type');
    if (r.owner !== 'alerts' && r.owner !== 'system_banner') bad('owner');
    if (!CLASSES.includes(r.class as AlertClass)) bad('class');
    const allowed = r.allowed_levels as Level[];
    if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every((l) => LEVELS.includes(l))) bad('allowed_levels');
    if (!allowed.includes(r.default_level as Level)) bad('default_level not in allowed_levels');
    const sounds = r.sound_by_level as Record<string, unknown>;
    if (!sounds || [...allowed].sort().join() !== Object.keys(sounds).sort().join() || !Object.values(sounds).every(isStr)) bad('sound_by_level must have one sound per allowed level');
    if (!isStr(r.show)) bad('show');
    if (!Number.isInteger(r.badge_order) || orders.has(r.badge_order as number)) bad('badge_order missing or repeated');
    if (!isStr(r.text)) bad('text');
    types.add(r.type as string); orders.add(r.badge_order as number);
    return r as unknown as CatalogEntry;
  });
}

export const CATALOG: readonly CatalogEntry[] = loadCatalog(raw);
const BY_TYPE = new Map(CATALOG.map((e) => [e.type, e]));

export const entryFor = (type: string): CatalogEntry | undefined => BY_TYPE.get(type);
export const soundFor = (type: string, level: Level): string | null => BY_TYPE.get(type)?.sound_by_level[level] ?? null;

// Fills {alias}, {co_ppm}, {temp_c}, {bat_pct}, {gap_s}, {pct}. A value that is not supplied shows as "?",
// never as a raw placeholder and never as a made-up number.
export function renderText(entry: CatalogEntry, vars: Record<string, string | number | null | undefined>): string {
  return entry.text.replace(/\{(\w+)\}/g, (_m, k: string) => (vars[k] === null || vars[k] === undefined ? '?' : String(vars[k])));
}
