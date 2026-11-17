import { defineConfig, devices } from '@playwright/test';
const portText = process.env.SHIYU_PREVIEW_PORT ?? '18081';
const previewPort = Number(portText);
if (!/^\d+$/.test(portText) || !Number.isSafeInteger(previewPort) || previewPort < 1 || previewPort > 65535) {
  throw new Error('SHIYU_PREVIEW_PORT must be an integer from 1 to 65535.');
}
const previewUrl = `http://127.0.0.1:${previewPort}`;
export default defineConfig({
  testDir: './tests/ui',
  timeout: 30000,
  use: { baseURL: previewUrl, trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/serve-preview.mjs', url: previewUrl, reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' } },
  ],
});
