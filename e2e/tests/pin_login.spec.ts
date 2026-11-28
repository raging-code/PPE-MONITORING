// Requirements: REQ-SEC-003, REQ-UI-002
// P28-6 (ADR 0056): the name-and-PIN login in a real browser, against the mock host's PIN login (Ana, PIN 482913). Sign in, Remember me, Log out, a session the host ends,
// and the 15-minute lock with the admin token as the way in. No fixed sleeps: a wait of the login screen is waited out by expecting Sign in to be enabled again.
import { expect, test, type Page } from '@playwright/test';
import { control, PIN, PIN_NAME, SESSION_TOKEN, signInAndWaitLive, signInWithPin, storedTokens } from './helpers';

test.beforeEach(async ({ request }) => { await control(request, { mode: 'live', reset: true }); });

const loginScreen = (page: Page) => page.getByRole('heading', { name: 'PPE Monitoring' });
const pinField = (page: Page) => page.getByLabel('PIN', { exact: true });
const signInButton = (page: Page) => page.getByRole('button', { name: 'Sign in' });

test('name and PIN reach the live screen, a wrong PIN is refused and the PIN field is emptied', async ({ page, request }) => {
  await page.goto('/');
  await page.getByLabel('Name', { exact: true }).fill(PIN_NAME);
  await expect(signInButton(page)).toBeDisabled();                       // no PIN yet
  await expect(pinField(page)).toHaveAttribute('type', 'password');
  await pinField(page).fill('111111');
  await signInButton(page).click();
  await expect(page.getByRole('status')).toContainText('Name or PIN not accepted');
  await expect(pinField(page)).toHaveValue('');                          // never kept on screen after an attempt
  await expect(loginScreen(page)).toBeVisible();

  await pinField(page).fill(PIN);
  await expect(signInButton(page)).toBeEnabled();                        // the 1 s wait of the wrong PIN is over
  await signInButton(page).click();
  await expect(page.getByTestId('frame')).toBeVisible();
  const s = await control(request, {});
  expect(s.pinLogins).toBe(1);
  expect(s.lastRemember).toBe(false);                                    // off by default
  expect(await storedTokens(page)).toEqual({ session: SESSION_TOKEN, local: null });   // the host's session token, in this tab only
});

test('Remember me keeps the login in a new tab; without it a new tab shows Login', async ({ page, context, request }) => {
  await signInWithPin(page, { remember: false });
  await expect(page.getByTestId('frame')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await expect(loginScreen(other)).toBeVisible();                        // sessionStorage is per tab
  await other.close();

  await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
  await signInWithPin(page, { remember: true });
  await expect(page.getByTestId('frame')).toBeVisible();
  expect((await control(request, {})).lastRemember).toBe(true);
  expect(await storedTokens(page)).toEqual({ session: null, local: SESSION_TOKEN });
  const again = await context.newPage();
  await again.goto('/');
  await expect(again.getByTestId('frame')).toBeVisible();                // signed in without typing anything
  await again.close();
});

test('Log out asks once, ends the session on the host, forgets the token and shows Login', async ({ page, context, request }) => {
  await signInWithPin(page, { remember: true });
  await expect(page.getByTestId('frame')).toBeVisible();

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByText('This screen stops monitoring.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('frame')).toBeVisible();                 // cancelled: still signed in
  expect((await control(request, {})).logouts).toBe(0);

  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByRole('button', { name: 'Yes, log out' }).click();
  await expect(loginScreen(page)).toBeVisible();
  await expect(page.getByTestId('frame')).toHaveCount(0);
  expect((await control(request, {})).logouts).toBe(1);
  expect(await storedTokens(page)).toEqual({ session: null, local: null });   // both places, so Remember me does not outlive Log out
  const r = await request.post('/api/logout', { headers: { Authorization: `Bearer ${SESSION_TOKEN}` } });
  expect(r.status()).toBe(401);                                          // the host really ended it
  const other = await context.newPage();
  await other.goto('/');
  await expect(loginScreen(other)).toBeVisible();
  await other.close();
});

test('a session that ends on the host closes the socket with 4401 and the screen shows Login', async ({ page, request }) => {
  await signInWithPin(page, { remember: true });
  await expect(page.getByTestId('frame')).toBeVisible();
  await control(request, { expire: true });
  await expect(loginScreen(page)).toBeVisible();
  expect(await storedTokens(page)).toEqual({ session: null, local: null });
});

test('five wrong PINs lock the PIN form for 15 minutes and the admin token still gets in', async ({ page, request }) => {
  await page.goto('/');
  await page.getByLabel('Name', { exact: true }).fill(PIN_NAME);
  for (let i = 0; i < 5; i += 1) {
    await pinField(page).fill('111111');
    await expect(signInButton(page)).toBeEnabled();                      // waits out the 1 s of the previous wrong PIN
    await signInButton(page).click();
    await expect(pinField(page)).toHaveValue('');                        // the answer has arrived
  }
  await expect(page.getByRole('status')).toContainText('Too many wrong PINs. Try again in 15 min');
  await pinField(page).fill(PIN);                                        // even the right PIN is refused while locked
  await expect(signInButton(page)).toBeDisabled();
  expect((await control(request, {})).pinLogins).toBe(0);

  await page.getByRole('button', { name: 'Use the admin token instead' }).click();
  await page.getByLabel('Token').fill('e2e-token');
  await signInButton(page).click();                                      // the operator token is never locked (design 4)
  await expect(page.getByTestId('frame')).toBeVisible();
});

test('the token sign-in of the other tests still works and leaves no session behind', async ({ page, request }) => {
  await signInAndWaitLive(page);
  expect((await control(request, {})).pinLogins).toBe(0);
  expect(await storedTokens(page)).toEqual({ session: 'e2e-token', local: null });
});
