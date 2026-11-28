// Who wears which jacket (ADR 0071, 0072): node id -> the alias of the firefighter, and the active firefighters (alias only, never a name) for the Start monitoring check.
// Filled from GET /api/firefighters (WearerSync, and the Settings screen after a change). Not host wire data.
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Api } from '../api/actions.ts';
import { getFirefighters, wearersOf, type FirefighterRow } from '../api/firefighters.ts';

export interface Person { firefighter_id: number; alias: string; node_id: number | null }
export interface WearerState { byNode: Record<number, string>; people: Person[] | null; confirmedSig: string | null }
const START: WearerState = { byNode: {}, people: null, confirmedSig: null };
export const wearerStore = createStore<WearerState>(() => START);
export const useWearers = <T,>(pick: (s: WearerState) => T): T => useStore(wearerStore, pick);

// Who is on which node, as one string: the person confirmed it, and a later change by anyone makes the string differ, so the confirmation lapses.
export const sigOf = (people: Person[]): string => people.filter((p) => p.node_id !== null).map((p) => `${p.node_id}:${p.firefighter_id}`).sort().join(',');
// Start monitoring waits for the confirmation only when the host has firefighters. A host that did not answer, or has none yet, never blocks it.
export const startBlocked = (s: WearerState): boolean => s.people !== null && s.people.length > 0 && s.confirmedSig !== sigOf(s.people);

export const setWearers = (rows: FirefighterRow[]) => wearerStore.setState({ byNode: wearersOf(rows), people: rows.filter((r) => r.active).map((r) => ({ firefighter_id: r.firefighter_id, alias: r.alias, node_id: r.node_id })) });
export const confirmWearers = () => wearerStore.setState((s) => ({ confirmedSig: s.people === null ? null : sigOf(s.people) }));
export const resetWearers = () => wearerStore.setState(START);
// A host that does not answer leaves the last list in place (the card keeps showing who was last known to wear it).
export async function loadWearers(api: Api): Promise<FirefighterRow[] | null> {
  const r = await getFirefighters(api);
  if (r.kind !== 'ok') return null;
  setWearers(r.body); return r.body;
}

// One pick per active node ('' = nobody; a node left out keeps who it has). Returns the calls in an order the host accepts: first every jacket that changes hands is ended, then the new wearers are put on,
// so two people can swap nodes. null when one person is picked for two nodes.
export interface Call { node_id: number; firefighter_id: number | null }
export function planConfirm(nodeIds: number[], people: Person[], pick: Record<number, string>): Call[] | null {
  const now = (n: number) => people.find((p) => p.node_id === n)?.firefighter_id ?? null;
  const want = (n: number): number | null => { const v = pick[n]; return v === undefined ? now(n) : v === '' ? null : Number(v); };
  const chosen = nodeIds.map(want).filter((x): x is number => x !== null);
  if (new Set(chosen).size !== chosen.length) return null;
  const changed = nodeIds.filter((n) => want(n) !== now(n));
  return [...changed.filter((n) => now(n) !== null).map((n) => ({ node_id: n, firefighter_id: null })), ...changed.filter((n) => want(n) !== null).map((n) => ({ node_id: n, firefighter_id: want(n) }))];
}
// The people one node's list may offer: anyone not picked for another node who is free, on this node, or on a node whose pick moves them off it.
export function optionsFor(nodeId: number, nodeIds: number[], people: Person[], pick: Record<number, string>): Person[] {
  const now = (n: number) => people.find((p) => p.node_id === n)?.firefighter_id ?? null;
  const want = (n: number): number | null => { const v = pick[n]; return v === undefined ? now(n) : v === '' ? null : Number(v); };
  return people.filter((p) => !nodeIds.some((n) => n !== nodeId && want(n) === p.firefighter_id) && (p.node_id === null || p.node_id === nodeId || !nodeIds.includes(p.node_id) || want(p.node_id) !== p.firefighter_id));
}
