// The event log's rows (3.11): filled from GET /api/events after a reload, then topped up from the last sequence number whenever live messages arrive.
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Api } from '../api/actions.ts';
import { getEvents, type LogRow } from '../api/events.ts';
import { mergeRows } from '../alerts/eventlog.ts';

export interface LogState { rows: LogRow[]; lastSeq: number; status: 'idle' | 'ok' | 'failed' }
const fresh = (): LogState => ({ rows: [], lastSeq: 0, status: 'idle' });
export const logStore = createStore<LogState>(fresh);
export const useLog = <T,>(pick: (s: LogState) => T): T => useStore(logStore, pick);
export const resetLog = () => logStore.setState(fresh());

export const PAGE = 1000; // the most GET /api/events returns per call (3.8)
const MAX_PAGES = 20; // a runaway host cannot keep the loop going
let inflight: Promise<void> | null = null;

// Pages forward from lastSeq until a short page. One run at a time; a failure keeps the rows already shown.
export function refreshLog(api: Api, page = PAGE): Promise<void> {
  inflight ??= (async () => {
    try {
      let after = logStore.getState().lastSeq, rows = logStore.getState().rows;
      for (let i = 0; i < MAX_PAGES; i++) {
        const r = await getEvents(api, after, page);
        if (r.kind !== 'ok') { logStore.setState({ status: 'failed' }); return; }
        rows = mergeRows(rows, r.body.events);
        const last = Math.max(after, r.body.last_seq, ...r.body.events.map((e) => e.event_seq));
        logStore.setState({ rows, lastSeq: last, status: 'ok' });
        if (r.body.events.length < page || last <= after) return;
        after = last;
      }
    } finally { inflight = null; }
  })();
  return inflight;
}
