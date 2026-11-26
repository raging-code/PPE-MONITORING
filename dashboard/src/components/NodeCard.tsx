import type { CSSProperties } from 'react';
import type { AlertBody, NodeSnap } from '../gen/ws.ts';
import { badgeText } from '../alerts/group.ts';
import { levelView } from '../alerts/style.ts';
import { cn } from '../lib/utils.ts';

export interface NodeCardProps {
  node: NodeSnap;
  badges: AlertBody[]; // at most 2, from badgesFor
  flashing: boolean;
  selected: boolean;
  onSelect: (id: number) => void;
}

// Colour, icon and word come from node.level and nothing else (3.6).
export default function NodeCard({ node, badges, flashing, selected, onSelect }: NodeCardProps) {
  const v = levelView(node.level);
  return (
    <button type="button" data-testid={`node-${node.node_id}`} aria-pressed={selected} onClick={() => onSelect(node.node_id)}
      style={flashing ? ({ '--flash-on': 'var(--color-ink)' } as CSSProperties) : undefined}
      className={cn('min-h-11 w-full rounded-card border-2 p-3 text-left shadow-sm', v.box, selected ? 'border-ink' : 'border-transparent', flashing && 'flash')}>
      <span className="flex items-center gap-2 text-xl font-bold"><span aria-hidden="true">{v.icon}</span><span>{node.alias}</span><span>{v.word}</span></span>
      <span className="block text-base">Battery {node.bat_pct === null ? '?' : `${Math.round(node.bat_pct)}%`}</span>
      {badges.map((b) => <span key={b.alert_id} className="mr-1 inline-block rounded bg-white px-2 text-sm font-semibold text-ink">{badgeText(b, node)}</span>)}
    </button>
  );
}
