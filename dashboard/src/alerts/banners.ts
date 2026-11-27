// System banners (design 3.4, 3.7): what to show for the host's own conditions. Text comes from alert_catalog.json. Pure: no DOM, no store.
// A banner is host state only; nothing here creates or reads an alerts row.
import type { Banners } from '../gen/ws.ts';
import { entryFor, LEVEL_RANK, renderText, type Level } from './catalog.ts';

export type BannerKind = 'base_offline' | 'logging_fault' | 'host_gap' | 'recovering' | 'host_power' | 'audio_fault' | 'abi_mismatch';
export const ACKABLE: readonly BannerKind[] = ['host_gap', 'logging_fault']; // the allowlist of POST /api/system-banners/{kind}/ack (3.8)

export interface BannerView { kind: BannerKind; text: string; level: Level; ackable: boolean; acked: boolean }
export interface BannerInput { recovering: boolean; banners: Banners | null; bannerAck: Record<string, number> }

// ws.schema.json types host_power as a plain string with no values (ADR 0021, Proposed): "" "ok" "ac" "none" mean mains power;
// any other text means on battery, and a number in it is the battery percent.
export function parseHostPower(v: string): { onBattery: boolean; pct: number | null } {
  const t = v.trim().toLowerCase();
  if (t === '' || ['ok', 'ac', 'mains', 'none', 'plugged'].includes(t)) return { onBattery: false, pct: null };
  const m = /(\d{1,3})/.exec(t);
  return { onBattery: true, pct: m ? Number(m[1]) : null };
}

export function bannersFor(s: BannerInput): BannerView[] {
  const out: BannerView[] = [];
  const add = (kind: BannerKind, text: string, level: Level) => {
    const e = entryFor(kind);
    out.push({ kind, text, level: e && e.allowed_levels.includes(level) ? level : (e?.default_level ?? level), ackable: ACKABLE.includes(kind), acked: s.bannerAck[kind] !== undefined });
  };
  const txt = (kind: BannerKind, vars: Record<string, string | number | null> = {}) => { const e = entryFor(kind); return e ? renderText(e, vars) : kind; };
  const b = s.banners;
  if (b?.base_offline) add('base_offline', txt('base_offline'), 'DANGER');
  if (s.recovering) add('recovering', txt('recovering'), 'NONE');
  if (b?.logging_fault) add('logging_fault', txt('logging_fault'), 'WARNING'); // stays while the fault lasts, even after Acknowledge
  if (b?.host_gap && s.bannerAck.host_gap === undefined) {
    add('host_gap', txt('host_gap', { gap_s: b.host_gap.gap_s }) + (b.host_gap.reason === 'db_restored' ? ' Database restored from a backup.' : ''), 'NONE');
  }
  if (b) {
    const hp = parseHostPower(b.host_power), e = entryFor('host_power');
    if (hp.onBattery && e) {
      const [notice, warning] = e.text.split(' / ');
      if (hp.pct !== null) add('host_power', renderText({ ...e, text: warning }, { pct: hp.pct }), 'WARNING');
      else add('host_power', notice, 'NONE');
    }
    if (b.audio_fault) add('audio_fault', txt('audio_fault'), 'WARNING');
    if (b.abi_mismatch) add('abi_mismatch', txt('abi_mismatch'), 'WARNING'); // P24-5g (ADR 0051): not in ACKABLE, so no button; stays while the host reports it
  }
  return out.sort((x, y) => LEVEL_RANK[y.level] - LEVEL_RANK[x.level] || (entryFor(x.kind)?.badge_order ?? 0) - (entryFor(y.kind)?.badge_order ?? 0));
}

// Session mode bar (3.7): any mode other than LIVE shows a permanent dark neutral bar, never a level colour.
export function modeText(mode: string | undefined, startedTs: number | undefined): string | null {
  if (!mode || mode === 'LIVE') return null;
  if (mode === 'SIMULATOR') return 'TEST: simulator data';
  const d = startedTs === undefined ? '?' : new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(startedTs)).replace(',', '');
  return `REPLAY: ${d}`;
}
