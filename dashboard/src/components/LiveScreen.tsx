import { useMemo } from 'react';
import { badgesFor, trayOrder } from '../alerts/rules.ts';
import { buildCards, chipText, isFlashing, type Card } from '../alerts/group.ts';
import { levelView } from '../alerts/style.ts';
import { cn } from '../lib/utils.ts';
import { useLive } from '../store/live.ts';
import { dismissAlerts, minimizeCard, restoreCard, selectNode, useUi } from '../store/ui.ts';
import AlertCard from './AlertCard.tsx';
import NodeCard from './NodeCard.tsx';

// Node cards, chips of minimized alerts and the tray. The tray is in normal flow, so it pushes the page down and covers no reading (3.3).
// Chips move to the top strip in P22d.
export default function LiveScreen() {
  const alerts = useLive((s) => s.alerts), nodes = useLive((s) => s.nodes), roster = useLive((s) => s.roster), now = useLive((s) => s.lastSrvTs);
  const selected = useUi((s) => s.selected), minimized = useUi((s) => s.minimized), dismissed = useUi((s) => s.dismissed);
  const list = useMemo(() => Object.values(alerts), [alerts]);
  const view = useMemo(() => buildCards(trayOrder(list, new Set(Object.keys(dismissed).map(Number)))), [list, dismissed]);
  const current = selected ?? roster[0]?.node_id ?? null;
  const flashing = new Set(view.cards.filter(isFlashing).map((c) => c.node_id));
  const isMin = (c: Card) => minimized[c.key] === c.sig;
  const show = (c: Card, dismissIds?: number[]) => (
    <AlertCard key={c.key} card={c} nodes={nodes} onSelect={selectNode} onMinimize={() => minimizeCard(c.key, c.sig)} onDismiss={dismissIds && (() => dismissAlerts(dismissIds))} />
  );
  return (
    <main className="space-y-4 p-4" data-testid="live">
      <div className="grid gap-4 md:grid-cols-3">
        {roster.filter((r) => r.active && nodes[r.node_id]).map((r) => (
          <NodeCard key={r.node_id} node={nodes[r.node_id]} badges={badgesFor(list, r.node_id)} flashing={flashing.has(r.node_id)} selected={current === r.node_id} onSelect={selectNode} />
        ))}
      </div>
      <nav aria-label="Minimized alerts" className="flex flex-wrap gap-2">
        {[...view.cards, ...view.slim].filter(isMin).map((c) => (
          <button key={c.key} type="button" data-testid={`chip-${c.key}`} onClick={() => restoreCard(c.key)}
            className={cn('min-h-11 rounded-full border-2 px-4 text-base font-semibold', c.kind === 'responder' ? levelView(c.level).box : 'border-dashed border-stale-text bg-white text-stale-text')}>
            {chipText(c, nodes, now)}
          </button>
        ))}
      </nav>
      <section aria-label="Alerts" data-testid="tray" className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">{view.cards.filter((c) => !isMin(c)).map((c) => show(c))}</div>
        <div className="grid gap-2">{view.slim.filter((c) => !isMin(c)).map((c) => show(c, c.lines.flatMap((l) => l.ids)))}</div>
      </section>
    </main>
  );
}
