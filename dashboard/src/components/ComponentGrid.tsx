import { hotspotStates, type Limits, type Tone } from '../jacket/hotspots.ts';
import type { AlertBody, NodeSnap } from '../gen/ws.ts';
import { cn } from '../lib/utils.ts';

export interface GridProps { node: NodeSnap; alerts: AlertBody[]; limits: Limits }
const LOOK: Record<Tone, { icon: string; box: string }> = {
  neutral: { icon: '•', box: 'bg-white text-ink' },
  grey: { icon: '?', box: 'bg-stale-fill text-stale-text' },
  warning: { icon: '▲', box: 'bg-level-warning text-ink' },
  danger: { icon: '✖', box: 'bg-level-danger text-white' },
};

// The shipped Tier 1 jacket view (3.1, 3.13): one row per component with its value and state. Colour only for a real state, and every
// coloured row also has an icon and a word, so it works in greyscale. Grey means the reading is unreliable.
export default function ComponentGrid({ node, alerts, limits }: GridProps) {
  return (
    <section aria-label="Jacket components" data-testid="grid" className="rounded-card border-2 border-card-border bg-white p-4 shadow-sm">
      <h2 className="mb-2 text-xl font-bold">{node.alias} components</h2>
      <ul className="m-0 grid list-none gap-2 p-0 md:grid-cols-3">
        {hotspotStates(node, alerts, limits).map((h) => (
          <li key={h.id} data-testid={`hs-${h.id}`} data-tone={h.tone} className={cn('rounded-lg border-2 border-card-border px-3 py-2', LOOK[h.tone].box)}>
            <span className="block text-sm font-semibold">{h.label}</span>
            <span className="block text-base font-bold"><span aria-hidden="true">{LOOK[h.tone].icon} </span>{h.word}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
