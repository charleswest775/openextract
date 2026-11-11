export {};
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net, session, clipboard, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
import { PythonSidecar } from './sidecar';
import { initUpdater } from './updater';
import { exportMessagesPdf, PdfExportMethod, removeStaleStagingDirs } from './pdfExport';
import { FeedbackRecorder } from './feedback';
import { FeedbackReports } from './feedbackReports';
import { installFolderFor, installFolderWarning, isInsideFolder, resolveReal } from './installFolder';

let mainWindow: any = null;
let sidecar: any = null;

const isDev = !app.isPackaged;
// The end-to-end tests (scripts/e2e) run an unpackaged build with the renderer from dist/,
// as packaged builds load it, and the engine from python/. Development builds only.
const isE2E = isDev && process.env.OPENEXTRACT_E2E === '1';

app.setName('OpenExtract');

// Register custom scheme before app is ready — required for streaming/range requests
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

// ── Simple JSON file store (CJS-compatible replacement for electron-store) ──

class JsonStore {
  private filePath: string;
  private data: Record<string, any>;

  constructor(defaults: Record<string, any>) {
    // app.getPath('userData') is only available after app.whenReady(),
    // but we can resolve it lazily on first access.
    this.filePath = '';
    this.data = { ...defaults };
  }

  private ensureLoaded() {
    if (!this.filePath) {
      this.filePath = path.join(app.getPath('userData'), 'openextract-state.json');
      try {
        if (fs.existsSync(this.filePath)) {
          const raw = fs.readFileSync(this.filePath, 'utf-8');
          const saved = JSON.parse(raw);
          this.data = { ...this.data, ...saved };
        }
      } catch {
        // Corrupted file — use defaults
      }
    }
  }

  get(key: string, fallback?: any): any {
    this.ensureLoaded();
    return key in this.data ? this.data[key] : fallback;
  }

  set(key: string, value: any) {
    this.ensureLoaded();
    this.data[key] = value;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to write app state:', err);
    }
  }
}

const store = new JsonStore({
  firstLaunchCompleted: false,
  // Settings > Text size: 'default', 'large' or 'larger'
  textSize: 'default',
  sessions: [],
  stats: { totalExports: 0 },
  // null until the user answers the "check for updates automatically?" question.
  updatesAutoCheck: null,
  // When "Not now" was picked on that question: the time (ms) to ask it again. 0 = ask now.
  updatesAskAfter: 0,
  // True once the "Your file is saved" card (Say thanks, tell a friend, star) has been shown.
  // It shows at most once. It replaced `sharePromptShown`, the flag of the older star-only
  // card, so people who saw that one get this card once too.
  thanksCardShown: false,
  // True once the user picks "Don't ask again" on the "Did this export come out right?" card.
  exportCheckOptOut: false,
  // True once a thank-you was sent from the feedback form; the app then stops asking for one.
  thanksSent: false,
  // True once "Looks right" on the export check led to "Glad it worked". It shows at most once.
  thanksFollowUpShown: false,
  // Feedback reports sent from this computer (reference, random lookup code, status),
  // the email last typed into the form, and when their status was last checked.
  feedbackReports: [],
  feedbackEmail: '',
  feedbackLastCheck: 0,
});

// Asks about open feedback reports this long after startup, if a check is due.
const FEEDBACK_CHECK_DELAY_MS = 15_000;

// The export check shows at most once per run, and never on the same export as the share prompt.
let exportCheckShownThisRun = false;

// Settings > Text size scales the whole window, so layouts keep their proportions.
const TEXT_SIZE_ZOOM: Record<string, number> = { default: 1, large: 1.15, larger: 1.3 };

// Own keys only: `in` would also accept "toString", "__proto__" and the rest of Object.prototype.
const isTextSize = (size: unknown): size is string =>
  typeof size === 'string' && Object.prototype.hasOwnProperty.call(TEXT_SIZE_ZOOM, size);

function applyTextSize() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const size = store.get('textSize', 'default');
  mainWindow.webContents.setZoomFactor(isTextSize(size) ? TEXT_SIZE_ZOOM[size] : 1);
}

