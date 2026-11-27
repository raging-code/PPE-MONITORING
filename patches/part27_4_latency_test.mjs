// patches/part27_4_latency_test.mjs (run from repo root: node patches/part27_4_latency_test.mjs; --dry lists only)
// P27-4 (ADR 0052): the 500 ms dashboard share of the man-down path (design 5 and 3.9, REQ-UI-004): message received -> pop-up visible,
// measured with performance marks over 100 events, median and maximum reported. Test-side only: no dashboard code changes, so no rebuild is needed.
import fs from 'node:fs';
const dry = process.argv.includes('--dry');
if (!fs.existsSync('dashboard') || !fs.existsSync('e2e/mock_host.mjs') || !fs.existsSync('docs/PROGRESS.md')) { console.error('WRONG BASE: run from the repo root (the folder with dashboard, e2e, docs).'); process.exit(1); }
const jobs = [];
const edit = (p, from, to) => jobs.push({ p, from, to });
const create = (p, text) => jobs.push({ p, text });

edit('e2e/mock_host.mjs', "\nif (process.argv.includes('--print-messages')) {",
`export const alertMessage = (seq, now, a) => ({ v: 1, type: 'alert', srv_seq: seq, srv_ts: now, alert_id: a.alert_id, node_id: 1, alert_type: a.alert_type ?? 'man_down', level: a.level ?? 'DANGER',
  reasons: null, authenticated: 1, episode_id: null, raised_ts: now, cleared_ts: a.cleared ? now : null, acknowledged_ts: a.cleared ? now : null, acknowledged_by: a.cleared ? 1 : null,
  unauth_count: null, last_seen_ts: null });

if (process.argv.includes('--print-messages')) {`);
edit('e2e/mock_host.mjs', "  process.exit(0);\n}\nconst { WebSocketServer }",
"  process.exit(0);\n}\nif (process.argv.includes('--print-alert')) { console.log(JSON.stringify(alertMessage(1, 1_700_000_001_000, { alert_id: 1 }))); process.exit(0); }   // for the pytest check against the Pydantic models\nconst { WebSocketServer }");
edit('e2e/mock_host.mjs', '"abi_mismatch":true|false}, GET /__state.', '"abi_mismatch":true|false,"alert":{"alert_id":n,"alert_type":"man_down","level":"DANGER","cleared":true|false}}, GET /__state.\n//   alert  : one alert message to every signed-in data socket (a raise, or with cleared:true the clear plus acknowledge that makes the dashboard drop it). Sent unless the mode is dead.');
edit('e2e/mock_host.mjs', "    return json(res, 200, state);\n  }\n  if (url.pathname === '/api/login'",
`    if (b.alert && state.mode !== 'dead') for (const c of clients) if (c.authed && c.kind === 'data' && c.ws.readyState === 1) c.ws.send(JSON.stringify(alertMessage(++c.seq, Date.now(), b.alert)));
    return json(res, 200, state);
  }
  if (url.pathname === '/api/login'`);
edit('e2e/tests/helpers.ts', 'body: { mode?: Mode; reset?: boolean; abi_mismatch?: boolean }',
  "body: { mode?: Mode; reset?: boolean; abi_mismatch?: boolean; alert?: { alert_id: number; alert_type?: string; level?: string; cleared?: boolean } }");

