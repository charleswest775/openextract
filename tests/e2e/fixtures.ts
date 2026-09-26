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

// Test option — override per-spec with `test.use({ backupPath: ... })`.
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
    // state don't leak between tests — otherwise a successful open() shifts
    // the home screen from FirstVisitView to WorkspaceView for the next test.
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
        // Force file:// load of the built renderer instead of Vite dev server.
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

// Values the populated fixture is built to produce (see build_fixture.py EXPECTED).
export type Expected = {
  udid: string;
  device_name: string;
  contacts: string[];
  conversations: Record<string, number>;
  total_messages: number;
  search: { query: string; text: string };
  attachment: { conversation: string; transfer_name: string; bytes: number };
  total_calls: number;
  facetime_calls: number;
  notes: string[];
  note_body_fragment: string;
  photos: string[];
  trashed_photo: string;
  album: { title: string; count: number };
  voicemails: Record<string, string>;
  browser_titles: string[];
  browser_visits: number;
  recently_deleted: string;
  orphaned: string;
};

export function loadExpected(): Expected {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_BACKUP_PATH, 'expected.json'), 'utf-8'));
}

// Home → "Explore my data" → dashboard for the populated fixture.
export async function openFixtureBackup(page: Page, deviceName = 'E2E Test iPhone') {
  await page.getByRole('button', { name: /Explore my data/i }).click();
  await page.getByRole('heading', { level: 1, name: deviceName }).waitFor({ timeout: 20_000 });
}

// Call the sidecar through the real preload → main → Python bridge and
// unwrap the { success, data, error } envelope.
export async function rpc<T = any>(page: Page, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await page.evaluate(
    ([m, p]) => (window as any).openextract.call(m, p),
    [method, params] as const,
  );
  if (!res?.success) throw new Error(`${method} failed: ${res?.error}`);
  return res.data as T;
}
