import { useState } from 'react';
import { bannersFor, modeText, type BannerView } from '../alerts/banners.ts';
import { readToken } from '../store/token.ts';
import { authFetch } from '../api/authfetch.ts';
import { liveStore, useLive } from '../store/live.ts';
import { ackBanner, ackMessage } from '../store/banners.ts';
import type { Level } from '../alerts/catalog.ts';
import { cn } from '../lib/utils.ts';

const BOX: Record<Level, string> = { DANGER: 'bg-level-danger text-white', WARNING: 'bg-level-warning text-ink', NONE: 'bg-slate-700 text-white' };
const ICON: Record<Level, string> = { DANGER: '✖', WARNING: '▲', NONE: 'ℹ' };
const defaultApi = { fetchFn: authFetch, getToken: readToken };

// TEST or REPLAY bar: dark and neutral, never a level colour, and it cannot be dismissed (3.7).
export function ModeBar() {
  const mode = useLive((s) => s.session?.mode), started = useLive((s) => s.session?.started_ts);
  const t = modeText(mode, started);
  return t ? <div role="status" data-testid="mode-bar" className="bg-slate-800 px-4 py-2 text-base font-bold text-white">{t}</div> : null;
}

// Stacked system banners. They never close an alert and create no alerts row; Acknowledge is offered only for host_gap and logging_fault.
export default function SystemBanners({ api = defaultApi }: { api?: typeof defaultApi }) {
  const recovering = useLive((s) => s.recovering), banners = useLive((s) => s.banners), bannerAck = useLive((s) => s.bannerAck);
  const [err, setErr] = useState<Record<string, string>>({});
  const list = bannersFor({ recovering, banners, bannerAck });
  if (list.length === 0) return null;
  const ack = async (b: BannerView) => { const m = ackMessage(await ackBanner(b.kind, api, liveStore)); setErr((e) => ({ ...e, [b.kind]: m ?? '' })); };
  return (
    <section aria-label="System banners" data-testid="banners">
      {list.map((b) => (
        <div key={b.kind} role={b.level === 'DANGER' ? 'alert' : 'status'} data-testid={`banner-${b.kind}`} className={cn('flex flex-wrap items-center gap-3 px-4 py-2 text-lg font-bold', BOX[b.level])}>
          <span aria-hidden="true">{ICON[b.level]}</span><span>{b.text}</span>
          {b.ackable && !b.acked && <button type="button" onClick={() => void ack(b)} className="min-h-11 rounded-lg bg-slate-900 px-4 text-base font-bold text-white">Acknowledge</button>}
          {b.ackable && b.acked && <span className="text-base font-semibold">Acknowledged</span>}
          {err[b.kind] && <span className="text-base font-semibold">{err[b.kind]}</span>}
        </div>
      ))}
    </section>
  );
}