// macOS needs an app menu for Cmd+C, Cmd+V, Cmd+Q and friends to work, even in text fields.
// Windows and Linux keep no menu bar; their editing shortcuts don't depend on one.
function macMenu() {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(isDev ? [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(isMac ? macMenu() : null);

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: `OpenExtract v${app.getVersion()}`,
    backgroundColor: '#fbf6f1',
    // On macOS the real traffic lights sit inside the app's 52px header row
    // (see .titlebar in index.css); elsewhere the native frame stays.
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 19 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium's spell checker downloads dictionaries from Google on Windows
      // and Linux. The app promises no network calls beyond update checks.
      spellcheck: false,
    },
  });

  mainWindow.on('page-title-updated', (e: any) => e.preventDefault());

  mainWindow.webContents.on('did-finish-load', applyTextSize);

  if (isDev && !isE2E) {
    mainWindow.loadURL('http://127.0.0.1:5179');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function findVenvPython(): string {
  const rel = process.platform === 'win32'
    ? path.join('.venv', 'Scripts', 'python.exe')
    : path.join('.venv', 'bin', 'python');
  let dir = path.resolve(__dirname, '..');
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function getPythonPath(): string {
  if (isDev) {
    return process.env.OPENEXTRACT_PYTHON || findVenvPython();
  }
  const resourcePath = (process as any).resourcesPath || '';
  const binaryName = process.platform === 'win32' ? 'openextract-engine.exe' : 'openextract-engine';
  return path.join(resourcePath, 'python', binaryName);
}

function getPythonArgs(): string[] {
  if (isDev) {
    return [path.join(__dirname, '..', 'python', 'main.py'), ...(isE2E ? [] : ['--debug'])];
  }
  return [];
}

// ── Never saving inside the program folder ──────────────────────────────────
// Every update deletes the folder OpenExtract is installed in, and anything saved
// inside it (installFolder.ts has the details). Development builds run from the
// repo and electron's own folder, which no update touches, so they're not checked.

function insideInstallFolder(chosen: string): boolean {
  if (isDev) return false;
  try {
    const installFolder = resolveReal(installFolderFor(app.getPath('exe')));
    return isInsideFolder(resolveReal(chosen), installFolder);
  } catch {
    return false; // can't tell where we're installed: don't stand in the way of a save
  }
}

function documentsFolder(): string | undefined {
  try {
    return app.getPath('documents');
  } catch {
    return undefined;
  }
}

/**
 * Runs a folder or file picker until the choice is outside the program folder.
 * A choice inside it gets a short explanation, then the picker again, opened at
 * `retryIn(choice)` so the same click doesn't land in the same place. Null when
 * the user cancels either one.
 */
async function pickOutsideInstallFolder(
  pick: (retryIn?: string) => Promise<string | null | undefined>,
  retryIn: (chosen: string) => string | undefined,
): Promise<string | null> {
  let startIn: string | undefined;
  for (;;) {
    const chosen = await pick(startIn);
    if (!chosen) return null;
    if (!insideInstallFolder(chosen)) return chosen;
    const { message, detail } = installFolderWarning();
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message,
      detail,
      buttons: ['Choose another folder', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return null;
    startIn = retryIn(chosen);
  }
}

// ── Keeping the computer awake during a backup ──────────────────────────────
// A big backup runs for hours while nobody touches the computer. Windows 11 laptops
// sleep after 3 minutes idle on battery and 5 plugged in, Macs on battery soon after
// the display sleeps, and a sleeping computer drops the iPhone partway (OE-29, OE-31).
// Copying data doesn't count as activity, so ask the OS to stay awake for the whole
// backup. On Windows that has to keep the screen on: 'prevent-app-suspension' becomes
// PowerRequestExecutionRequired there, which doesn't stop a Modern Standby laptop
// sleeping (on battery Windows drops such requests 5 minutes after the sleep timeout,
// per PowerSetRequest's docs), while a display request does. On macOS
// 'prevent-app-suspension' is an IOPM assertion against idle system sleep, so the
// screen may turn off there. Closing a laptop's lid sleeps it anyway, so a sleep is
// noted in the engine log and the error then says what happened.
const BACKUP_WAKE_LOCK = process.platform === 'win32' ? 'prevent-display-sleep' : 'prevent-app-suspension';

function appendLog(logPath: string, line: string) {
  try {
    fs.appendFileSync(logPath, `[${new Date().toTimeString().slice(0, 8)}] ${line}\n`);
  } catch {
    // The log is for reports; a backup never fails over it.
  }
}

function keepAwakeDuringBackup(logPath: string) {
  let blocker: number | null = null;
  try {
    blocker = powerSaveBlocker.start(BACKUP_WAKE_LOCK);
  } catch (err) {
    appendLog(logPath, `[Electron] couldn't keep the computer awake for the backup: ${err}`);
  }
  let slept = false;
  const onSuspend = () => {
    slept = true;
    appendLog(logPath, '[Electron] the computer went to sleep during backup.start');
  };
  const onResume = () => appendLog(logPath, '[Electron] the computer woke up during backup.start');
  powerMonitor.on('suspend', onSuspend);
  powerMonitor.on('resume', onResume);
  return {
    slept: () => slept,
    stop() {
      powerMonitor.removeListener('suspend', onSuspend);
      powerMonitor.removeListener('resume', onResume);
      if (blocker !== null && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
    },
  };
}

// The errors a sleep causes: the iPhone gone (DEVICE_DISCONNECTED), the connection
// dropped, an encrypted backup's drop read as a passcode prompt, or the time limit
// running out while asleep (python/device_backup.py, electron/sidecar.ts).
const LOST_CONNECTION = /^(DEVICE_DISCONNECTED|PASSCODE_REQUIRED):|connection to your iPhone|Sidecar call timed out/;
// DEVICE_DISCONNECTED is a step for the user, not a bug (src/components/backup/BackupFlow.tsx).
const COMPUTER_SLEPT =
  'DEVICE_DISCONNECTED: Your computer went to sleep during the backup, which disconnects the iPhone. ' +
  'Keep the computer plugged in with its lid open until the backup finishes, then click Retry.';

app.whenReady().then(async () => {
  // Belt and braces for the spellcheck: false above: with no languages set,
  // the default session has no dictionary to fetch. No-op on macOS.
  try {
    session.defaultSession.setSpellCheckerEnabled(false);
    session.defaultSession.setSpellCheckerLanguages([]);
  } catch {
    // macOS uses the system spell checker and rejects language changes.
  }

  // Register custom protocol to serve local media files (videos, images)
  // This avoids web security issues with file:// URLs
  protocol.handle('local-media', (request: any) => {
    // URL format: local-media://media/C:/path/to/file.mov
    const url = new URL(request.url);
    // hostname is 'media', pathname is '/C:/path/to/file.mov'
    let filePath = decodeURIComponent(url.pathname);
    // Remove leading slash on Windows paths (e.g. /C:/... → C:/...)
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.slice(1);
    }
    console.log('[local-media] serving:', filePath);
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Start the Python sidecar
  const logPath = path.join(app.getPath('userData'), 'python_log.txt');
  sidecar = new PythonSidecar(getPythonPath(), getPythonArgs(), logPath);
  const feedback = new FeedbackRecorder(logPath, app.getVersion());

  sidecar.notificationHandler = (notification: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sidecar:notification', notification);
    }
  };

  try {
    await sidecar.start();
    console.log('Python sidecar started');
  } catch (err) {
    console.error('Failed to start Python sidecar:', err);
  }

  createWindow();

  initUpdater({
    store,
    getWindow: () => mainWindow,
    // The installer replaces the engine binary, so it must not be running (Windows locks it).
    beforeInstall: async () => {
      if (sidecar) sidecar.stop();
      await new Promise(resolve => setTimeout(resolve, 1000));
    },
  });

  ipcMain.handle('app:get-version', () => app.getVersion());

  // ── Sidecar IPC bridge ──────────────────────────────────────────────────
  ipcMain.handle('sidecar:call', async (_event: any, method: string, params: any) => {
    const awake = method === 'backup.start' ? keepAwakeDuringBackup(logPath) : null;
    try {
      // Backups and saves send progress reports, and each one starts the time limit
      // over (sidecar.ts), so these limits are how long they may go without one.
      const timeoutMs = method === 'backup.start' ? 7_200_000 // the iPhone can sit preparing or waiting for its passcode
        : method === 'backup.install_device_support' ? 900_000 // winget may download slowly
        : method.startsWith('export_') ? 21_600_000 // a whole photo library to a slow drive can take hours
        : undefined;
      const result = await sidecar.call(method, params, timeoutMs);
      feedback.recordCall(method, params, { ok: true, result });
      if (method === 'open_backup') {
        const ts = new Date().toTimeString().slice(0, 8);
        const status = (result as any)?.status ?? 'unknown';
        fs.appendFileSync(logPath,
          `[${ts}] [Electron] open_backup → status=${status} udid=${params?.udid} dir=${params?.backup_dir}\n`);
      }
      return { success: true, data: result };
    } catch (error: any) {
      console.error(`Sidecar call failed: ${method}`, error);
      let message = String(error?.message ?? error);
      if (awake?.slept() && LOST_CONNECTION.test(message)) {
        appendLog(logPath, `[Electron] backup.start failed after the computer slept: ${message.split('\n')[0]}`);
        message = COMPUTER_SLEPT;
      }
      feedback.recordCall(method, params, { ok: false, error: message });
      if (method === 'open_backup') {
        const ts = new Date().toTimeString().slice(0, 8);
        fs.appendFileSync(logPath,
          `[${ts}] [Electron] open_backup FAILED: ${error.message} | udid=${params?.udid} dir=${params?.backup_dir}\n`);
      }
      return { success: false, error: message };
    } finally {
      awake?.stop();
    }
  });

  // ── PDF export of conversations (#91) ───────────────────────────────────
  removeStaleStagingDirs();
  ipcMain.handle('export:pdf', async (_event: any, method: PdfExportMethod, params: any) => {
    try {
      const data = await exportMessagesPdf(sidecar, method, params);
      return { success: true, data };
    } catch (error: any) {
      console.error('PDF export failed', error);
      feedback.recordCall(`pdf:${method}`, params, { ok: false, error: String(error?.message ?? error) });
      return { success: false, error: error?.message || String(error) };
    }
  });

  // ── Native dialogs ──────────────────────────────────────────────────────
  // Open a backup folder only reads, so it isn't checked against the program folder:
  // a backup that's already in there must stay openable, so its data can be saved elsewhere.
  ipcMain.handle('dialog:selectFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select iPhone Backup Folder',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // URLs reach here from untrusted backup content (e.g. links in iMessage text),
  // so only open web/mail links plus the app links we show ourselves: the System
  // Settings pane for Full Disk Access, and Apple Devices in the Microsoft Store.
  const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
  const APP_LINKS = new Set([
    'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    'ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K',
  ]);

  ipcMain.handle('shell:openExternal', (_event: any, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      console.warn('[shell:openExternal] rejected unparseable URL:', url);
      return;
    }
    if (!EXTERNAL_PROTOCOLS.has(parsed.protocol) && !APP_LINKS.has(parsed.href)) {
      console.warn('[shell:openExternal] rejected URL with disallowed scheme:', url);
      return;
    }
    shell.openExternal(parsed.href);
  });

  // Used after the user grants macOS Full Disk Access, which only takes effect
  // for newly launched processes (#84).
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('shell:openPath', (_event: any, filePath: string) => {
    return shell.openPath(filePath);
  });

  ipcMain.handle('shell:showItemInFolder', (_event: any, filePath: string) => {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
  });

  // ── Text size (Settings) ────────────────────────────────────────────────
  ipcMain.handle('text-size:get', () => store.get('textSize', 'default'));
  ipcMain.handle('text-size:set', (_event: any, size: string) => {
    if (!isTextSize(size)) return;
    store.set('textSize', size);
    applyTextSize();
  });

  // Back up my iPhone and every export save through these two, so neither accepts a
  // place inside the program folder, which every update deletes (see installFolder.ts).
  ipcMain.handle('dialog:saveFolder', async () => {
    return pickOutsideInstallFolder(
      async (retryIn) => {
        const result = await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose Export Location',
          ...(retryIn ? { defaultPath: retryIn } : {}),
        });
        return result.canceled ? null : result.filePaths[0];
      },
      () => documentsFolder(),
    );
  });

  ipcMain.handle('dialog:saveFile', async (_event: any, options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
    return pickOutsideInstallFolder(
      async (retryIn) => {
        const result = await dialog.showSaveDialog(mainWindow, {
          title: options.title || 'Save File',
          defaultPath: retryIn ?? options.defaultPath,
          filters: options.filters,
        });
        return result.canceled ? null : result.filePath;
      },
      // Keep the name they typed, in Documents.
      (chosen) => {
        const documents = documentsFolder();
        return documents ? path.join(documents, path.basename(chosen)) : undefined;
      },
    );
  });

  ipcMain.handle('fs:writeFile', async (_event: any, filePath: string, content: string) => {
    fs.writeFileSync(filePath, content, 'utf-8');
  });

  // ── App state persistence ───────────────────────────────────────────────
  ipcMain.handle('get-app-state', async () => {
    const sessions = (store.get('sessions', []) as any[])
      .sort((a: any, b: any) => new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime());
    const firstLaunch = store.get('firstLaunchCompleted', false) as boolean;
    const stats = store.get('stats', { totalExports: 0 }) as any;

    let state: string;
    if (sessions.length === 0 && !firstLaunch) state = 'first_visit';
    else if (sessions.length === 0 && firstLaunch) state = 'returned_no_data';
    else state = 'has_data';

    return {
      state,
      sessions,
      stats,
      totalDevices: sessions.filter((s: any) => s.type === 'device').length,
      totalSizeGB: sessions.reduce((sum: number, s: any) => sum + (s.sizeGB || 0), 0),
      totalMessages: 0,
      totalExports: stats.totalExports || 0,
    };
  });

  ipcMain.handle('set-first-launch-completed', () => {
    store.set('firstLaunchCompleted', true);
  });

  ipcMain.handle('add-session', (_event: any, session: any) => {
    const sessions = store.get('sessions', []) as any[];
    const existing = sessions.findIndex((s: any) => s.id === session.id);
    const merged = existing >= 0 ? { ...sessions[existing], ...session } : session;
    const rest = sessions.filter((s: any) => s.id !== session.id);
    store.set('sessions', [merged, ...rest].slice(0, 20));
  });

  ipcMain.handle('remove-session', (_event: any, id: string) => {
    const sessions = store.get('sessions', []) as any[];
    store.set('sessions', sessions.filter((s: any) => s.id !== id));
  });

  ipcMain.handle('get-recent-sessions', () => {
    return store.get('sessions', []);
  });

  // ── In-app feedback ─────────────────────────────────────────────────────
  // Returns the scrubbed facts for the feedback form. The renderer shows them to
  // the user, who can edit them before clicking Send.
  ipcMain.handle('feedback:get-diagnostics', (_event: any, reportedError?: string) => {
    return feedback.diagnostics(typeof reportedError === 'string' ? reportedError : undefined);
  });

  // Development builds can point the form at a local copy of the site's API.
  const feedbackSite = isDev && process.env.OPENEXTRACT_FEEDBACK_SITE ? process.env.OPENEXTRACT_FEEDBACK_SITE : undefined;
  const reports = new FeedbackReports(store, (url: string, init: any) => net.fetch(url, init), app.getVersion(), feedbackSite);

  ipcMain.handle('feedback:send', (_event: any, input: any) => reports.send(input ?? {}));
  ipcMain.handle('feedback:saved-email', () => store.get('feedbackEmail', ''));
  ipcMain.handle('feedback:fixed-reports', () => reports.fixedToAnnounce());
  ipcMain.handle('feedback:mark-announced', (_event: any, reference: string) => reports.markAnnounced(String(reference)));

  setTimeout(async () => {
    const fixed = await reports.checkIfDue().catch(() => false);
    if (fixed && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('feedback:fixed');
  }, FEEDBACK_CHECK_DELAY_MS);

  ipcMain.handle('feedback:export-check-opt-out', () => {
    store.set('exportCheckOptOut', true);
  });

  ipcMain.handle('feedback:thanks-offered', () => {
    store.set('thanksFollowUpShown', true);
  });

  ipcMain.handle('increment-export-count', (event: any, area?: string) => {
    const stats = store.get('stats', { totalExports: 0 }) as any;
    stats.totalExports = (stats.totalExports || 0) + 1;
    store.set('stats', stats);
    // Every export calls this after it succeeds, so this is where the one-time
    // "Your file is saved" card starts, unless a thank-you was already sent.
    // Remembered locally; nothing is sent anywhere.
    const exportArea = typeof area === 'string' ? area : undefined;
    if (!store.get('thanksCardShown', false) && !store.get('thanksSent', false)) {
      store.set('thanksCardShown', true);
      event.sender.send('share-prompt:show', exportArea);
    } else if (!exportCheckShownThisRun && !store.get('exportCheckOptOut', false)) {
      // "Did this export come out right?" catches exports that finish without
      // an error but come out empty or wrong. The answer stays on this computer.
      // "Looks right" may ask for a thank-you, once ever, and never after one was sent.
      exportCheckShownThisRun = true;
      const offerThanks = !store.get('thanksSent', false) && !store.get('thanksFollowUpShown', false);
      event.sender.send('export-check:show', exportArea, offerThanks);
    }
    return stats.totalExports;
  });

  ipcMain.handle('clipboard:writeText', (_event: any, text: string) => {
    clipboard.writeText(String(text ?? ''));
  });
});

app.on('window-all-closed', () => {
  if (sidecar) sidecar.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', async () => {
  await app.whenReady();
  if (BrowserWindow.getAllWindows().length === 0) {
    // On macOS the app outlives its last window, but window-all-closed stopped
    // the engine, so reopening from the Dock has to start it again.
    if (sidecar && !sidecar.running) {
      sidecar.start().catch((err: any) => console.error('Failed to start Python sidecar:', err));
    }
    createWindow();
  }
});
