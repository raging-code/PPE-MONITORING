// e2e/mock_host.mjs (P27-3, ADR 0042): a stand-in for the host that serves the BUILT dashboard (dashboard/dist) and speaks just enough of the
// design 3.8 wire protocol for the browser tests: POST /api/login, POST /api/session/start, the /ws data socket (snapshot first, then a tick every second)
// and the /ws/tick socket of the worker. It is not the host: the real host is covered by pytest. What runs for real here is the dashboard, in Chromium.
// Test control (not part of any design interface, loopback only): POST /__ctl {"mode":"live"|"muted"|"dead","reset":true,"abi_mismatch":true|false,"alert":{"alert_id":n,"alert_type":"man_down","level":"DANGER","cleared":true|false}}, GET /__state.
//   alert  : one alert message to every signed-in data socket (a raise, or with cleared:true the clear plus acknowledge that makes the dashboard drop it). Sent unless the mode is dead.
//   live   : snapshot and a tick every second on both sockets.
//   muted  : the sockets stay open but nothing is sent (a host that stalled; this is the NO LIVE DATA case of 3.7).
//   dead   : the sockets accept and authenticate but send nothing at all, not even the snapshot (a host that never answers).
// `node e2e/mock_host.mjs --print-messages` prints the two server messages it sends as JSON, for the pytest check against the Pydantic models.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dashboard', 'dist');
const CONSTANTS = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'shared', 'constants.json'), 'utf8'));
export const PORT = Number(process.env.E2E_PORT ?? 8431), HOST = '127.0.0.1', TOKEN = 'e2e-token';

export const snapshotMessage = (now, abi = false) => ({
  v: 1, type: 'snapshot', srv_seq: 0, srv_ts: now, epoch: '5d1f7c3a-2b64-4e0f-9a51-3c7e8d2b6a10', recovering: false, monitoring_active: false,
  session: { session_id: 1, started_ts: now, mode: 'SIMULATOR', session_label: 'e2e' },
  roster: [{ node_id: 1, alias: 'FF-01', active: 1 }],
  nodes: [{ node_id: 1, alias: 'FF-01', last_rx_ts: now, co_ppm: 12, temp_c: 31.2, hum_pct: 44, motion_g: 0.08, bat_pct: 86,
    scba: 1, mandown: 0, level: 'NORMAL', link_state: 'ok', status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0,
    co_validity: 'VALID', co_reason: null, scba_correction: null }],
  open_alerts: [], open_episodes: [], co_history_30m: { '1': [[now, 12]] },
  banners: { base_offline: false, logging_fault: false, host_gap: null, host_power: 'ac', audio_fault: false, abi_mismatch: abi },
  constants: CONSTANTS,
});
export const tickMessage = (seq, now) => ({ v: 1, type: 'tick', srv_seq: seq, srv_ts: now });
export const systemMessage = (seq, now, abi) => ({ v: 1, type: 'system', srv_seq: seq, srv_ts: now, base: 'ok', recovering: false, session_id: 1, session_mode: 'SIMULATOR', rejected_frames: 0,
  logging_fault: false, host_gap: null, host_power: 'ac', audio_fault: false, abi_mismatch: abi, banner: null, acknowledged_ts: null });
export const alertMessage = (seq, now, a) => ({ v: 1, type: 'alert', srv_seq: seq, srv_ts: now, alert_id: a.alert_id, node_id: 1, alert_type: a.alert_type ?? 'man_down', level: a.level ?? 'DANGER',
  reasons: null, authenticated: 1, episode_id: null, raised_ts: now, cleared_ts: a.cleared ? now : null, acknowledged_ts: a.cleared ? now : null, acknowledged_by: a.cleared ? 1 : null,
  unauth_count: null, last_seen_ts: null });

