// e2e/mock_host.mjs (P27-3, ADR 0042): a stand-in for the host that serves the BUILT dashboard (dashboard/dist) and speaks just enough of the
// design 3.8 wire protocol for the browser tests: POST /api/login (the token form, and since P28-6 the PIN form of ADR 0056), POST /api/logout, POST /api/session/start, the /ws data socket (snapshot first, then a tick every second)
// and the /ws/tick socket of the worker. It is not the host: the real host is covered by pytest. What runs for real here is the dashboard, in Chromium.
// Test control (not part of any design interface, loopback only): POST /__ctl {"mode":"live"|"muted"|"dead","reset":true,"abi_mismatch":true|false,"alert":{"alert_id":n,"alert_type":"man_down","level":"DANGER","cleared":true|false}}, GET /__state.
//   expire : the PIN login session ends on the host (P28-6): the session token stops working and every socket that used it is closed with 4401, as the host does.
//   PIN form: name Ana, PIN 482913 gives the session token e2e-session-token and a /ws or REST call with it works until Log out or expire. A wrong PIN is a 401 with retry_after_s 1; the 5th wrong PIN in a row is a 401 with retry_after_s 900
//   and the PIN form stays locked (even the right PIN) for 15 minutes; the admin token e2e-token is never locked. /__state also counts pinLogins, logouts and wrongPins and shows lastRemember.
//   alert  : one alert message to every signed-in data socket (a raise, or with cleared:true the clear plus acknowledge that makes the dashboard drop it). Sent unless the mode is dead.
//   live   : snapshot and a tick every second on both sockets.
//   muted  : the sockets stay open but nothing is sent (a host that stalled; this is the NO LIVE DATA case of 3.7).
//   dead   : the sockets accept and authenticate but send nothing at all, not even the snapshot (a host that never answers).
//   replay : S7-5b (ADR 0062). {"replay":true} makes this a REPLAY host (session mode REPLAY, replay block {speed 16, paused false, finished false} in the snapshot and in every system message; false goes back to the simulator);
//            {"replay_finished":true} marks the data as ended. POST /api/replay/pause {paused} sets the state like the host (200 {paused, finished}; 409 STATE_CONFLICT when not REPLAY or finished; 401 without a token),
//            counts changes in replayPauses, and sends a system message to every signed-in data socket when the state changed.
//            S7-7b (ADR 0065): POST /api/replay/speed {speed: 1|4|16} sets the speed like the host (200 {speed, paused, finished}; 401; 409 STATE_CONFLICT when not REPLAY or finished; 422 for anything but the whole numbers 1, 4, 16),
//            counts changes in replaySpeeds, and sends a system message when the speed changed, none for a repeat. A speed can be set while paused.
// `node e2e/mock_host.mjs --print-messages` prints the two server messages it sends as JSON, for the pytest check against the Pydantic models.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dashboard', 'dist');
const CONSTANTS = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'shared', 'constants.json'), 'utf8'));
export const PORT = Number(process.env.E2E_PORT ?? 8431), HOST = '127.0.0.1', TOKEN = 'e2e-token';
export const PIN_NAME = 'Ana', PIN = '482913', SESSION_TOKEN = 'e2e-session-token', LOCK_S = 900;

export const snapshotMessage = (now, abi = false, replay = null) => ({
  v: 1, type: 'snapshot', srv_seq: 0, srv_ts: now, epoch: '5d1f7c3a-2b64-4e0f-9a51-3c7e8d2b6a10', recovering: false, monitoring_active: false,
  session: { session_id: 1, started_ts: now, mode: replay ? 'REPLAY' : 'SIMULATOR', session_label: 'e2e' }, replay: replay ?? null,
  roster: [{ node_id: 1, alias: 'FF-01', active: 1 }],
  nodes: [{ node_id: 1, alias: 'FF-01', last_rx_ts: now, co_ppm: 12, temp_c: 31.2, hum_pct: 44, motion_g: 0.08, bat_pct: 86,
    scba: 1, mandown: 0, level: 'NORMAL', link_state: 'ok', status2: 0, flags: 0, id_mode: 73, status3: 0, status4: 0,
    co_validity: 'VALID', co_reason: null, scba_correction: null }],
  open_alerts: [], open_episodes: [], co_history_30m: { '1': [[now, 12]] },
  banners: { base_offline: false, logging_fault: false, host_gap: null, host_power: 'ac', audio_fault: false, abi_mismatch: abi },
  constants: CONSTANTS,
});
export const tickMessage = (seq, now) => ({ v: 1, type: 'tick', srv_seq: seq, srv_ts: now });
export const systemMessage = (seq, now, abi, replay = null) => ({ v: 1, type: 'system', srv_seq: seq, srv_ts: now, base: 'ok', recovering: false, session_id: 1, session_mode: replay ? 'REPLAY' : 'SIMULATOR', replay: replay ?? null, rejected_frames: 0,
  logging_fault: false, host_gap: null, host_power: 'ac', audio_fault: false, abi_mismatch: abi, banner: null, acknowledged_ts: null });
