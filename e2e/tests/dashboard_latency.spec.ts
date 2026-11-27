// Requirements: REQ-UI-004
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
  const line = `LATENCY man-down message to pop-up, ${EVENTS} events: median ${median.toFixed(1)} ms, max ${max.toFixed(1)} ms (budget ${BUDGET_MS} ms)`;
  console.log(line);
  await info.attach('latency.json', { body: JSON.stringify({ events: EVENTS, budget_ms: BUDGET_MS, median_ms: median, max_ms: max, samples_ms: ms }, null, 1), contentType: 'application/json' });

  expect(ms).toHaveLength(EVENTS);
  expect(sorted[0]).toBeGreaterThanOrEqual(0);
  expect(max, line).toBeLessThanOrEqual(BUDGET_MS);
});
