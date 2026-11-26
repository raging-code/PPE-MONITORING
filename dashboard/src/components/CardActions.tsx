import { useState } from 'react';
import type { EpisodeBody } from '../gen/ws.ts';
import { hasUnacknowledged, resolvable } from '../alerts/ack.ts';
import type { Card } from '../alerts/group.ts';
import type { ActionResult, ResolveBody, ResolveReason } from '../api/actions.ts';
import ResolveDialog from './ResolveDialog.tsx';
import { BTN } from './btn.ts';

export interface CardActionsProps {
  card: Card;
  alias: string;
  episodes: Record<number, EpisodeBody>;
  onAck: () => void;
  onResolve: (episodeId: number, reason: ResolveReason) => Promise<ActionResult<ResolveBody>>;
}
const stop = (f: () => void) => (e: { stopPropagation(): void }) => { e.stopPropagation(); f(); };

// Acknowledge for any safety or unverified card. Resolve only for an episode the host has acknowledged, and only through the Resolve dialog with a reason (3.3).
export default function CardActions({ card, alias, episodes, onAck, onResolve }: CardActionsProps) {
  const [target, setTarget] = useState<number | null>(null), [msg, setMsg] = useState<string | null>(null);
  const eps = resolvable(card, episodes);
  const open = eps.find((e) => e.episode_id === target);
  return (
    <>
      {hasUnacknowledged(card) && <button type="button" className={BTN} onClick={stop(onAck)}>Acknowledge</button>}
      {eps.map((e) => <button key={e.episode_id} type="button" className={BTN} onClick={stop(() => { setTarget(e.episode_id); setMsg(null); })}>Resolve</button>)}
      {open && <ResolveDialog alias={alias} episode={open} onResolve={onResolve} onClose={() => setTarget(null)} onDone={(m) => { setMsg(m); setTarget(null); }} />}
      {msg !== null && <p role="status" className="w-full text-base font-semibold">{msg}</p>}
    </>
  );
}
