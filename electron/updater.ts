export {};
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Auto-update (electron-updater, GitHub releases feed) ──────────────────
//
// Privacy rules, because the website promises no network activity by default:
//  - Nothing touches the network until the user says yes. `autoCheck` starts as
//    null ("never asked"); the renderer asks once and stores true or false.
//  - A check only fetches latest*.yml from the GitHub release. No backup data,
//    no identifiers.
//  - Downloads only start when the user clicks Update.

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  error?: string;
  checkedAt?: string;
}

interface Store {
  get(key: string, fallback?: any): any;
  set(key: string, value: any): void;
}

interface Options {
  store: Store;
  getWindow: () => any;
  /** Runs before quitAndInstall, e.g. to stop the engine so its files can be replaced. */
  beforeInstall: () => Promise<void>;
}

const STARTUP_CHECK_DELAY_MS = 10_000;
const RELEASES_URL = 'https://github.com/charleswest775/openextract/releases';

let status: UpdateStatus = { state: 'idle' };

function updaterLog(line: string) {
  try {
    const file = path.join(app.getPath('userData'), 'updater_log.txt');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Logging must never break the app.
  }
}

/** Turn electron-updater's errors into something a non-technical user can act on. */
function friendlyError(err: any): string {
  const msg = String(err?.message || err || '');
  // Squirrel.Mac refuses to update an app running from the DMG or from a translocated copy.
  if (/read-only volume|translocat/i.test(msg)) {
    return "OpenExtract can't update itself from where it's running. Move it to your Applications folder, open it from there, and try again.";
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|net::ERR_/i.test(msg)) {
    return "Couldn't reach GitHub to check for updates. Check your internet connection and try again.";
  }
  if (/signature|publisher|not signed/i.test(msg)) {
    return "The downloaded update didn't pass the signature check, so it wasn't installed. You can download it from openextract.app instead.";
  }
  return "The update didn't work. You can download the latest version from openextract.app instead.";
}

export function initUpdater({ store, getWindow, beforeInstall }: Options) {
  const { autoUpdater } = require('electron-updater');

  // isUpdaterActive() is false in development and for Linux builds not running as an
  // AppImage or installed package; those users update by downloading again.
  const supported: boolean = app.isPackaged && autoUpdater.isUpdaterActive();

  // electron-updater otherwise saves a random per-install ID (userData/.updaterId) and sends it
  // to GitHub as x-user-staging-id on every check. It only matters for staged rollouts, which we
  // don't use, so every install sends the same all-zero ID and nothing identifying.
  autoUpdater.getOrCreateStagingUserId = async () => '00000000-0000-0000-0000-000000000000';
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = {
    info: (m: any) => updaterLog(`info  ${m}`),
    warn: (m: any) => updaterLog(`warn  ${m}`),
    error: (m: any) => updaterLog(`error ${m}`),
    debug: () => {},
  };

  const publish = (next: UpdateStatus) => {
    status = next;
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('updates:status', status);
  };

  autoUpdater.on('checking-for-update', () => publish({ ...status, state: 'checking', error: undefined }));
  autoUpdater.on('update-available', (info: any) =>
    publish({ state: 'available', version: info.version, checkedAt: new Date().toISOString() }));
  autoUpdater.on('update-not-available', () =>
    publish({ state: 'not-available', checkedAt: new Date().toISOString() }));
  autoUpdater.on('download-progress', (p: any) =>
    publish({ ...status, state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info: any) =>
    publish({ ...status, state: 'downloaded', version: info.version, percent: 100 }));
  autoUpdater.on('error', (err: any) => {
    updaterLog(`error ${err?.stack || err}`);
    publish({ ...status, state: 'error', error: friendlyError(err) });
  });

  const check = async () => {
    if (!supported || ['checking', 'downloading', 'downloaded'].includes(status.state)) return;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Reported through the 'error' event.
    }
  };

  ipcMain.handle('updates:get-state', () => ({
    supported,
    autoCheck: store.get('updatesAutoCheck', null),
    currentVersion: app.getVersion(),
    releasesUrl: RELEASES_URL,
    status,
  }));

  ipcMain.handle('updates:set-auto-check', (_event: any, enabled: boolean) => {
    store.set('updatesAutoCheck', !!enabled);
    if (enabled) check();
  });

  ipcMain.handle('updates:check', () => check());

  ipcMain.handle('updates:download', async () => {
    if (!supported || status.state !== 'available') return;
    publish({ ...status, state: 'downloading', percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      // Reported through the 'error' event.
    }
  });

  ipcMain.handle('updates:install', async () => {
    if (status.state !== 'downloaded') return;
    updaterLog(`installing ${status.version}`);
    await beforeInstall();
    // isSilent: no installer window on Windows; isForceRunAfter: reopen the app afterwards.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });

  if (supported && store.get('updatesAutoCheck', null) === true) {
    setTimeout(check, STARTUP_CHECK_DELAY_MS);
  }
}
