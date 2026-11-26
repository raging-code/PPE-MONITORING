import { useEffect, useMemo, type ComponentType } from 'react';
import { CONSTANTS } from '../gen/constants.ts';
import { ackTargets, overlayAcks, pendingIds, pruneAcks } from '../alerts/ack.ts';
import { badgesFor, trayOrder } from '../alerts/rules.ts';
import { buildCards, chipText, isFlashing, type Card } from '../alerts/group.ts';
import { levelView } from '../alerts/style.ts';
import { cn } from '../lib/utils.ts';
import { useLive } from '../store/live.ts';
import { dismissAlerts, minimizeCard, restoreCard, selectNode, useUi } from '../store/ui.ts';
import { acksStore, defaultActions, useAcks, type Actions } from '../store/actions.ts';
import AlertCard from './AlertCard.tsx';
import JacketView, { Boundary } from './JacketView.tsx';
import CoChart from './CoChart.tsx';
import { limitsFrom } from '../alerts/trend.ts';
import CardActions from './CardActions.tsx';
import type { GridProps } from './ComponentGrid.tsx';
import NodeCard from './NodeCard.tsx'; // P22c-3: the never-heard card
import NotConnectedCard from './NotConnectedCard.tsx';

// Node cards, chips of minimized alerts and the tray. The tray is in normal flow, so it pushes the page down and covers no reading (3.3).
// Layout (3.7): the chips and the tray sit outside the scrolling readings area. The tray is capped at 40% of the window and scrolls inside itself, danger first.
// Chips move to the top strip in P22d.
export default function LiveScreen({ actions = defaultActions, grid }: { actions?: Actions; grid?: ComponentType<GridProps> }) {
  const alerts = useLive((s) => s.alerts), nodes = useLive((s) => s.nodes), roster = useLive((s) => s.roster), now = useLive((s) => s.lastSrvTs), episodes = useLive((s) => s.episodes), acks = useAcks((s) => s.acks), consts = useLive((s) => s.constants);
  const monitoring = useLive((s) => s.monitoringActive), selected = useUi((s) => s.selected), minimized = useUi((s) => s.minimized), dismissed = useUi((s) => s.dismissed);
  const list = useMemo(() => overlayAcks(Object.values(alerts), acks), [alerts, acks]);
  const pending = useMemo(() => pendingIds(acks), [acks]);
  useEffect(() => { const next = pruneAcks(acksStore.getState().acks, alerts); if (next !== acksStore.getState().acks) acksStore.setState({ acks: next }); }, [alerts, acks]);
  const view = useMemo(() => buildCards(trayOrder(list, new Set(Object.keys(dismissed).map(Number)))), [list, dismissed]);
  const current = selected ?? roster[0]?.node_id ?? null;
  const coHistory = useLive((s) => s.coHistory), limits = useMemo(() => limitsFrom(consts), [consts]);
  const flashing = new Set(view.cards.filter(isFlashing).map((c) => c.node_id));
  const isMin = (c: Card) => minimized[c.key] === c.sig;
  const visible = [...view.cards, ...view.slim].filter((c) => !isMin(c)).length; // an empty tray takes no space
  const show = (c: Card, dismissIds?: number[]) => (
    <AlertCard key={c.key} card={c} nodes={nodes} onSelect={selectNode} onMinimize={() => minimizeCard(c.key, c.sig)} onDismiss={dismissIds && (() => dismissAlerts(dismissIds))} pendingIds={pending}
      actions={c.kind === 'slim' ? undefined : <CardActions card={c} alias={nodes[c.node_id ?? -1]?.alias ?? 'Unknown node'} episodes={episodes} onAck={() => actions.acknowledge(ackTargets(c))} onResolve={actions.resolve} />} />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="live">
      <main className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      {roster.some((r) => r.active) ? (
        <div className="grid gap-4 md:grid-cols-3">
          {roster.filter((r) => r.active).map((r) => nodes[r.node_id] && nodes[r.node_id].last_rx_ts !== null
            ? <NodeCard key={r.node_id} node={nodes[r.node_id]} badges={badgesFor(list, r.node_id)} flashing={flashing.has(r.node_id)} selected={current === r.node_id} onSelect={selectNode} />
            : <NotConnectedCard key={r.node_id} alias={r.alias} notReady={!monitoring} />)}
        </div>
      ) : <p className="text-xl font-semibold text-stale-text">No responders on the roster</p>}
      {current !== null && nodes[current] && (
        <JacketView grid={grid} node={nodes[current]} alerts={list}
          limits={{ bat_warn_pct: Number(consts.bat_warn_pct ?? CONSTANTS.bat_warn_pct), co_clamp_max_ppm: Number(consts.co_clamp_max_ppm ?? CONSTANTS.co_clamp_max_ppm) }} />
      )}
      {current !== null && nodes[current] && (
        <Boundary key={current} text="Chart unavailable">
          <CoChart alias={nodes[current].alias} history={coHistory[current]} now={now ?? 0} limits={limits} unreliable={nodes[current].co_validity === 'UNRELIABLE'} />
        </Boundary>
      )}
      </main>
      <nav aria-label="Minimized alerts" className="flex shrink-0 flex-wrap gap-2 px-4 py-1 empty:hidden">
        {[...view.cards, ...view.slim].filter(isMin).map((c) => (
          <button key={c.key} type="button" data-testid={`chip-${c.key}`} onClick={() => restoreCard(c.key)}
            className={cn('min-h-11 rounded-full border-2 px-4 text-base font-semibold', c.kind === 'responder' ? levelView(c.level).box : 'border-dashed border-stale-text bg-white text-stale-text')}>
            {chipText(c, nodes, now)}
          </button>
        ))}
      </nav>
      <section aria-label="Alerts" data-testid="tray" className={cn('max-h-[40dvh] shrink-0 space-y-4 overflow-y-auto bg-page', visible > 0 && 'border-t-2 border-card-border p-4')}>
        <div className="grid gap-4 md:grid-cols-3">{view.cards.filter((c) => !isMin(c)).map((c) => show(c))}</div>
        <div className="grid gap-2">{view.slim.filter((c) => !isMin(c)).map((c) => show(c, c.lines.flatMap((l) => l.ids)))}</div>
      </section>
    </div>
  );
}
