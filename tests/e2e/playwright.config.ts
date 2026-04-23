import { defineConfig } from '@playwright/test';

// Playwright drives the real Electron binary via `_electron.launch` inside
// each spec (see fixtures.ts). No `projects` or `webServer` needed — Electron
// loads the already-built renderer bundle (`dist/index.html`) from disk, so
// the harness requires `npm run build` to have run first.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
