// Who wears which jacket (ADR 0071): node id -> the alias of the firefighter. Filled from GET /api/firefighters (WearerSync, and the Settings screen after a change). Not host wire data and never a name.
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Api } from '../api/actions.ts';
import { getFirefighters, wearersOf, type FirefighterRow } from '../api/firefighters.ts';

export interface WearerState { byNode: Record<number, string> }
export const wearerStore = createStore<WearerState>(() => ({ byNode: {} }));
export const useWearers = <T,>(pick: (s: WearerState) => T): T => useStore(wearerStore, pick);
export const setWearers = (rows: FirefighterRow[]) => wearerStore.setState({ byNode: wearersOf(rows) });
// A host that does not answer leaves the last list in place (the card keeps showing who was last known to wear it).
export async function loadWearers(api: Api): Promise<FirefighterRow[] | null> {
  const r = await getFirefighters(api);
  if (r.kind !== 'ok') return null;
  setWearers(r.body); return r.body;
}
