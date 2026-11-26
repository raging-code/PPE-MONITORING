// patches/part21b_login_nolivedata.mjs  (run from repo root: node patches/part21b_login_nolivedata.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
const putB64 = (p, b64) => put(p, Buffer.from(b64, 'base64').toString('utf8'));
const replace = (p, oldStr, newStr) => plan.push({ op: 'replace', p, oldStr, newStr });
const append = (p, text) => plan.push({ op: 'append', p, text });
function apply() {
  const state = new Map(), log = [];
  const get = (p) => state.has(p) ? state.get(p) : (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && cur !== s.content && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : cur === s.content ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) {
      throw new Error(`MISSING file: ${s.p}`);
    } else if (s.op === 'replace') {
      const n = cur.split(s.oldStr).length - 1;
      if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
      else if (n === 0 && cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else throw new Error(`ANCHOR found ${n} times in ${s.p}: ${s.oldStr.slice(0, 60)}`);
    } else if (s.op === 'append') {
      if (cur.includes(s.text)) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : '\n') + s.text); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : `OK: ${state.size} file(s) written`);
}
try { await run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }

// ---- write only this part below ----
async function run() {
  put('dashboard/src/api/login.ts', String.raw`// POST /api/login (design 3.8). The host waits out the failed-login delay before it answers 401,
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
`);
  put('dashboard/src/worker/bridge.ts', String.raw`// A Web Worker cannot read sessionStorage, so the main thread hands it the token (design 3.8):
// {type:'INIT_AUTH', token, ws_tick_url} on login and on reload. The same token is sent once.
export interface WorkerLike { postMessage(message: unknown): void }
export interface Bridge { init(token: string): void }

export function createBridge(worker: WorkerLike, wsTickUrl: string): Bridge {
  let sent: string | null = null;
  return {
    init(token) {
      if (token === sent) return;
      sent = token;
      worker.postMessage({ type: 'INIT_AUTH', token, ws_tick_url: wsTickUrl });
    },
  };
}
`);
  put('dashboard/src/worker/liveWatchdog.ts', String.raw`// P21b stub. P22c adds the /ws/tick socket here and the 4 s NO LIVE DATA judgement from server timestamps.
let auth: { token: string; wsTickUrl: string } | null = null;

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { type?: unknown; token?: unknown; ws_tick_url?: unknown } | null;
  if (m && m.type === 'INIT_AUTH' && typeof m.token === 'string' && typeof m.ws_tick_url === 'string') {
    auth = { token: m.token, wsTickUrl: m.ws_tick_url };
    self.postMessage({ type: 'INIT_ACK', ws_tick_url: auth.wsTickUrl });
  }
};

export {};
`);
  put('dashboard/src/app/runtime.ts', String.raw`import { controller } from '../store/live.ts';
import { createBridge, type Bridge } from '../worker/bridge.ts';
import type { Controller } from '../store/controller.ts';

let cached: { controller: Controller; bridge: Bridge } | null = null;

// Created on first use, once, so React StrictMode does not start two workers.
export function getRuntime(): { controller: Controller; bridge: Bridge } {
  if (!cached) {
    const worker = new Worker(new URL('../worker/liveWatchdog.ts', import.meta.url), { type: 'module' });
    const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    cached = { controller, bridge: createBridge(worker, scheme + window.location.host + '/ws/tick') };
  }
  return cached;
}
`);
  put('dashboard/src/components/NoLiveData.tsx', String.raw`// Full-screen red state (design 3.7). The repeating tone and the Web Worker judgement are P22c.
export default function NoLiveData() {
  return (
    <div role="alert" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-level-danger p-8 text-center text-white">
      <p className="text-3xl font-bold">NO LIVE DATA: responders are NOT being monitored</p>
      <p className="text-xl">Reconnecting to the host. Use the radio until this message clears.</p>
    </div>
  );
}
`);
  put('dashboard/src/components/LoginPage.tsx', String.raw`import { useEffect, useState } from 'react';
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
`);
  put('dashboard/src/components/Shell.tsx', String.raw`import { useEffect, useState } from 'react';
import { CONSTANTS } from '../gen/constants.ts';
import { useLive } from '../store/live.ts';
import { TOKEN_KEY, type Controller } from '../store/controller.ts';
import type { Bridge } from '../worker/bridge.ts';
import { postLogin } from '../api/login.ts';
import LoginPage from './LoginPage.tsx';
import NoLiveData from './NoLiveData.tsx';

export interface ShellProps {
  controller: Pick<Controller, 'start' | 'login'>;
  bridge: Bridge;
  fetchFn?: typeof fetch;
}

// True once active has been true for ms without a break.
function useActiveFor(active: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) { setLate(false); return; }
    const h = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(h);
  }, [active, ms]);
  return late;
}

export default function Shell({ controller, bridge, fetchFn }: ShellProps) {
  const conn = useLive((s) => s.conn);
  const staleS = useLive((s) => Number(s.constants.dashboard_stale_s ?? CONSTANTS.dashboard_stale_s));
  const noData = useActiveFor(conn === 'CONNECTING', staleS * 1000);

  useEffect(() => {
    controller.start(); // opens /ws when a token is stored, otherwise shows Login
    const token = window.sessionStorage.getItem(TOKEN_KEY);
    if (token) bridge.init(token); // reload: the worker needs the token again
  }, [controller, bridge]);

  const onLogin = async (token: string) => {
    const r = await postLogin(token, fetchFn);
    if (r.kind === 'ok') { controller.login(token); bridge.init(token); }
    return r;
  };

  if (conn === 'LOGIN') return <LoginPage onLogin={onLogin} />;
  if (conn === 'FORBIDDEN') return <main className="p-8 text-xl">The host refused this page address. Open http://127.0.0.1:8420.</main>;
  if (conn === 'CONNECTING') return noData ? <NoLiveData /> : <main className="p-8 text-xl">Connecting to the host...</main>;
  return <main className="p-4" data-testid="live">Connected</main>; // P22 builds the cards
}
`);
  put('dashboard/tests/bridge_login.test.ts', String.raw`import { describe, it, expect } from 'vitest';
import { createBridge } from '../src/worker/bridge.ts';
import { postLogin } from '../src/api/login.ts';

const reply = (status: number, body: unknown) => (async () => ({ status, json: async () => body })) as unknown as typeof fetch;

describe('Web Worker bridge (design 3.8)', () => {
  it('posts INIT_AUTH with the token and the tick URL', () => {
    const sent: unknown[] = [];
    createBridge({ postMessage: (m) => sent.push(m) }, 'ws://h/ws/tick').init('tok');
    expect(sent).toEqual([{ type: 'INIT_AUTH', token: 'tok', ws_tick_url: 'ws://h/ws/tick' }]);
  });
  it('sends the same token once and a new token again', () => {
    const sent: unknown[] = [];
    const b = createBridge({ postMessage: (m) => sent.push(m) }, 'u');
    b.init('a'); b.init('a'); b.init('b');
    expect(sent).toHaveLength(2);
  });
});

describe('postLogin (design 3.8 login row)', () => {
  it('200 gives the operator', async () => {
    const r = await postLogin('t', reply(200, { operator_id: 2, display_name: 'Ana', session_id: 4 }));
    expect(r).toEqual({ kind: 'ok', operatorId: 2, displayName: 'Ana', sessionId: 4 });
  });
  it('401 carries retry_after_s', async () => {
    expect(await postLogin('t', reply(401, { error_code: 'UNAUTHENTICATED', detail: 'x', retry_after_s: 2 }))).toEqual({ kind: 'rejected', retryAfterS: 2 });
  });
  it('403 is an origin refusal, 500 is a plain error', async () => {
    expect(await postLogin('t', reply(403, { error_code: 'ORIGIN_REJECTED', detail: 'x', retry_after_s: null }))).toEqual({ kind: 'origin' });
    expect(await postLogin('t', reply(500, {}))).toEqual({ kind: 'error', status: 500 });
  });
  it('a network failure means the host is not reachable', async () => {
    const down = (async () => { throw new TypeError('failed'); }) as unknown as typeof fetch;
    expect(await postLogin('t', down)).toEqual({ kind: 'unreachable' });
  });
});
`);
  put('dashboard/tests/shell.test.tsx', String.raw`// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import Shell from '../src/components/Shell.tsx';
import { liveStore } from '../src/store/live.ts';
import { initialState, apply } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { TOKEN_KEY } from '../src/store/controller.ts';
import { snapshot } from './helpers.ts';

const deps = () => ({ controller: { start: vi.fn(), login: vi.fn() }, bridge: { init: vi.fn() } });
const reply = (status: number, body: unknown) => (async () => ({ status, json: async () => body })) as unknown as typeof fetch;
const NLD = /NO LIVE DATA: responders are NOT being monitored/;

beforeEach(() => { window.sessionStorage.clear(); liveStore.setState(initialState('LOGIN')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Shell (P21 done-when)', () => {
  it('shows the Login page with one token field and a Sign in button', () => {
    render(<Shell {...deps()} />);
    expect(screen.queryByLabelText('Token')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeNull();
    expect(screen.queryByText(NLD)).toBeNull();
  });
  it('with the server off it shows NO LIVE DATA once dashboard_stale_s (4 s) has passed', () => {
    vi.useFakeTimers();
    liveStore.setState(initialState('CONNECTING'));
    render(<Shell {...deps()} />);
    expect(screen.queryByText(NLD)).toBeNull();
    act(() => { vi.advanceTimersByTime(3999); });
    expect(screen.queryByText(NLD)).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText(NLD)).not.toBeNull();
    expect(screen.queryByRole('alert')).not.toBeNull();
  });
  it('NO LIVE DATA clears on a snapshot and the 4 s count starts again after a drop', () => {
    vi.useFakeTimers();
    liveStore.setState(initialState('CONNECTING'));
    render(<Shell {...deps()} />);
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByText(NLD)).not.toBeNull();
    act(() => { liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state); });
    expect(screen.queryByText(NLD)).toBeNull();
    expect(screen.queryByTestId('live')).not.toBeNull();
    act(() => { liveStore.setState({ ...liveStore.getState(), conn: 'CONNECTING' }); });
    act(() => { vi.advanceTimersByTime(3999); });
    expect(screen.queryByText(NLD)).toBeNull();
  });
  it('a stored token on reload starts the socket and passes INIT_AUTH to the worker', () => {
    window.sessionStorage.setItem(TOKEN_KEY, 'tok');
    const d = deps();
    render(<Shell {...d} />);
    expect(d.controller.start).toHaveBeenCalled();
    expect(d.bridge.init).toHaveBeenCalledWith('tok');
  });
  it('a good login starts the socket and passes INIT_AUTH once', async () => {
    const d = deps();
    render(<Shell {...d} fetchFn={reply(200, { operator_id: 1, display_name: 'Ana', session_id: 4 })} />);
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(d.controller.login).toHaveBeenCalledWith('abc'));
    expect(d.bridge.init).toHaveBeenCalledWith('abc');
  });
  it('a rejected token shows "Token not accepted" with the delay and starts nothing', async () => {
    const d = deps();
    render(<Shell {...d} fetchFn={reply(401, { error_code: 'UNAUTHENTICATED', detail: 'x', retry_after_s: 2 })} />);
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(/Token not accepted\. Wait 2 s/);
    expect(d.controller.login).not.toHaveBeenCalled();
    expect(d.bridge.init).not.toHaveBeenCalled();
  });
});
`);
  put('docs/adr/0014.md', String.raw`# ADR 0014: Login page, NO LIVE DATA page and worker hand-off (P21b)

Status: Proposed (decided in the P21b session; confirm at the next design review).
Design: Rev 3.45 is frozen. Nothing in the frame, the migration, constants.json or ws.schema.json changes.

- **Login flow:** the page calls POST /api/login first (api/login.ts). Only a 200 stores the token and opens /ws, so a wrong token gets the REST answer: "Token not accepted" with retry_after_s (the host already waits the delay before it answers, ADR 0008), a 403 shows the origin message, a failed fetch shows "Host not reachable". The Sign in button stays disabled for retry_after_s.
- **NO LIVE DATA in P21b is a main-thread placeholder:** the page shows the full-screen red state when the data socket has not been LIVE for dashboard_stale_s (4 s, read from the snapshot constants, else from the generated CONSTANTS). Before that it shows a neutral "Connecting" line, so a normal start does not flash red. This is not the design's watchdog: the Web Worker with its own /ws/tick socket, the judgement from server timestamps, the repeating tone and the Silence 60 s control are P22c. A LIVE socket that goes quiet is not detected here.
- **Worker hand-off:** src/worker/bridge.ts posts {type:'INIT_AUTH', token, ws_tick_url} on login and on reload (once per token per page load). src/worker/liveWatchdog.ts is a stub that stores it and replies INIT_ACK. The design defines no message for a logout or a 4401, so none is sent; P22c decides how the worker stops (its own socket gets 4401 too).
- **Forbidden:** close code 4403 shows a plain message, not NO LIVE DATA, because retrying cannot fix it.
- **Tests:** component tests run in jsdom (Testing Library, a per-file environment comment); @testing-library/dom is added because Testing Library needs it as a peer dependency.
- **Not done here:** cards, alert tray, the Web Worker socket and siren, the tick-based 4 s rule (P22, P22c).
`);
  replace('dashboard/src/App.tsx', '// P21a placeholder: P21b replaces this line with the Login page and the NO LIVE DATA page.', "import Shell from './components/Shell.tsx';\nimport { getRuntime } from './app/runtime.ts';");
  replace('dashboard/src/App.tsx', '  return <main className="p-4">PPE Monitoring dashboard (scaffold)</main>;', '  const rt = getRuntime();\n  return <Shell controller={rt.controller} bridge={rt.bridge} />;');
  replace('dashboard/package.json', '"@tailwindcss/vite": "^4.1.0",\n    "@testing-library/react"', '"@tailwindcss/vite": "^4.1.0",\n    "@testing-library/dom": "^10.4.0",\n    "@testing-library/react"');
  append('docs/PROGRESS.md', '- Part 21b done: Login page (POST /api/login first, "Token not accepted" with retry_after_s, origin and unreachable messages), NO LIVE DATA full-screen page after dashboard_stale_s without a LIVE socket (main-thread placeholder; the worker watchdog is P22c), Shell that picks Login, Connecting, NO LIVE DATA, Forbidden or Connected by store state, src/worker/bridge.ts (INIT_AUTH on login and reload) and a worker stub, jsdom component tests, docs/adr/0014.md; P21 is complete; next is P22 (node cards, alert tray)');
}