create('e2e/tests/dashboard_latency.spec.ts', `// Requirements: REQ-UI-004
// P27-4 (ADR 0052): the dashboard share of the man-down path, design 5 and 3.9: from the alert message arriving in the browser to the pop-up visible,
// 500 ms or less (provisional), measured with performance marks (receive, render) over at least 100 events; median and maximum are reported.
// The marks are set by a script the test injects before the dashboard loads, so the dashboard code is the one that ships:
//   ppe:rx:<id>      the data socket's first message listener, for an alert message that raises (not a clear), taken before the JSON is parsed
//   ppe:render:<id>  the first animation frame after the alert card with its text is in the page
// This is the dashboard share only: the host share (frame received to broadcast, 200 ms) and the siren start (300 ms) are measured by pytest, and the camera check stays manual in D8.
import { expect, test } from '@playwright/test';
import { control, signInAndWaitLive } from './helpers';

const EVENTS = 100, BUDGET_MS = 500;
const ALERT = { alert_type: 'man_down', level: 'DANGER' };

test.beforeEach(async ({ request }) => { await control(request, { mode: 'live', reset: true }); });

test('man-down message received to pop-up visible: 500 ms or less over 100 events', async ({ page, request }, info) => {
  test.slow();                                                                            // 3 x the 30 s default: 100 events
  await page.addInitScript(() => {
    const pending: number[] = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (ev: MessageEvent) => {
          const t = performance.now();
          if (typeof ev.data !== 'string' || !ev.data.includes('"type":"alert"')) return;
          try {
            const m = JSON.parse(ev.data);
            if (m.type === 'alert' && m.cleared_ts === null) { performance.mark('ppe:rx:' + m.alert_id, { startTime: t }); pending.push(m.alert_id); }
          } catch { /* not ours */ }
        });
      }
    } as typeof WebSocket;
    new MutationObserver(() => {
      if (!pending.length) return;
      const card = document.querySelector('[data-testid^="card-"]');
      if (!card || !(card.textContent ?? '').includes('MAN-DOWN')) return;
      const id = pending.shift() as number;
      requestAnimationFrame(() => performance.mark('ppe:render:' + id));
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });

  await signInAndWaitLive(page);
  const card = page.getByTestId('card-n1');
  await expect(card).toHaveCount(0);

  for (let id = 1; id <= EVENTS; id++) {
    await control(request, { alert: { alert_id: id, ...ALERT } });                       // raise
    await expect(card).toBeVisible();
    await expect(card).toContainText('MAN-DOWN');
    await expect.poll(() => page.evaluate((i) => performance.getEntriesByName('ppe:render:' + i).length, id)).toBe(1);
    await control(request, { alert: { alert_id: id, ...ALERT, cleared: true } });        // cleared and acknowledged: the card goes, the next event is a new pop-up
    await expect(card).toHaveCount(0);
  }

  const ms = await page.evaluate((n) => {
    const out: number[] = [];
    for (let i = 1; i <= n; i++) out.push(performance.measure('ppe:latency:' + i, 'ppe:rx:' + i, 'ppe:render:' + i).duration);
    return out;
  }, EVENTS);
  const sorted = [...ms].sort((a, b) => a - b);
  const median = (sorted[EVENTS / 2 - 1] + sorted[EVENTS / 2]) / 2, max = sorted[EVENTS - 1];
  const line = \`LATENCY man-down message to pop-up, \${EVENTS} events: median \${median.toFixed(1)} ms, max \${max.toFixed(1)} ms (budget \${BUDGET_MS} ms)\`;
  console.log(line);
  await info.attach('latency.json', { body: JSON.stringify({ events: EVENTS, budget_ms: BUDGET_MS, median_ms: median, max_ms: max, samples_ms: ms }, null, 1), contentType: 'application/json' });

  expect(ms).toHaveLength(EVENTS);
  expect(sorted[0]).toBeGreaterThanOrEqual(0);
  expect(max, line).toBeLessThanOrEqual(BUDGET_MS);
});
`);

edit('host/tests/test_e2e_config.py', "\n@pytest.mark.skipif(shutil.which('node') is None, reason='node is not installed')\ndef test_the_mock_host_sends_messages_the_host_models_accept():",
`
@pytest.mark.skipif(shutil.which('node') is None, reason='node is not installed')
def test_the_mock_host_alert_message_is_one_the_host_models_accept():
    from ppe_host.api.models import SERVER_ADAPTER
    out = subprocess.run(['node', str(E2E / 'mock_host.mjs'), '--print-alert'], capture_output=True, text=True, timeout=60, cwd=str(ROOT))
    assert out.returncode == 0, out.stderr
    m = json.loads(out.stdout)
    assert m['type'] == 'alert' and m['alert_type'] == 'man_down' and m['level'] == 'DANGER' and m['cleared_ts'] is None
    SERVER_ADAPTER.validate_python(m)

@pytest.mark.skipif(shutil.which('node') is None, reason='node is not installed')
def test_the_mock_host_sends_messages_the_host_models_accept():`);

