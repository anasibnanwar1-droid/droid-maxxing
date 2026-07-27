import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/smoke',
  testMatch: 'electronDroid.smoke.spec.ts',
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
