// Requirements: REQ-API-007, REQ-UI-008
// S7-5b (ADR 0062): the Pause and Resume button of a REPLAY host, in a real browser against the mock host (which answers POST /api/replay/pause like the host). No fixed sleeps.
import { expect, test } from '@playwright/test';
import { control, signInAndWaitLive } from './helpers';

test.beforeEach(async ({ request }) => { await control(request, { mode: 'live', reset: true }); });

test('a simulator host has no Pause button', async ({ page }) => {
  await signInAndWaitLive(page);
  await expect(page.getByTestId('mode-bar')).toContainText('TEST: simulator data');
  await expect(page.getByTestId('replay-bar')).toHaveCount(0);
});

test('Pause and Resume reach the host, and the words and the button follow its answer', async ({ page, request }) => {
  await control(request, { replay: true });
  await signInAndWaitLive(page);
  const bar = page.getByTestId('replay-bar');
  await expect(page.getByTestId('mode-bar')).toContainText('REPLAY');
  await expect(bar.getByTestId('replay-state')).toHaveText('Replay running, ×16');

  await bar.getByRole('button', { name: 'Pause replay' }).click();
  await expect(bar.getByTestId('replay-state')).toContainText('Replay paused, ×16');
  await expect(bar.getByRole('button', { name: 'Resume replay' })).toBeEnabled();
  await expect.poll(async () => (await control(request, {})).replay?.paused).toBe(true);

  await bar.getByRole('button', { name: 'Resume replay' }).click();
  await expect(bar.getByTestId('replay-state')).toHaveText('Replay running, ×16');
  await expect.poll(async () => (await control(request, {})).replay?.paused).toBe(false);
  expect((await control(request, {})).replayPauses).toBe(2);                        // one change each way, nothing more
  await expect(page.getByTestId('frame')).toBeVisible();                            // the cards stay
});

test('a second screen and a reload both show the host\'s state', async ({ page, context, request }) => {
  await control(request, { replay: true });
  await signInAndWaitLive(page);
  const other = await context.newPage();
  await signInAndWaitLive(other);
  await page.getByRole('button', { name: 'Pause replay' }).click();
  await expect(other.getByTestId('replay-state')).toContainText('Replay paused, ×16');   // the host's system message, not this tab's own click
  await expect(other.getByRole('button', { name: 'Resume replay' })).toBeEnabled();
  await page.reload();                                                                   // the token is kept for the tab; the snapshot carries the replay block
  await expect(page.getByTestId('replay-state')).toContainText('Replay paused, ×16');
  await expect(page.getByRole('button', { name: 'Resume replay' })).toBeEnabled();
});

test('when the data has ended the button is disabled and the bar says so', async ({ page, request }) => {
  await control(request, { replay: true });
  await signInAndWaitLive(page);
  await expect(page.getByRole('button', { name: 'Pause replay' })).toBeEnabled();
  await control(request, { replay_finished: true });
  await expect(page.getByTestId('replay-state')).toHaveText('Replay finished');
  await expect(page.getByRole('button', { name: 'Pause replay' })).toBeDisabled();
});
