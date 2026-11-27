// Design 3.7 and 3.9: the page shows NO LIVE DATA when the host has been quiet for dashboard_stale_s (4 s). No fixed sleeps: every wait is for something to appear.
import { expect, test } from '@playwright/test';
import { control, noLiveData, signIn, signInAndWaitLive } from './helpers';

const STALE_MS = 4000;

test.beforeEach(async ({ request }) => { await control(request, { mode: 'live', reset: true }); });

test('NO LIVE DATA appears 4 s after the last tick, not before', async ({ page, request }) => {
  await signInAndWaitLive(page);
  await expect(noLiveData(page)).toHaveCount(0);

  const { lastTickAt } = await control(request, { mode: 'muted' });                 // the host stalls: sockets open, nothing arrives
  await expect(noLiveData(page)).toBeVisible({ timeout: 8000 });
  const shownAfter = Date.now() - lastTickAt;
  expect(shownAfter).toBeGreaterThanOrEqual(STALE_MS - 200);                          // never earlier than the 4 s of constants.json
  expect(shownAfter).toBeLessThanOrEqual(STALE_MS + 1500);                            // worker check every 250 ms plus a slow CI runner
});

test('NO LIVE DATA clears when the host answers again', async ({ page, request }) => {
  await signInAndWaitLive(page);
  await control(request, { mode: 'muted' });
  await expect(noLiveData(page)).toBeVisible({ timeout: 8000 });
  await control(request, { mode: 'live' });
  await expect(noLiveData(page)).toHaveCount(0, { timeout: 8000 });                   // the first tick after a gap does not count (3.9), the next one does
  await expect(page.getByTestId('frame')).toBeVisible();
});

test('a host that never answers after login also gives NO LIVE DATA at 4 s', async ({ page, request }) => {
  await control(request, { mode: 'dead' });
  const clicked = await signIn(page);
  await expect(page.getByText('Connecting to the host...')).toBeVisible();            // not red before the 4 s are up
  await expect(noLiveData(page)).toBeVisible({ timeout: 9000 });
  const shownAfter = Date.now() - clicked;
  expect(shownAfter).toBeGreaterThanOrEqual(STALE_MS - 300);
  expect(shownAfter).toBeLessThanOrEqual(STALE_MS + 2500);
});

test('before Start monitoring the red screen says the browser siren is off', async ({ page, request }) => {
  await signInAndWaitLive(page);
  await control(request, { mode: 'muted' });
  await expect(noLiveData(page)).toBeVisible({ timeout: 8000 });
  await expect(noLiveData(page).getByText('Browser siren off: click Start monitoring')).toBeVisible();
});
