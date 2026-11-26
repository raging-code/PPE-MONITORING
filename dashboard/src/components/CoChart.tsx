import type { TrendLimits } from '../alerts/trend.ts';
import { plot, TREND_WINDOW_MS } from '../alerts/trend.ts';

export interface CoChartProps { alias: string; history: number[][] | undefined; now: number; limits: TrendLimits; unreliable?: boolean }
const LINE = { x1: 0, x2: 100, vectorEffect: 'non-scaling-stroke', strokeDasharray: '2 4', strokeWidth: 2, stroke: 'currentColor' } as const;

// One small CO chart per responder (3.2, decided): the last 30 minutes in ppm with dotted lines at the warning and danger limits. Tier 1 has no
// forecast line. The line is neutral ink because the chart is a history, not a state: level colour stays on the cards. Labels are HTML, so they stay at 14 px
// or more however the box is stretched.
export default function CoChart({ alias, history, now, limits, unreliable }: CoChartProps) {
  const p = plot(history, now, limits), mins = TREND_WINDOW_MS / 60000;
  return (
    <section aria-label={`${alias} CO trend`} data-testid="co-chart" className="rounded-card border-2 border-card-border bg-white p-4 shadow-sm">
      <h2 className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xl font-bold">
        <span>{alias} CO, last {mins} minutes</span>
        <span className="text-base font-semibold" data-testid="co-now">{p.last ? `${p.last[1].toFixed(1)} ppm` : 'No CO readings yet'}</span>
      </h2>
      <div className="relative mt-6 h-32 text-ink">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`CO in ppm, last ${mins} minutes, with lines at ${limits.warn} and ${limits.danger} ppm`} className="h-full w-full">
          <line data-testid="line-warn" y1={p.yWarn} y2={p.yWarn} {...LINE} className="text-stale-text" />
          <line data-testid="line-danger" y1={p.yDanger} y2={p.yDanger} {...LINE} className="text-stale-text" />
          {p.segments.map((s, i) => <polyline key={i} data-testid="co-line" points={s} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
        </svg>
        <span className="absolute right-1 -translate-y-full bg-white px-1 text-sm font-semibold" style={{ top: `${p.yDanger}%` }}>{limits.danger} ppm danger</span>
        <span className="absolute right-1 -translate-y-full bg-white px-1 text-sm font-semibold" style={{ top: `${p.yWarn}%` }}>{limits.warn} ppm warning</span>
      </div>
      <p className="mt-1 flex justify-between text-sm text-stale-text"><span>{mins} min ago</span><span>now</span></p>
      {unreliable && <p role="status" className="mt-1 text-base font-semibold">CO unreliable: no new points on the line</p>}
    </section>
  );
}
