// REST calls of the shift screens (design 3.8, 3.10): the Sessions list, End shift and the CSV download. Same outcomes as api/actions.ts.
import { request, type ActionResult, type Api } from './actions.ts';

export interface SessionRow {
  session_id: number; started_ts: number; ended_ts: number | null; duration_s: number;
  mode: 'LIVE' | 'SIMULATOR' | 'REPLAY'; session_label: string | null; end_kind: 'ENDED' | 'CLEAN_SHUTDOWN' | 'ABANDONED' | null;
  alert_count: number; unresolved_episodes: number; highest_level_by_node: Record<string, 'WARNING' | 'DANGER'>;
}
export interface EndBody { closed_session_id: number; new_session_id: number; backup_ok: boolean }

export const getSessions = (api: Api, limit = 50): Promise<ActionResult<SessionRow[]>> => request<SessionRow[]>(api, 'GET', `/api/sessions?limit=${limit}`);
// The host checks confirm_text and that session_id is still the open session (a second tab that already ended the shift gets STATE_CONFLICT).
export const postSessionEnd = (api: Api, sessionId: number): Promise<ActionResult<EndBody>> => request<EndBody>(api, 'POST', '/api/session/end', { confirm_text: 'END', session_id: sessionId });

export function endMessage(r: ActionResult<EndBody>): string | null {
  switch (r.kind) {
    case 'ok': return null;
    case 'conflict': return r.code === 'RECOVERING'
      ? `The host is recovering. Try again${r.retryAfterS ? ` in ${Math.ceil(r.retryAfterS)} s` : ' in a moment'}.`
      : 'The shift was already ended from another screen.';
    case 'auth': return 'Not signed in. Log in again.';
    case 'retry': return 'The host did not answer. Try again.';
    case 'gone': return 'The host has no such session.';
    case 'bad': return `Not accepted: ${r.detail}`;
  }
}

// CSV (3.8): an authenticated fetch, then a blob and an object URL, never a plain link (a link carries no Authorization header).
export type CsvResult = { kind: 'ok'; blob: Blob } | { kind: 'auth' } | { kind: 'failed' };
export async function fetchCsv(api: Api, sessionId: number): Promise<CsvResult> {
  try {
    const res = await api.fetchFn(`/api/export.csv?session_id=${sessionId}`, { method: 'GET', headers: { Authorization: `Bearer ${api.getToken() ?? ''}` } });
    if (res.status === 200) return { kind: 'ok', blob: await res.blob() };
    return res.status === 401 || res.status === 403 ? { kind: 'auth' } : { kind: 'failed' };
  } catch { return { kind: 'failed' }; }
}
export interface SaveDeps { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void; click: (url: string, filename: string) => void }
export const realSaveDeps = (): SaveDeps => ({
  createObjectURL: (b) => URL.createObjectURL(b), revokeObjectURL: (u) => URL.revokeObjectURL(u),
  click: (url, filename) => { const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); },
});
export async function downloadCsv(api: Api, sessionId: number, deps: SaveDeps = realSaveDeps()): Promise<'saved' | 'auth' | 'failed'> {
  const r = await fetchCsv(api, sessionId);
  if (r.kind !== 'ok') return r.kind === 'auth' ? 'auth' : 'failed';
  const url = deps.createObjectURL(r.blob);
  deps.click(url, `session-${sessionId}.csv`);
  deps.revokeObjectURL(url);
  return 'saved';
}
