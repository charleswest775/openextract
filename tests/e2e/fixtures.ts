import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_BACKUP_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'synthetic_backup');
const ENCRYPTED_FIXTURE_BACKUP_PATH = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'synthetic_backup_encrypted',
);

// Test options — override per-spec with `test.use({ ... })`.
type Options = {
  // Folder passed to `dialog:selectFolder` when the app asks for a backup.
  // Defaults to the unencrypted synthetic fixture.
  backupPath: string;
};

type Fixtures = {
  electronApp: ElectronApplication;
  firstWindow: Page;
};

export const test = base.extend<Options & Fixtures>({
  backupPath: [FIXTURE_BACKUP_PATH, { option: true }],

  electronApp: async ({ backupPath }, use) => {
    // Isolate userData per test run so persisted sessions / firstLaunch
    // state don't leak between tests — otherwise the home screen shifts
    // from FirstVisitView to WorkspaceView after the first successful open.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openextract-e2e-'));

    // --no-sandbox lets Electron run under root/CI containers where the
    // chrome-sandbox setuid bit isn't set. Harmless in dev/test contexts.
    const args = [
      path.join(REPO_ROOT, 'dist-electron', 'main.js'),
      `--user-data-dir=${userDataDir}`,
    ];
    if (process.env.OPENEXTRACT_E2E_NO_SANDBOX === '1') args.push('--no-sandbox');

    const app = await electron.launch({
      args,
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OPENEXTRACT_TEST_MODE: '1',
        OPENEXTRACT_PYTHON_FROM_SOURCE: '1',
        OPENEXTRACT_TEST_OPEN_PATH: backupPath,
        // Force file:// load of the built renderer instead of the Vite dev server.
        NODE_ENV: 'production',
      },
    });
    await use(app);
    await app.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  },

  firstWindow: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

export { expect } from '@playwright/test';
export { FIXTURE_BACKUP_PATH, ENCRYPTED_FIXTURE_BACKUP_PATH };
