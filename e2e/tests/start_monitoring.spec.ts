// Design 3.7 and 3.12: Test sound first, then Start monitoring unlocks the browser siren and tells the host. Unlocked means this tab owns the siren
// and the browser's audio clock is really running (AudioBar shows Siren ON only then), so these steps need a real browser.
import { expect, test } from '@playwright/test';
import { control, noLiveData, signInAndWaitLive } from './helpers';

test.beforeEach(async ({ request }) => { await control(request, { mode: 'live', reset: true }); });

test('Start monitoring needs Test sound first, then unlocks the siren and tells the host', async ({ page, request }) => {
  await signInAndWaitLive(page);
  const bar = page.getByTestId('audio-bar');
  const start = bar.getByRole('button', { name: 'Start monitoring', exact: true });

  await expect(bar.getByText('Browser siren off: click Start monitoring')).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(bar.getByText('Play the test sound first.')).toBeVisible();

  await bar.getByRole('button', { name: 'Test sound' }).click();
  await expect(start).toBeEnabled();

  await start.click();
  await expect(bar.getByText('Siren ON')).toBeVisible();                              // audio clock running and this tab owns the siren
  await expect(bar.getByText('Browser siren off: click Start monitoring')).toHaveCount(0);
  await expect.poll(async () => (await control(request, {})).startCount).toBe(1);     // POST /api/session/start reached the host
});

test('after Start monitoring the red screen offers Silence 60 s and no longer says the siren is off', async ({ page, request }) => {
  await signInAndWaitLive(page);
  const bar = page.getByTestId('audio-bar');
  await bar.getByRole('button', { name: 'Test sound' }).click();
  await bar.getByRole('button', { name: 'Start monitoring', exact: true }).click();
  await expect(bar.getByText('Siren ON')).toBeVisible();

  await control(request, { mode: 'muted' });
  await expect(noLiveData(page)).toBeVisible({ timeout: 8000 });
  await expect(noLiveData(page).getByText('Browser siren off: click Start monitoring')).toHaveCount(0);
  await noLiveData(page).getByRole('button', { name: 'Silence 60 s' }).click();
  await expect(noLiveData(page).getByText('Siren silenced for 60 s', { exact: false })).toBeVisible();
});