create('docs/adr/0052.md', `# ADR 0052: dashboard latency test, 500 ms (P27-4)

Status: Proposed (the 500 ms is provisional in design 5 and 3.9; confirm at the next design review).
Design: 5 (dashboard share of the man-down path, 500 ms or less, median and maximum over at least 100 events), 3.9 (measured with performance marks, receive and render), 8 (dashboard latency test, REQ-UI-004).

- **What runs.** e2e/tests/dashboard_latency.spec.ts signs in to the built dashboard, then 100 times: the mock host sends a man-down DANGER alert, the test waits for the card, then the mock sends the clear with acknowledge so the card goes and the next event is a new pop-up. Each event gives one latency, mark \`ppe:rx:<id>\` to mark \`ppe:render:<id>\`. The test prints the median and maximum (LATENCY line, and latency.json attached to the run) and fails if the maximum is over 500 ms or fewer than 100 events were measured.
- **Where the marks are.** In a script the test injects before the page loads (addInitScript), not in the dashboard. Receive is the first message listener on the data socket (before the JSON is parsed, so parsing and the reducer count). Render is the first animation frame after the card with its MAN-DOWN text is in the page, so it includes React's commit and the wait for the next frame. The dashboard code is unchanged and no rebuild is needed. This differs from ADR 0042, which expected marks in the dashboard code: the marks are not needed there for the gate, and the shipped code stays as it is. A mark in the dashboard would also fit the D8 run; say if you want it.
- **Mock host.** /__ctl takes \`alert\` (alert_id, optional alert_type and level, cleared) and sends one alert message to every signed-in data socket. \`node e2e/mock_host.mjs --print-alert\` prints that message; host/tests/test_e2e_config.py checks it against the Pydantic models.
- **Limits.** The mock host and the browser run on one machine over loopback, so there is no radio, host or network time in the figure: it is the dashboard share only. The host share (200 ms) and the siren start (300 ms) are measured by pytest, and the manual camera check stays in D8. A slow or busy laptop shows in the figure, which is the point; run it on the field laptop before D8. The mark that includes the animation frame cannot be below one frame (about 16 ms at 60 Hz).
- **Open, please confirm.** (1) Marks in the test, not in the dashboard. (2) Render means the next frame after the card is in the page, not a paint measurement. (3) Maximum, not the 95th percentile, is the gate, as in the design wording ("median and maximum reported"; the 500 ms is the limit).
`);

edit('docs/PROGRESS.md', "\n- Part 24-5g done", "\n- Part 27-4 done (ADR 0052; P27 is now complete): the 500 ms dashboard latency test (e2e/tests/dashboard_latency.spec.ts, REQ-UI-004: 100 man-down alerts through the mock host, performance marks ppe:rx and ppe:render set by an injected script, median and maximum printed and attached as latency.json, fails above 500 ms or under 100 events); mock_host.mjs gains /__ctl alert and --print-alert, helpers.ts the alert field, host/tests/test_e2e_config.py one test that the alert message passes the Pydantic models; docs/adr/0052.md (Proposed); no dashboard code changed; NOT run in a browser in the development sandbox, so the first run on your machine is the first real run; open: marks in the test and not in the dashboard, render means the next frame, run on the field laptop before D8\n- Part 24-5g done");

// run: check every anchor first, then write
let bad = 0;
const cache = {};
for (const j of jobs) {
  if (j.text !== undefined) { if (fs.existsSync(j.p) && fs.readFileSync(j.p, 'utf8') === j.text) { j.skip = true; } else if (fs.existsSync(j.p)) { console.error('EXISTS with other content: ' + j.p); bad++; } continue; }
  cache[j.p] ??= fs.readFileSync(j.p, 'utf8');
  if (cache[j.p].includes(j.to)) { j.skip = true; continue; }
  if (cache[j.p].split(j.from).length !== 2) { console.error('anchor not found (or not unique) in ' + j.p + ': ' + JSON.stringify(j.from.slice(0, 70))); bad++; continue; }
  cache[j.p] = cache[j.p].replace(j.from, () => j.to);
}
if (bad) { console.error('NOTHING WRITTEN'); process.exit(1); }
let n = 0;
for (const j of jobs) {
  if (j.skip) { console.log('skip   ' + j.p); continue; }
  console.log((j.text !== undefined ? 'create ' : 'edit   ') + j.p);
}
if (dry) { console.log('dry run, nothing written'); process.exit(0); }
for (const j of jobs) if (!j.skip && j.text !== undefined) { fs.writeFileSync(j.p, j.text); n++; }
for (const [p, s] of Object.entries(cache)) { if (s !== fs.readFileSync(p, 'utf8')) { fs.writeFileSync(p, s); n++; } }
console.log('OK: ' + n + ' file(s) written');
