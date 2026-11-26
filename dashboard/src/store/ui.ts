// Screen state that is not host data: the selected jacket, minimized cards and dismissed estimates.
// Nothing here is written by an incoming message, so a new alert can never switch the selected jacket (3.3).
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export interface UiState {
  selected: number | null;
  minimized: Record<string, string>; // card key -> card signature when minimized; a new raise or a higher level reopens it
  dismissed: Record<number, true>;
}
export const uiStore = createStore<UiState>(() => ({ selected: null, minimized: {}, dismissed: {} }));
export const useUi = <T,>(pick: (s: UiState) => T): T => useStore(uiStore, pick);

export const selectNode = (id: number) => uiStore.setState({ selected: id });
export const minimizeCard = (key: string, sig: string) => uiStore.setState((s) => ({ minimized: { ...s.minimized, [key]: sig } }));
export const restoreCard = (key: string) => uiStore.setState((s) => { const m = { ...s.minimized }; delete m[key]; return { minimized: m }; });
export const dismissAlerts = (ids: number[]) => uiStore.setState((s) => ({ dismissed: { ...s.dismissed, ...Object.fromEntries(ids.map((i) => [i, true as const])) } }));
