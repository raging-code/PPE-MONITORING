// POST /api/login and POST /api/logout (design 3.8, ADR 0056). The host waits out the failed-login delay before it answers 401,
// so the page only shows retry_after_s; it does not time the delay itself. A locked operator gets an immediate 401 whose
// retry_after_s is the seconds left, which can be up to 900.
export type LoginResult =
  | { kind: 'ok'; operatorId: number; displayName: string; sessionId: number; sessionToken?: string } // sessionToken: the PIN form only
  | { kind: 'rejected'; retryAfterS: number | null }
  | { kind: 'origin' }
  | { kind: 'unreachable' }
  | { kind: 'error'; status: number };

async function send(body: Record<string, unknown>, fetchFn: typeof fetch): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetchFn('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  let reply: Record<string, unknown> = {};
  try { reply = await res.json(); } catch { /* an empty or non-JSON body is handled by status */ }
  if (res.status === 200) {
    return {
      kind: 'ok', operatorId: Number(reply.operator_id), displayName: String(reply.display_name), sessionId: Number(reply.session_id),
      ...(typeof reply.session_token === 'string' ? { sessionToken: reply.session_token } : {}),
    };
  }
  if (res.status === 401) return { kind: 'rejected', retryAfterS: typeof reply.retry_after_s === 'number' ? reply.retry_after_s : null };
  if (res.status === 403) return { kind: 'origin' };
  return { kind: 'error', status: res.status };
}

// The operator token form (the admin and break-glass login).
export function postLogin(token: string, fetchFn: typeof fetch = fetch): Promise<LoginResult> {
  return send({ token }, fetchFn);
}

// The name and PIN form. A 200 without a session_token is a host fault, not a login.
export async function postPinLogin(displayName: string, pin: string, remember: boolean, fetchFn: typeof fetch = fetch): Promise<LoginResult> {
  const r = await send({ display_name: displayName, pin, remember }, fetchFn);
  return r.kind === 'ok' && !r.sessionToken ? { kind: 'error', status: 200 } : r;
}

// Ends the login session of this token on the host. Best effort: true when the host answered 200 (it does so for an operator token too,
// with nothing to revoke). A host that is down gives false, and the page logs out locally anyway.
export async function postLogout(token: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    return res.status === 200;
  } catch {
    return false;
  }
}
