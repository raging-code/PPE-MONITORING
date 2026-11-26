import { useState, type CSSProperties } from 'react';
import type { NodeSnap } from '../gen/ws.ts';
import { isFlashing, lineText, MAX_LINES, type Card } from '../alerts/group.ts';
import { levelView } from '../alerts/style.ts';
import { cn } from '../lib/utils.ts';

export interface AlertCardProps {
  card: Card;
  nodes: Record<number, NodeSnap>;
  onSelect: (id: number) => void;
  onMinimize: () => void;
  onDismiss?: () => void; // given only to estimate cards: a safety or unverified card is never closed
}
const LABEL = { slim: 'estimate', unauth: 'unverified' } as const;
const FLASH: Record<string, string> = { WARNING: 'var(--color-level-warning)', DANGER: 'var(--color-level-danger)' };
const BTN = 'min-h-11 rounded-lg bg-slate-800 px-4 text-base font-semibold text-white';

export default function AlertCard({ card, nodes, onSelect, onMinimize, onDismiss }: AlertCardProps) {
  const [open, setOpen] = useState(false);
  const node = card.node_id === null ? undefined : nodes[card.node_id];
  const lines = open ? card.lines : card.lines.slice(0, MAX_LINES);
  const more = card.lines.length - lines.length;
  const flash = isFlashing(card), quiet = card.kind !== 'responder', v = levelView(card.level);
  return (
    <section data-testid={`card-${card.key}`} data-kind={card.kind} onClick={() => card.node_id !== null && onSelect(card.node_id)}
      style={flash ? ({ '--flash-on': FLASH[card.level] ?? 'var(--color-ink)' } as CSSProperties) : undefined}
      className={cn('rounded-card border-2 bg-white p-4 shadow-sm', quiet ? 'border-dashed border-stale-text' : 'border-card-border', flash && 'flash')}>
      {card.kind === 'responder'
        ? <h3 className={cn('mb-2 flex items-center gap-2 rounded-lg px-3 py-1 text-xl font-bold', v.box)}><span aria-hidden="true">{v.icon}</span><span>{v.word}</span><span>{node?.alias ?? 'Unknown node'}</span></h3>
        : <p className="mb-2"><span className="rounded bg-stale-fill px-2 py-1 text-sm font-semibold uppercase text-stale-text">{LABEL[card.kind]}</span></p>}
      <ul className="m-0 list-none space-y-1 p-0">
        {lines.map((l) => (
          <li key={l.alert.alert_id} className={cn('text-xl font-bold', quiet && 'text-stale-text')}>
            {lineText(l.alert, node)}
            {l.count > 1 && <span className="ml-2 rounded bg-ink px-2 text-base text-white">×{l.count}</span>}
            {l.cleared && <span className="ml-2 text-base font-normal text-stale-text">cleared</span>}
          </li>
        ))}
      </ul>
      {more > 0 && <button type="button" className="mt-2 min-h-11 text-base font-semibold underline" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>+{more} more</button>}
      <div className="mt-3 flex gap-2">
        <button type="button" className={BTN} onClick={(e) => { e.stopPropagation(); onMinimize(); }}>Minimize</button>
        {onDismiss && <button type="button" className={BTN} onClick={(e) => { e.stopPropagation(); onDismiss(); }}>Dismiss</button>}
      </div>
    </section>
  );
}
