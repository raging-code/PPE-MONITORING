// Requirements: REQ-UI-008
// P24-5g (ADR 0051): the ABI MISMATCH banner. The mock host sends the same system message the host sends when the base reports a different beacon ABI. No fixed sleeps.
import { expect, test } from '@playwright/test';
import { control, signInAndWaitLive } from './helpers';

test.beforeEach(async ({ request }) => { await control(request, { mode: 'live', reset: true }); });

test('ABI MISMATCH appears when the base reports a different ABI and goes when it agrees again', async ({ page, request }) => {
  await signInAndWaitLive(page);
  const banner = page.getByTestId('banner-abi_mismatch');
  await expect(banner).toHaveCount(0);

  await control(request, { abi_mismatch: true });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('ABI MISMATCH');
  await expect(banner.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);   // it cannot be acknowledged
  await expect(page.getByTestId('frame')).toBeVisible();                             // the cards stay

  await control(request, { abi_mismatch: false });
  await expect(banner).toHaveCount(0);
});
