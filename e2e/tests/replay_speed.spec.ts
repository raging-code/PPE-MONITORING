// Requirements: REQ-API-007, REQ-UI-008
// S7-7b (ADR 0065): the speed selector of a REPLAY host, in a real browser against the mock host (which answers POST /api/replay/speed like the host). No fixed sleeps.
import { expect, test } from '@playwright/test';
import { control, signInAndWaitLive } from './helpers';

test.beforeEach(async ({ request }) => { await control(request, { mode: 'live', reset: true }); });

test('a simulator host has no speed buttons', async ({ page }) => {
  await signInAndWaitLive(page);
  await expect(page.getByTestId('replay-speed')).toHaveCount(0);
});

test('a speed press reaches the host, and the words and the pressed button follow its answer', async ({ page, request }) => {
  await control(request, { replay: true });
  await signInAndWaitLive(page);
  const bar = page.getByTestId('replay-bar');
  await expect(bar.getByRole('button', { name: 'Speed ×16' })).toHaveAttribute('aria-pressed', 'true');

  await bar.getByRole('button', { name: 'Speed ×4' }).click();
  await expect(bar.getByTestId('replay-state')).toHaveText('Replay running, ×4');
  await expect(bar.getByRole('button', { name: 'Speed ×4' })).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.getByRole('button', { name: 'Speed ×16' })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await control(request, {})).replay?.speed).toBe(4);

  await bar.getByRole('button', { name: 'Speed ×4' }).click();                       // the speed it already has: nothing is sent
  await bar.getByRole('button', { name: 'Speed ×1' }).click();
  await expect(bar.getByTestId('replay-state')).toHaveText('Replay running, ×1');
  await expect.poll(async () => (await control(request, {})).replay?.speed).toBe(1);
  expect((await control(request, {})).replaySpeeds).toBe(2);                         // one change each, the repeat wrote nothing
  await expect(page.getByTestId('frame')).toBeVisible();                             // the cards stay
});

test('a speed can be chosen while paused, and it stays paused', async ({ page, request }) => {
  await control(request, { replay: true });
  await signInAndWaitLive(page);
  const bar = page.getByTestId('replay-bar');
  await bar.getByRole('button', { name: 'Pause replay' }).click();
  await expect(bar.getByTestId('replay-state')).toContainText('Replay paused, ×16');
  await bar.getByRole('button', { name: 'Speed ×1' }).click();
  await expect(bar.getByTestId('replay-state')).toContainText('Replay paused, ×1');
  await expect(bar.getByRole('button', { name: 'Resume replay' })).toBeEnabled();
  await bar.getByRole('button', { name: 'Resume replay' }).click();
  await expect(bar.getByTestId('replay-state')).toHaveText('Replay running, ×1');
  const s = await control(request, {});
  expect(s.replay?.speed).toBe(1); expect(s.replay?.paused).toBe(false);
});

test('a second screen and a reload both show the host\'s speed', async ({ page, context, request }) => {
  await control(request, { replay: true });
  await signInAndWaitLive(page);
  const other = await context.newPage();
  await signInAndWaitLive(other);
  await page.getByRole('button', { name: 'Speed ×4' }).click();
  await expect(other.getByTestId('replay-state')).toHaveText('Replay running, ×4');   // the host's system message, not this tab's own click
  await expect(other.getByRole('button', { name: 'Speed ×4' })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();                                                                  // the snapshot carries the replay block
  await expect(page.getByTestId('replay-state')).toHaveText('Replay running, ×4');
  await expect(page.getByRole('button', { name: 'Speed ×4' })).toHaveAttribute('aria-pressed', 'true');
});

test('when the data has ended the speed buttons are disabled', async ({ page, request }) => {
  await control(request, { replay: true });
  await signInAndWaitLive(page);
  await expect(page.getByRole('button', { name: 'Speed ×4' })).toBeEnabled();
  await control(request, { replay_finished: true });
  await expect(page.getByTestId('replay-state')).toHaveText('Replay finished');
  for (const n of [1, 4, 16]) await expect(page.getByRole('button', { name: `Speed ×${n}` })).toBeDisabled();
});