if (process.argv.includes('--print-messages')) {
  console.log(JSON.stringify([snapshotMessage(1_700_000_000_000), tickMessage(1, 1_700_000_001_000)]));
  process.exit(0);
}
if (process.argv.includes('--print-alert')) { console.log(JSON.stringify(alertMessage(1, 1_700_000_001_000, { alert_id: 1 }))); process.exit(0); }   // for the pytest check against the Pydantic models
const { WebSocketServer } = await import('ws');                                  // after --print-messages, so that mode needs no npm install
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dashboard/dist/index.html is missing: build the dashboard first (just build, or: cd dashboard; npm run build).');
  process.exit(1);
}

const state = { mode: 'live', lastTickAt: 0, startCount: 0, logins: 0, abi_mismatch: false };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.stl': 'model/stl' };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); });
const bearerOk = (req) => req.headers.authorization === `Bearer ${TOKEN}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  if (url.pathname === '/__state') return json(res, 200, state);
  if (url.pathname === '/__ctl' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.reset) { state.startCount = 0; state.logins = 0; state.lastTickAt = 0; state.abi_mismatch = false; }
    if (['live', 'muted', 'dead'].includes(b.mode)) state.mode = b.mode;
    if (typeof b.abi_mismatch === 'boolean' && b.abi_mismatch !== state.abi_mismatch) {   // the base reports a different ABI (or agrees again): one system message, like the host
      state.abi_mismatch = b.abi_mismatch;
      if (state.mode === 'live') for (const c of clients) if (c.authed && c.kind === 'data' && c.ws.readyState === 1) c.ws.send(JSON.stringify(systemMessage(++c.seq, Date.now(), state.abi_mismatch)));
    }
    if (b.alert && state.mode !== 'dead') for (const c of clients) if (c.authed && c.kind === 'data' && c.ws.readyState === 1) c.ws.send(JSON.stringify(alertMessage(++c.seq, Date.now(), b.alert)));
    return json(res, 200, state);
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.token !== TOKEN) return json(res, 401, { error_code: 'UNAUTHENTICATED', detail: 'token not accepted', retry_after_s: null });
    state.logins += 1;
    return json(res, 200, { operator_id: 1, display_name: 'E2E', session_id: 1 });
  }
  if (url.pathname === '/api/session/start' && req.method === 'POST') {
    if (!bearerOk(req)) return json(res, 401, { error_code: 'UNAUTHENTICATED', detail: 'no token', retry_after_s: null });
    state.startCount += 1;
    return json(res, 200, { session_id: 1, started_ts: Date.now(), mode: 'SIMULATOR', monitoring_active: true });
  }
  if (url.pathname === '/api/events') return json(res, 200, { events: [], last_seq: 0 });
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error_code: 'NOT_FOUND', detail: 'not part of the e2e mock', retry_after_s: null });
  // Static files of the built dashboard. A path outside dist is refused; an unknown path gets index.html.
  let file = path.resolve(DIST, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(DIST + path.sep) && file !== DIST) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// Both sockets: the first message must be auth with the right token, else close 4401 (design 3.8).
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url ?? '/', `http://${HOST}`).pathname;
  if (p !== '/ws' && p !== '/ws/tick') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const c = { ws, kind: p === '/ws' ? 'data' : 'tick', authed: false, seq: 0 };
    clients.add(c);
    ws.on('close', () => clients.delete(c));
    ws.on('error', () => clients.delete(c));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (!c.authed) {
        if (m.type !== 'auth' || m.token !== TOKEN) { ws.close(4401); return; }
        c.authed = true;
        if (c.kind === 'data' && state.mode !== 'dead') ws.send(JSON.stringify(snapshotMessage(Date.now(), state.abi_mismatch)));
      }
    });
  });
});

setInterval(() => {
  if (state.mode !== 'live') return;
  const now = Date.now(); state.lastTickAt = now;
  for (const c of clients) if (c.authed && c.ws.readyState === 1) c.ws.send(JSON.stringify(tickMessage(++c.seq, now)));
}, 1000);

server.listen(PORT, HOST, () => console.log(`e2e mock host on http://${HOST}:${PORT} (dashboard: ${DIST})`));
