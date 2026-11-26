import type { ReactNode } from 'react';
import type { NodeSnap } from '../gen/ws.ts';
import type { ReadingDetail } from '../store/reducer.ts';
import { advisoryLine, readingRows, type ReadingLimits } from '../alerts/readings.ts';
import { cn } from '../lib/utils.ts';

export interface SidePanelProps {
  node: NodeSnap; now: number | null; detail?: ReadingDetail; k: ReadingLimits;
  advisory?: { risk: string; action: string; quality: 'high' | 'medium' | 'low' };
  children?: ReactNode; // the one CO chart slot (3.1)
}
// Side panel (3.1, 3.2): at most 8 rows, the advisory line and one chart. Grey is text colour only, so no new colour pair is introduced.
export default function SidePanel({ node, now, detail, k, advisory, children }: SidePanelProps) {
  const rows = readingRows(node, now, detail, k), last = rows[rows.length - 1], adv = advisory && advisoryLine(advisory);
  return (
    <aside aria-label="Readings" data-testid="side" className="space-y-3 rounded-card border-2 border-card-border bg-white p-4 shadow-sm">
      <h2 className="text-xl font-bold">{node.alias} readings</h2>
      <dl className="m-0 space-y-2">
        {rows.slice(0, -1).map((r) => (
          <div key={r.id} data-testid={`row-${r.id}`} data-tone={r.tone}>
            <dt className="text-sm font-semibold text-stale-text">{r.label}</dt>
            <dd className={cn('m-0 text-base font-bold', r.tone === 'grey' && 'text-stale-text', r.tone === 'warning' && 'underline decoration-2', r.tone === 'danger' && 'text-level-danger')}>
              <span aria-hidden="true">{r.tone === 'grey' ? '? ' : r.tone === 'warning' ? '▲ ' : r.tone === 'danger' ? '✖ ' : ''}</span>{r.text}
            </dd>
          </div>
        ))}
      </dl>
      <details data-testid={`row-${last.id}`}><summary className="min-h-11 cursor-pointer text-base font-semibold">{last.label}</summary><p className="m-0 text-base">{last.text}</p></details>
      {adv && <p data-testid="advisory-line" className={cn('m-0 text-base', adv.grey && 'text-stale-text')}>{adv.text} <span className="font-semibold">({adv.mark})</span></p>}
      <div data-testid="chart-slot">{children}</div>
    </aside>
  );
}