export const alertMessage = (seq, now, a) => ({ v: 1, type: 'alert', srv_seq: seq, srv_ts: now, alert_id: a.alert_id, node_id: 1, alert_type: a.alert_type ?? 'man_down', level: a.level ?? 'DANGER',
  reasons: null, authenticated: 1, episode_id: null, raised_ts: now, cleared_ts: a.cleared ? now : null, acknowledged_ts: a.cleared ? now : null, acknowledged_by: a.cleared ? 1 : null,
  unauth_count: null, last_seen_ts: null });

export const pinLoginReply = (now) => ({ operator_id: 1, display_name: PIN_NAME, session_id: 1, session_token: SESSION_TOKEN, expires_ts: now + 12 * 3600 * 1000 });

if (process.argv.includes('--print-messages')) {
  console.log(JSON.stringify([snapshotMessage(1_700_000_000_000), tickMessage(1, 1_700_000_001_000)]));
  process.exit(0);
}
if (process.argv.includes('--print-replay')) { console.log(JSON.stringify([snapshotMessage(1_700_000_000_000, false, { speed: 16, paused: true, finished: false }), systemMessage(1, 1_700_000_001_000, false, { speed: 16, paused: false, finished: true })])); process.exit(0); }   // for the pytest check against the Pydantic models
if (process.argv.includes('--print-alert')) { console.log(JSON.stringify(alertMessage(1, 1_700_000_001_000, { alert_id: 1 }))); process.exit(0); }   // for the pytest check against the Pydantic models
if (process.argv.includes('--print-login')) { console.log(JSON.stringify(pinLoginReply(1_700_000_000_000))); process.exit(0); }   // for the pytest check against PinLoginResp
const { WebSocketServer } = await import('ws');                                  // after --print-messages, so that mode needs no npm install
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dashboard/dist/index.html is missing: build the dashboard first (just build, or: cd dashboard; npm run build).');
  process.exit(1);
}

