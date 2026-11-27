// P27-3 (ADR 0042): browser tests of design 8 against the BUILT dashboard (dashboard/dist), served by e2e/mock_host.mjs.
// One worker and no retries: the tests share one mock host and measure time, so a retry would hide a real timing failure.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8431);

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: { args: ['--mute-audio'] }, // the audio clock still runs; only the speaker is off
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node mock_host.mjs',
    url: `http://127.0.0.1:${PORT}/__state`,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
    env: { E2E_PORT: String(PORT) },
  },
});
