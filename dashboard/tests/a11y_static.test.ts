// Design 3.6 checks that need no browser: sizes in the source, colour pairs in index.css, levels without colour, flash rate, offline font.
// Pixel layout at 1366x768 and 150% zoom needs a real browser (Playwright rows of design 8); see docs/adr/0023.md.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { levelView } from '../src/alerts/style.ts';

const SRC = path.join(__dirname, '..', 'src'), css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'gen' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
const tok = (n: string) => { const m = new RegExp(`--color-${n}:\\s*(#[0-9a-fA-F]{6})`).exec(css); if (!m) throw new Error(`token ${n} missing`); return m[1]; };
const lum = (h: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const WHITE = '#ffffff';

describe('3.6 look and accessibility', () => {
  it('nothing is set under 14 px in the source (no text-xs, no pixel or rem size below 14 px)', () => {
    const bad: string[] = [];
    for (const f of walk(SRC).filter((x) => /\.(tsx?|css)$/.test(x))) {
      const t = fs.readFileSync(f, 'utf8');
      for (const m of t.matchAll(/text-xs|text-\[(\d+(?:\.\d+)?)(px|rem)\]|font-size:\s*(\d+(?:\.\d+)?)(px|rem)/g)) {
        const v = m[0] === 'text-xs' ? 12 : Number(m[1] ?? m[3]) * ((m[2] ?? m[4]) === 'rem' ? 16 : 1);
        if (v < 14) bad.push(`${path.relative(SRC, f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('the level pairs and the text colours meet 4.5:1', () => {
    const pairs: [string, string, string][] = [['normal', tok('level-normal'), WHITE], ['warning', tok('level-warning'), tok('ink')], ['danger', tok('level-danger'), WHITE],
      ['ink on white', tok('ink'), WHITE], ['ink on page', tok('ink'), tok('page')], ['stale text on white', tok('stale-text'), WHITE]];
    for (const [n, a, b] of pairs) expect(ratio(a, b), n).toBeGreaterThanOrEqual(4.5);
  });
  // Design 3.6 says the stale pair "meets 4.5:1 (checked)". Measured: #6b7280 on #e5e7eb is 3.90:1. The design is frozen and the colours are not changed here (ADR 0023
  // proposes #4b5563). When the colour is changed this starts passing, Vitest reports it, and ".fails" is removed.
  it.fails('stale text on the stale fill meets 4.5:1', () => { expect(ratio(tok('stale-text'), tok('stale-fill'))).toBeGreaterThanOrEqual(4.5); });
  it('a greyscale screenshot still separates the levels: each has its own icon and its own word', () => {
    const v = ['NORMAL', 'WARNING', 'DANGER'].map(levelView);
    expect(new Set(v.map((x) => x.icon)).size).toBe(3); expect(new Set(v.map((x) => x.word)).size).toBe(3);
  });
  it('the flash is one pulse per second (under 3), and reduced motion gives a steady thick border', () => {
    const m = /animation:\s*card-flash\s+([\d.]+)s/.exec(css); expect(m).not.toBeNull();
    expect(1 / Number(m![1])).toBeLessThan(3);
    const rm = /prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.flash\s*\{([^}]*)\}/.exec(css); expect(rm?.[1]).toMatch(/animation:\s*none/); expect(rm?.[1]).toMatch(/border-width:\s*6px/);
  });
  it('Inter is bundled with the app, so the page needs no network for its font', () => {
    expect(css).toContain("@import '@fontsource-variable/inter'");
    expect(JSON.parse(fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8')).dependencies['@fontsource-variable/inter']).toBeTruthy();
  });
});
