import { expect, type APIRequestContext, type Page } from '@playwright/test';

export type Mode = 'live' | 'muted' | 'dead';
export interface MockState { mode: Mode; lastTickAt: number; startCount: number; logins: number; abi_mismatch: boolean; pinLogins: number; logouts: number; wrongPins: number; lastRemember: boolean | null }

// What the mock host accepts on the PIN form (P28-6, ADR 0056) and the session token it answers with. Keep in step with e2e/mock_host.mjs.
export const PIN_NAME = 'Ana', PIN = '482913', SESSION_TOKEN = 'e2e-session-token';

// The mock host is shared by all tests, so every test starts from a known state.
export async function control(request: APIRequestContext, body: { mode?: Mode; reset?: boolean; expire?: boolean; abi_mismatch?: boolean; alert?: { alert_id: number; alert_type?: string; level?: string; cleared?: boolean } }): Promise<MockState> {
  const r = await request.post('/__ctl', { data: body });
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as MockState;
}

export const noLiveData = (page: Page) => page.getByRole('alert').filter({ hasText: 'NO LIVE DATA' });

// Sign in with the mock host's token. Returns the time of the click (Date.now(), the same machine clock as the mock host).
// P28-5: the Login page shows name and PIN first, so this opens the admin token form. signInWithPin below uses the PIN form.
export async function signIn(page: Page): Promise<number> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Use the admin token instead' }).click();
  await page.getByLabel('Token').fill('e2e-token');
  const t = Date.now();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();   // exact: the token form also has the link 'Sign in with name and PIN'
  return t;
}

export async function signInAndWaitLive(page: Page): Promise<void> {
  await signIn(page);
  await expect(page.getByTestId('frame')).toBeVisible();
  await expect(page.getByTestId('audio-bar')).toBeVisible();
}

// Sign in with the mock host's name and PIN (P28-6). remember ticks "Remember me on this browser". Returns the time of the click.
export async function signInWithPin(page: Page, opts: { remember?: boolean } = {}): Promise<number> {
  await page.goto('/');
  await page.getByLabel('Name', { exact: true }).fill(PIN_NAME);
  await page.getByLabel('PIN', { exact: true }).fill(PIN);
  if (opts.remember) await page.getByLabel('Remember me on this browser').check();
  const t = Date.now();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  return t;
}

// What is in the token slot of this page, in sessionStorage and in localStorage (store/token.ts; the key is ppe_token).
export const storedTokens = (page: Page) => page.evaluate(() => ({ session: sessionStorage.getItem('ppe_token'), local: localStorage.getItem('ppe_token') }));