const state = { mode: 'live', lastTickAt: 0, startCount: 0, logins: 0, abi_mismatch: false, pinLogins: 0, logouts: 0, wrongPins: 0, lockedUntil: 0, sessionLive: false, lastRemember: null, replay: null, replayPauses: 0, replaySpeeds: 0 };
export const REPLAY_SPEEDS = [1, 4, 16];   // = SPEEDS in host/ppe_host/services/replay.py (test_e2e_config.py compares them)
const replayBlock = () => (state.replay ? { ...state.replay } : null);
const sendSystem = () => { if (state.mode === 'live') for (const c of clients) if (c.authed && c.kind === 'data' && c.ws.readyState === 1) c.ws.send(JSON.stringify(systemMessage(++c.seq, Date.now(), state.abi_mismatch, replayBlock()))); };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.stl': 'model/stl' };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); });
const tokenOk = (t) => t === TOKEN || (t === SESSION_TOKEN && state.sessionLive);          // the operator token always; the session token until Log out or expire
const bearerOk = (req) => { const a = req.headers.authorization ?? ''; return a.startsWith('Bearer ') && tokenOk(a.slice(7)); };
const refuse = (res, detail, retry) => json(res, 401, { error_code: 'UNAUTHENTICATED', detail, retry_after_s: retry });
// The PIN form. The real host waits out the failed-login delay before it answers; the mock answers at once and only reports it in retry_after_s.
const pinLogin = (b, res) => {
  const now = Date.now();
  if (state.lockedUntil > now) return refuse(res, 'locked', Math.ceil((state.lockedUntil - now) / 1000));
  if (b.display_name !== PIN_NAME || b.pin !== PIN) {
    state.wrongPins += 1;
    if (state.wrongPins < 5) return refuse(res, 'invalid name or PIN', 1);
    state.wrongPins = 0; state.lockedUntil = now + LOCK_S * 1000;
    return refuse(res, 'locked', LOCK_S);
  }
  state.wrongPins = 0; state.pinLogins += 1; state.sessionLive = true; state.lastRemember = b.remember === true;
  return json(res, 200, pinLoginReply(now));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  if (url.pathname === '/__state') return json(res, 200, state);
  if (url.pathname === '/__ctl' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.reset) { state.startCount = 0; state.logins = 0; state.lastTickAt = 0; state.abi_mismatch = false; state.pinLogins = 0; state.logouts = 0; state.wrongPins = 0; state.lockedUntil = 0; state.sessionLive = false; state.lastRemember = null; state.replay = null; state.replayPauses = 0; state.replaySpeeds = 0; }
    if (typeof b.replay === 'boolean' && (b.replay !== (state.replay !== null))) { state.replay = b.replay ? { speed: 16, paused: false, finished: false } : null; sendSystem(); }   // a live switch; the tests set it before signing in
    if (b.replay_finished === true && state.replay && !state.replay.finished) { state.replay.finished = true; sendSystem(); }
    if (b.expire) { state.sessionLive = false; for (const c of clients) if (c.token === SESSION_TOKEN) c.ws.close(4401); }
    if (['live', 'muted', 'dead'].includes(b.mode)) state.mode = b.mode;
    if (typeof b.abi_mismatch === 'boolean' && b.abi_mismatch !== state.abi_mismatch) {   // the base reports a different ABI (or agrees again): one system message, like the host
      state.abi_mismatch = b.abi_mismatch;
      sendSystem();
    }
    if (b.alert && state.mode !== 'dead') for (const c of clients) if (c.authed && c.kind === 'data' && c.ws.readyState === 1) c.ws.send(JSON.stringify(alertMessage(++c.seq, Date.now(), b.alert)));
    return json(res, 200, state);
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.pin !== undefined) return pinLogin(b, res);
    if (b.token !== TOKEN) return json(res, 401, { error_code: 'UNAUTHENTICATED', detail: 'token not accepted', retry_after_s: null });
    state.logins += 1;
    return json(res, 200, { operator_id: 1, display_name: 'E2E', session_id: 1 });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    if (!bearerOk(req)) return refuse(res, 'no token', null);
    if (req.headers.authorization === `Bearer ${SESSION_TOKEN}`) state.sessionLive = false;     // the host revokes the login session; an operator token has nothing to revoke
    state.logouts += 1;
    return json(res, 200, { logged_out: true });
  }
  if (url.pathname === '/api/session/start' && req.method === 'POST') {
    if (!bearerOk(req)) return json(res, 401, { error_code: 'UNAUTHENTICATED', detail: 'no token', retry_after_s: null });
    state.startCount += 1;
    return json(res, 200, { session_id: 1, started_ts: Date.now(), mode: 'SIMULATOR', monitoring_active: true });
  }
  if (url.pathname === '/api/replay/pause' && req.method === 'POST') {
    if (!bearerOk(req)) return json(res, 401, { error_code: 'UNAUTHENTICATED', detail: 'no token', retry_after_s: null });
    const b = await readBody(req);
    if (typeof b.paused !== 'boolean') return json(res, 422, { error_code: 'VALIDATION', detail: 'paused must be true or false', retry_after_s: null });
    if (!state.replay || state.replay.finished) return json(res, 409, { error_code: 'STATE_CONFLICT', detail: state.replay ? 'the replay has finished' : 'not a REPLAY host', retry_after_s: null });
    if (state.replay.paused !== b.paused) { state.replay.paused = b.paused; state.replayPauses += 1; sendSystem(); }      // one system message per change, none for a repeat, like the host
    return json(res, 200, { paused: state.replay.paused, finished: state.replay.finished });
  }
  if (url.pathname === '/api/replay/speed' && req.method === 'POST') {
    if (!bearerOk(req)) return json(res, 401, { error_code: 'UNAUTHENTICATED', detail: 'no token', retry_after_s: null });
    const b = await readBody(req);
    if (typeof b.speed !== 'number' || !REPLAY_SPEEDS.includes(b.speed)) return json(res, 422, { error_code: 'VALIDATION', detail: 'speed must be the whole number 1, 4 or 16', retry_after_s: null });
    if (!state.replay || state.replay.finished) return json(res, 409, { error_code: 'STATE_CONFLICT', detail: state.replay ? 'the replay has finished' : 'not a REPLAY host', retry_after_s: null });
    if (state.replay.speed !== b.speed) { state.replay.speed = b.speed; state.replaySpeeds += 1; sendSystem(); }      // one system message per change, none for a repeat, also while paused
    return json(res, 200, { speed: state.replay.speed, paused: state.replay.paused, finished: state.replay.finished });
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
        if (m.type !== 'auth' || !tokenOk(m.token)) { ws.close(4401); return; }
        c.authed = true; c.token = m.token;
        if (c.kind === 'data' && state.mode !== 'dead') ws.send(JSON.stringify(snapshotMessage(Date.now(), state.abi_mismatch, replayBlock())));
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
