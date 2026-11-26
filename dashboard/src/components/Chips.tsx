import { useMemo } from 'react';
import { overlayAcks } from '../alerts/ack.ts';
import { chipText, buildCards } from '../alerts/group.ts';
import { trayOrder } from '../alerts/rules.ts';
import { levelView } from '../alerts/style.ts';
import { cn } from '../lib/utils.ts';
import { useLive } from '../store/live.ts';
import { restoreCard, useUi } from '../store/ui.ts';
import { useAcks } from '../store/actions.ts';

// Chips of minimized alerts (3.3). They sit first in the top strip, above the banners, so a minimized danger alert is never scrolled out of sight.
export default function Chips() {
  const alerts = useLive((s) => s.alerts), nodes = useLive((s) => s.nodes), now = useLive((s) => s.lastSrvTs), acks = useAcks((s) => s.acks);
  const minimized = useUi((s) => s.minimized), dismissed = useUi((s) => s.dismissed);
  const view = useMemo(() => buildCards(trayOrder(overlayAcks(Object.values(alerts), acks), new Set(Object.keys(dismissed).map(Number)))), [alerts, acks, dismissed]);
  return (
    <nav aria-label="Minimized alerts" className="flex shrink-0 flex-wrap gap-2 px-4 py-1 empty:hidden">
      {[...view.cards, ...view.slim].filter((c) => minimized[c.key] === c.sig).map((c) => (
        <button key={c.key} type="button" data-testid={`chip-${c.key}`} onClick={() => restoreCard(c.key)}
          className={cn('min-h-11 rounded-full border-2 px-4 text-base font-semibold', c.kind === 'responder' ? levelView(c.level).box : 'border-dashed border-stale-text bg-white text-stale-text')}>
          {chipText(c, nodes, now)}
        </button>
      ))}
    </nav>
  );
}
