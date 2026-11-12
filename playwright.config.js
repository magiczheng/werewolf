import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser', testMatch: '**/*.spec.js', fullyParallel: false, workers: 1,
  timeout: 60000, expect: { timeout: 10000 }, retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:3199', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    { name: 'mobile-safari', use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'node test/browser/serve.mjs', url: 'http://127.0.0.1:3199/api/health', reuseExistingServer: false, timeout: 20000 },
});
