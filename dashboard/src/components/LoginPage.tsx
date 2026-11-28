import { useEffect, useState } from 'react';
import type { LoginResult } from '../api/login.ts';

const MESSAGES: Record<string, string> = {
  origin: 'The host refused this page address. Open http://127.0.0.1:8420.',
  unreachable: 'Host not reachable.',
};
const PIN_OK = /^\d{6,12}$/; // the host takes 6 to 12 digits (ADR 0056)
const LONG_WAIT_S = 60; // a wait this long is the 15-minute lock, not the 1 to 5 s delay
const FIELD = 'min-h-11 rounded-lg border border-card-border px-3';
const PRIMARY = 'min-h-11 rounded-lg bg-slate-800 px-4 font-semibold text-white disabled:opacity-50';
const LINK = 'min-h-11 self-start text-base font-semibold text-slate-800 underline';

type Mode = 'pin' | 'token';
export interface LoginPageProps {
  onLogin: (token: string) => Promise<LoginResult>; // the operator token (admin and break-glass)
  onPinLogin: (name: string, pin: string, remember: boolean) => Promise<LoginResult>;
}

export default function LoginPage({ onLogin, onPinLogin }: LoginPageProps) {
  const [mode, setMode] = useState<Mode>('pin');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [remember, setRemember] = useState(false); // off by default (ADR 0056)
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const h = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(h);
  }, [wait]);

  const switchTo = (m: Mode) => { setMode(m); setMsg(null); setWait(0); setPin(''); setToken(''); };

  const failed = (r: Exclude<LoginResult, { kind: 'ok' }>) => {
    if (r.kind !== 'rejected') { setMsg(r.kind === 'error' ? 'Login failed (status ' + r.status + ').' : MESSAGES[r.kind]); return; }
    const s = r.retryAfterS;
    if (mode === 'token') setMsg('Token not accepted' + (s !== null ? '. Wait ' + s + ' s before trying again.' : '.'));
    else if (s !== null && s >= LONG_WAIT_S) setMsg('Too many wrong PINs. Try again in ' + Math.ceil(s / 60) + ' min, or sign in with the admin token.');
    else setMsg('Name or PIN not accepted' + (s !== null ? '. Wait ' + s + ' s before trying again.' : '.'));
    setWait(Math.ceil(s ?? 0));
  };

  const submit = async () => {
    setBusy(true);
    const r = mode === 'pin' ? await onPinLogin(name.trim(), pin, remember) : await onLogin(token.trim());
    setBusy(false);
    setPin(''); // the PIN is never kept on screen after an attempt
    if (r.kind === 'ok') return;
    failed(r);
  };

  const ready = mode === 'pin' ? name.trim() !== '' && PIN_OK.test(pin) : token.trim() !== '';

  return (
    <main className="mx-auto mt-24 flex max-w-sm flex-col gap-4 rounded-card border border-card-border bg-white p-8 shadow-sm">
      <h1 className="text-xl font-bold">PPE Monitoring</h1>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {mode === 'pin' ? (
          <>
            <label className="flex flex-col gap-2" htmlFor="name">
              Name
              <input id="name" type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
            </label>
            <div className="flex flex-col gap-2">
              <label htmlFor="pin">PIN</label>
              <input id="pin" type="password" inputMode="numeric" autoComplete="off" maxLength={12} aria-describedby="pin-hint" value={pin}
                onChange={(e) => setPin(e.target.value)} className={FIELD} />
              <span id="pin-hint" className="text-sm text-slate-700">6 to 12 digits</span>
            </div>
            <label className="flex min-h-11 items-start gap-3" htmlFor="remember">
              <input id="remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-1 size-5" />
              <span>
                Remember me on this browser
                <span className="block text-sm text-slate-700">Stays signed in after the browser is closed. Do not tick this on a shared station.</span>
              </span>
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-2" htmlFor="token">
            Token
            <input id="token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className={FIELD} />
          </label>
        )}
        <button type="submit" disabled={busy || wait > 0 || !ready} className={PRIMARY}>Sign in</button>
      </form>
      {msg && <p role="status" className="text-level-danger">{msg}</p>}
      <button type="button" className={LINK} onClick={() => switchTo(mode === 'pin' ? 'token' : 'pin')}>
        {mode === 'pin' ? 'Use the admin token instead' : 'Sign in with name and PIN'}
      </button>
    </main>
  );
}
