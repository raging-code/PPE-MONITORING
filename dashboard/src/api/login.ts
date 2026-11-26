// POST /api/login (design 3.8). The host waits out the failed-login delay before it answers 401,
// so the page only shows retry_after_s; it does not time the delay itself.
export type LoginResult =
  | { kind: 'ok'; operatorId: number; displayName: string; sessionId: number }
  | { kind: 'rejected'; retryAfterS: number | null }
  | { kind: 'origin' }
  | { kind: 'unreachable' }
  | { kind: 'error'; status: number };

export async function postLogin(token: string, fetchFn: typeof fetch = fetch): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetchFn('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  let body: Record<string, unknown> = {};
  try { body = await res.json(); } catch { /* an empty or non-JSON body is handled by status */ }
  if (res.status === 200) {
    return { kind: 'ok', operatorId: Number(body.operator_id), displayName: String(body.display_name), sessionId: Number(body.session_id) };
  }
  if (res.status === 401) return { kind: 'rejected', retryAfterS: typeof body.retry_after_s === 'number' ? body.retry_after_s : null };
  if (res.status === 403) return { kind: 'origin' };
  return { kind: 'error', status: res.status };
}
