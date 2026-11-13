import { defineConfig } from '@playwright/test';

const external = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: external || 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1000 },
    browserName: 'chromium',
    // The full Chromium build in new headless mode, which matches the real browser most closely.
    channel: 'chromium',
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  webServer: external
    ? undefined
    : {
        command:
          'npx vite build --logLevel warn && npx vite preview --host 127.0.0.1 --port 4173 --strictPort',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
