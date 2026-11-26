import { useState } from 'react';
import type { EpisodeBody } from '../gen/ws.ts';
import { hasUnacknowledged, resolvable } from '../alerts/ack.ts';
import type { Card } from '../alerts/group.ts';
import { REASON_LABEL, RESOLVE_REASONS, resolveMessage, type ActionResult, type ResolveBody, type ResolveReason } from '../api/actions.ts';

export interface CardActionsProps {
  card: Card;
  alias: string;
  episodes: Record<number, EpisodeBody>;
  onAck: () => void;
  onResolve: (episodeId: number, reason: ResolveReason) => Promise<ActionResult<ResolveBody>>;
}
const BTN = 'min-h-11 rounded-lg bg-slate-800 px-4 text-base font-semibold text-white disabled:opacity-50';
const stop = (f: () => void) => (e: { stopPropagation(): void }) => { e.stopPropagation(); f(); };

// Acknowledge for any safety or unverified card. Resolve only for an episode the host has acknowledged, and only with a reason (3.3).
export default function CardActions({ card, alias, episodes, onAck, onResolve }: CardActionsProps) {
  const [target, setTarget] = useState<number | null>(null), [reason, setReason] = useState<ResolveReason | ''>(''), [msg, setMsg] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const eps = resolvable(card, episodes);
  const submit = async () => {
    if (target === null || reason === '') return;
    setBusy(true);
    const r = await onResolve(target, reason);
    setBusy(false); setMsg(resolveMessage(r));
    if (r.kind !== 'retry') { setTarget(null); setReason(''); }
  };
  return (
    <>
      {hasUnacknowledged(card) && <button type="button" className={BTN} onClick={stop(onAck)}>Acknowledge</button>}
      {eps.map((e) => target !== e.episode_id
        ? <button key={e.episode_id} type="button" className={BTN} onClick={stop(() => { setTarget(e.episode_id); setMsg(null); })}>Resolve</button>
        : (
          <div key={e.episode_id} role="group" aria-label="Resolve episode" onClick={(ev) => ev.stopPropagation()} className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold">Resolve {alias}, episode {e.episode_id}</span>
            <label className="flex items-center gap-2 text-base">Reason
              <select className="min-h-11 rounded-lg border-2 border-card-border bg-white px-2" value={reason} onChange={(ev) => setReason(ev.target.value as ResolveReason | '')}>
                <option value="">Choose a reason</option>
                {RESOLVE_REASONS.map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
              </select>
            </label>
            <button type="button" className={BTN} disabled={reason === '' || busy} onClick={stop(() => { void submit(); })}>Confirm resolve</button>
            <button type="button" className={BTN} onClick={stop(() => { setTarget(null); setReason(''); })}>Cancel</button>
          </div>
        ))}
      {msg !== null && <p role="status" className="w-full text-base font-semibold">{msg}</p>}
    </>
  );
}
