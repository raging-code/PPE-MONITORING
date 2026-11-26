import { useEffect, useState } from 'react';
import type { LoginResult } from '../api/login.ts';

const MESSAGES: Record<string, string> = {
  origin: 'The host refused this page address. Open http://127.0.0.1:8420.',
  unreachable: 'Host not reachable.',
};

export default function LoginPage({ onLogin }: { onLogin: (token: string) => Promise<LoginResult> }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const h = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(h);
  }, [wait]);

  const submit = async () => {
    setBusy(true);
    const r = await onLogin(token.trim());
    setBusy(false);
    if (r.kind === 'ok') return;
    if (r.kind === 'rejected') {
      setMsg('Token not accepted' + (r.retryAfterS !== null ? '. Wait ' + r.retryAfterS + ' s before trying again.' : '.'));
      setWait(Math.ceil(r.retryAfterS ?? 0));
    } else {
      setMsg(r.kind === 'error' ? 'Login failed (status ' + r.status + ').' : MESSAGES[r.kind]);
    }
  };

  return (
    <main className="mx-auto mt-24 flex max-w-sm flex-col gap-4 rounded-card border border-card-border bg-white p-8 shadow-sm">
      <h1 className="text-xl font-bold">PPE Monitoring</h1>
      <label className="flex flex-col gap-2" htmlFor="token">
        Token
        <input id="token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)}
          className="min-h-11 rounded-lg border border-card-border px-3" />
      </label>
      <button type="button" disabled={busy || wait > 0 || token.trim() === ''} onClick={submit}
        className="min-h-11 rounded-lg bg-slate-800 px-4 font-semibold text-white disabled:opacity-50">
        Sign in
      </button>
      {msg && <p role="status" className="text-level-danger">{msg}</p>}
    </main>
  );
}
