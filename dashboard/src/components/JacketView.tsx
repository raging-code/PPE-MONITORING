import { Component, type ComponentType, type ReactNode } from 'react';
import ComponentGrid, { type GridProps } from './ComponentGrid.tsx';

// Error boundary of the jacket view (3.7): if the grid cannot draw, only the grid is replaced by a line. Readings, cards, pop-ups
// and Resolve are outside this boundary and never depend on it.
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.error('Jacket view failed', e); }
  render() { return this.state.failed ? <p role="status" data-testid="jacket-fallback" className="rounded-card border-2 border-dashed border-stale-text p-4 text-base font-semibold">Jacket view unavailable</p> : this.props.children; }
}
// key = node id: a failure on one responder does not hide the grid of the next one.
export default function JacketView({ grid: Grid = ComponentGrid, ...props }: GridProps & { grid?: ComponentType<GridProps> }): ReactNode {
  return <Boundary key={props.node.node_id}><Grid {...props} /></Boundary>;
}
