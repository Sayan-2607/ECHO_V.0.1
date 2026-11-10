import { defineConfig } from '@playwright/test';

/**
 * Browser tests run against tests/e2e/server.ts (real app + deterministic fakes).
 * Build the client first (npm run build). If Playwright's bundled Chromium is not installed,
 * set CHROME_PATH to a local Chrome/Chromium binary.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4319',
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
    viewport: { width: 1360, height: 900 },
  },
  webServer: {
    command: 'npx tsx tests/e2e/server.ts',
    url: 'http://127.0.0.1:4319/api/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
