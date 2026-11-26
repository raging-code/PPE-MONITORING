import { useEffect, useMemo } from 'react';
import { ackTargets, overlayAcks, pendingIds, pruneAcks } from '../alerts/ack.ts';
import { badgesFor, trayOrder } from '../alerts/rules.ts';
import { buildCards, chipText, isFlashing, type Card } from '../alerts/group.ts';
import { levelView } from '../alerts/style.ts';
import { cn } from '../lib/utils.ts';
import { useLive } from '../store/live.ts';
import { dismissAlerts, minimizeCard, restoreCard, selectNode, useUi } from '../store/ui.ts';
import { acksStore, defaultActions, useAcks, type Actions } from '../store/actions.ts';
import AlertCard from './AlertCard.tsx';
import CardActions from './CardActions.tsx';
import NodeCard from './NodeCard.tsx';

// Node cards, chips of minimized alerts and the tray. The tray is in normal flow, so it pushes the page down and covers no reading (3.3).
// Chips move to the top strip in P22d.
export default function LiveScreen({ actions = defaultActions }: { actions?: Actions }) {
  const alerts = useLive((s) => s.alerts), nodes = useLive((s) => s.nodes), roster = useLive((s) => s.roster), now = useLive((s) => s.lastSrvTs), episodes = useLive((s) => s.episodes), acks = useAcks((s) => s.acks);
  const selected = useUi((s) => s.selected), minimized = useUi((s) => s.minimized), dismissed = useUi((s) => s.dismissed);
  const list = useMemo(() => overlayAcks(Object.values(alerts), acks), [alerts, acks]);
  const pending = useMemo(() => pendingIds(acks), [acks]);
  useEffect(() => { const next = pruneAcks(acksStore.getState().acks, alerts); if (next !== acksStore.getState().acks) acksStore.setState({ acks: next }); }, [alerts, acks]);
  const view = useMemo(() => buildCards(trayOrder(list, new Set(Object.keys(dismissed).map(Number)))), [list, dismissed]);
  const current = selected ?? roster[0]?.node_id ?? null;
  const flashing = new Set(view.cards.filter(isFlashing).map((c) => c.node_id));
  const isMin = (c: Card) => minimized[c.key] === c.sig;
  const show = (c: Card, dismissIds?: number[]) => (
    <AlertCard key={c.key} card={c} nodes={nodes} onSelect={selectNode} onMinimize={() => minimizeCard(c.key, c.sig)} onDismiss={dismissIds && (() => dismissAlerts(dismissIds))} pendingIds={pending}
      actions={c.kind === 'slim' ? undefined : <CardActions card={c} alias={nodes[c.node_id ?? -1]?.alias ?? 'Unknown node'} episodes={episodes} onAck={() => actions.acknowledge(ackTargets(c))} onResolve={actions.resolve} />} />
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
