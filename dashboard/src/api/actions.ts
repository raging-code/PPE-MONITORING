// REST actions of design 3.8: Acknowledge an alert, Acknowledge an episode, Resolve an episode. Bearer token on every call.
// Each call returns one outcome, so the caller decides about retries; nothing here throws.
export const RESOLVE_REASONS = ['rescued', 'false_alarm', 'device_removed'] as const;
export type ResolveReason = (typeof RESOLVE_REASONS)[number];
export const REASON_LABEL: Record<ResolveReason, string> = { rescued: 'Rescued', false_alarm: 'False alarm', device_removed: 'Device removed' };

export type ActionResult<T> =
  | { kind: 'ok'; body: T }
  | { kind: 'gone' } // 404: the host has no such alert or episode
  | { kind: 'conflict' } // 409 STATE_CONFLICT: already in the target state
  | { kind: 'bad'; status: number; detail: string } // 400 or 422: the request itself was refused
  | { kind: 'auth' } // 401 or 403: retrying cannot help
  | { kind: 'retry' }; // network failure or 5xx: worth another try

export interface AckBody { acknowledged_ts: number }
export interface ResolveBody { resolved_ts: number; resolve_reason: ResolveReason; latch_still_set: boolean }
export interface Api { fetchFn: typeof fetch; getToken: () => string | null }

async function post<T>(api: Api, path: string, body: unknown): Promise<ActionResult<T>> {
  let res: Response;
  try {
    res = await api.fetchFn(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.getToken() ?? ''}` }, body: JSON.stringify(body) });
  } catch {
    return { kind: 'retry' };
  }
  let j: Record<string, unknown> = {};
  try { j = await res.json(); } catch { /* an empty body is handled by status */ }
  if (res.status === 200) return { kind: 'ok', body: j as T };
  if (res.status === 401 || res.status === 403) return { kind: 'auth' };
  if (res.status === 404) return { kind: 'gone' };
  if (res.status === 409) return { kind: 'conflict' };
  if (res.status === 400 || res.status === 422) return { kind: 'bad', status: res.status, detail: String(j.detail ?? 'refused') };
  return { kind: 'retry' };
}
export const postAlertAck = (api: Api, id: number) => post<AckBody>(api, `/api/alerts/${id}/ack`, {});
export const postEpisodeAck = (api: Api, id: number) => post<AckBody>(api, `/api/episodes/${id}/ack`, {});
export const postResolve = (api: Api, id: number, reason: ResolveReason) => post<ResolveBody>(api, `/api/episodes/${id}/resolve`, { reason });

// Words for the Resolve outcome. The latch stays set after Resolve: only the jacket CANCEL clears it (3.3).
export function resolveMessage(r: ActionResult<ResolveBody>): string {
  switch (r.kind) {
    case 'ok': return r.body.latch_still_set ? 'Resolved. The jacket latch is still set: only the CANCEL button on the jacket clears it.' : 'Resolved.';
    case 'conflict': return 'Already resolved.';
    case 'gone': return 'Episode not found on the host.';
    case 'bad': return `Not accepted: ${r.detail}`;
    case 'auth': return 'Not signed in. Log in again.';
    case 'retry': return 'The host did not answer. Try again.';
  }
}

// POST /api/dashboard-outage (design 3.8): the page reports a NO LIVE DATA period after the host answers again. Times are UTC ms.
export interface OutageBody { started_ts: number; ended_ts: number; duration_s: number }
export const postOutage = (api: Api, b: OutageBody) => post<{ logged: boolean }>(api, '/api/dashboard-outage', b);
