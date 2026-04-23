import path from 'node:path';
import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_BACKUP_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'synthetic_backup');

type Fixtures = {
  electronApp: ElectronApplication;
  firstWindow: Page;
};

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    // --no-sandbox lets Electron run under root/CI containers where the
    // chrome-sandbox setuid bit isn't set. Harmless in dev/test contexts.
    const args = [path.join(REPO_ROOT, 'dist-electron', 'main.js')];
    if (process.env.OPENEXTRACT_E2E_NO_SANDBOX === '1') args.push('--no-sandbox');

    const app = await electron.launch({
      args,
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OPENEXTRACT_TEST_MODE: '1',
        OPENEXTRACT_PYTHON_FROM_SOURCE: '1',
        OPENEXTRACT_TEST_OPEN_PATH: FIXTURE_BACKUP_PATH,
        // Force file:// load of the built renderer instead of the Vite dev server.
        NODE_ENV: 'production',
      },
    });
    await use(app);
    await app.close();
  },

  firstWindow: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

export { expect } from '@playwright/test';
export { FIXTURE_BACKUP_PATH };
