import { expect, type APIRequestContext, type Page } from '@playwright/test';

export type Mode = 'live' | 'muted' | 'dead';
export interface MockState { mode: Mode; lastTickAt: number; startCount: number; logins: number }

// The mock host is shared by all tests, so every test starts from a known state.
export async function control(request: APIRequestContext, body: { mode?: Mode; reset?: boolean }): Promise<MockState> {
  const r = await request.post('/__ctl', { data: body });
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as MockState;
}

export const noLiveData = (page: Page) => page.getByRole('alert').filter({ hasText: 'NO LIVE DATA' });

// Sign in with the mock host's token. Returns the time of the click (Date.now(), the same machine clock as the mock host).
export async function signIn(page: Page): Promise<number> {
  await page.goto('/');
  await page.getByLabel('Token').fill('e2e-token');
  const t = Date.now();
  await page.getByRole('button', { name: 'Sign in' }).click();
  return t;
}

export async function signInAndWaitLive(page: Page): Promise<void> {
  await signIn(page);
  await expect(page.getByTestId('frame')).toBeVisible();
  await expect(page.getByTestId('audio-bar')).toBeVisible();
}
