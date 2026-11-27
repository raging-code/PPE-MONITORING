// Requirements: REQ-RUL-001
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG, entryFor, loadCatalog, renderText, soundFor } from '../src/alerts/catalog.ts';

const read = (p: string) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const RAW = JSON.parse(read('shared/alert_catalog.json')) as Record<string, unknown>[];
const ALERTS = CATALOG.filter((e) => e.owner === 'alerts');
const BANNERS = CATALOG.filter((e) => e.owner === 'system_banner');

// Table 3.4 of the design, parsed from docs/design/s03-4.md: one row per line, code(s) in [brackets] in column 1.
const ROWS = read('docs/design/s03-4.md').split(/\r?\n/)
  .filter((l) => l.startsWith('|') && !l.startsWith('|---') && !l.startsWith('| Alert'))
  .map((l) => l.slice(1, -1).split('|').map((c) => c.trim()))
  .flatMap((c) => [...(/\[([a-z_, ]+)\]\s*$/.exec(c[0])?.[1].split(',') ?? [])].map((t) => ({ code: t.trim(), sound: c[3], shows: c[4] })));
const ROW = new Map(ROWS.map((r) => [r.code, r]));

const seed = /INSERT INTO alert_types\(type\) VALUES (.*?);/.exec(read('host/migrations/0001.sql'))![1];
const SEED = [...seed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

const SOUND_WORD: Record<string, string> = { none: 'none', siren: 'siren', beep: 'beep', chime: 'chime', one_beep: 'one beep', siren_60s_silence: 'siren' };
const SHOWS_AS: Record<string, string> = {
  card: 'Card', card_or_notice: 'Card, or notice', dashed_card: 'Dashed card', slim_card: 'Slim card', badge_or_line: 'Badge, or a line on the card',
  badge_log: 'Badge and log only', badge: 'Badge only', hotspot_log: 'Hotspot marker and log only', banner: 'Banner',
  banner_ack: 'Banner, kept until acknowledged', fullscreen: 'Full screen',
};

describe('catalog loader', () => {
  it('loads the 32 entries: 25 alert types and 7 banners', () => {
    expect(CATALOG).toHaveLength(32);
    expect(ALERTS).toHaveLength(25);
    expect(BANNERS.map((b) => b.type).sort()).toEqual(['audio_fault', 'base_offline', 'host_gap', 'host_power', 'logging_fault', 'no_live_data', 'recovering']);
  });
  it('rejects a bad file instead of showing a blank card', () => {
    const one = (over: Record<string, unknown>) => [{ ...RAW[0], ...over }];
    expect(() => loadCatalog([])).toThrow();
    expect(() => loadCatalog(one({ class: 'loud' }))).toThrow(/class/);
    expect(() => loadCatalog(one({ default_level: 'WARNING' }))).toThrow(/default_level/);
    expect(() => loadCatalog(one({ sound_by_level: {} }))).toThrow(/sound_by_level/);
    expect(() => loadCatalog(one({ show: '' }))).toThrow(/show/);
    expect(() => loadCatalog([RAW[0], { ...RAW[1], badge_order: RAW[0].badge_order }])).toThrow(/badge_order/);
    expect(() => loadCatalog([RAW[0], { ...RAW[1], type: RAW[0].type }])).toThrow(/duplicate/);
  });
  it('gives text, sound and entry per type, and shows a missing value as ?', () => {
    expect(renderText(entryFor('co_threshold')!, { alias: 'FF-01', co_ppm: 52 })).toBe('FF-01 CO 52 ppm, SCBA OFF');
    expect(renderText(entryFor('battery_low')!, { alias: 'FF-02' })).toBe('FF-02 BATTERY ?%');
    expect(soundFor('co_threshold', 'WARNING')).toBe('beep');
    expect(soundFor('co_threshold', 'DANGER')).toBe('siren');
    expect(soundFor('man_down', 'WARNING')).toBeNull();
    expect(entryFor('nope')).toBeUndefined();
  });
});

describe('catalog completeness (P22 catalog test)', () => {
  it('catalog, alert_types seed and table 3.4 list the same alert types', () => {
    const cat = ALERTS.map((e) => e.type).sort();
    expect(SEED.slice().sort()).toEqual(cat);
    expect(ROWS.map((r) => r.code).filter((c) => !BANNERS.some((b) => b.type === c)).sort()).toEqual(cat);
  });
  it('every entry has a class, a sound and a Shows-as value, in the catalog and in 3.4', () => {
    for (const e of CATALOG) {
      expect(e.class && e.show && Object.values(e.sound_by_level).every(Boolean)).toBeTruthy();
      const row = ROW.get(e.type);
      if (e.type === 'audio_fault') continue; // gap, see the next test
      expect(row?.sound, e.type).toBeTruthy();
      expect(row?.shows, e.type).toBeTruthy();
      for (const s of Object.values(e.sound_by_level)) expect(row!.sound.toLowerCase(), e.type).toContain(SOUND_WORD[s!]);
      expect(row!.shows.split('(')[0].trim(), e.type).toBe(SHOWS_AS[e.show]);
      expect(row!.shows.includes('system_events only'), e.type).toBe(e.owner === 'system_banner');
    }
  });
  it('badge_order values are unique and run 1 to 32', () => {
    expect(CATALOG.map((e) => e.badge_order).sort((a, b) => a - b)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
  });
  it('the 6 banners other than audio_fault each have a 3.4 row', () => {
    for (const b of BANNERS.filter((x) => x.type !== 'audio_fault')) expect(ROW.has(b.type), b.type).toBe(true);
  });
  // Expected failure (ADR 0015): Rev 3.45 table 3.4 has no AUDIO FAULT row although its completeness rule and 3.12 require
  // one. When the row is added to the design, this starts passing, Vitest reports it, and ".fails" is removed.
  it.fails('the audio_fault banner has a 3.4 row', () => {
    expect(ROW.has('audio_fault')).toBe(true);
  });
});
