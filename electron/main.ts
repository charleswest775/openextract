export {};
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
import { PythonSidecar } from './sidecar';
import { initUpdater } from './updater';
import { exportMessagesPdf, PdfExportMethod, removeStaleStagingDirs } from './pdfExport';
import { FeedbackRecorder } from './feedback';
import { FeedbackReports } from './feedbackReports';

let mainWindow: any = null;
let sidecar: any = null;

const isDev = !app.isPackaged;

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
  // True once the "star or tell a friend" prompt has been shown. It shows at most once.
  sharePromptShown: false,
  // True once the user picks "Don't ask again" on the "Did this export come out right?" card.
  exportCheckOptOut: false,
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

function applyTextSize() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.setZoomFactor(TEXT_SIZE_ZOOM[store.get('textSize', 'default')] ?? 1);
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

  if (isDev) {
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
    return findVenvPython();
  }
  const resourcePath = (process as any).resourcesPath || '';
  const binaryName = process.platform === 'win32' ? 'openextract-engine.exe' : 'openextract-engine';
  return path.join(resourcePath, 'python', binaryName);
}

function getPythonArgs(): string[] {
  if (isDev) {
    return [path.join(__dirname, '..', 'python', 'main.py'), '--debug'];
  }
  return [];
}

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
    try {
      const timeoutMs = method === 'backup.start' ? 7_200_000
        : method === 'backup.install_device_support' ? 900_000 // winget may download slowly
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
      feedback.recordCall(method, params, { ok: false, error: String(error?.message ?? error) });
      if (method === 'open_backup') {
        const ts = new Date().toTimeString().slice(0, 8);
        fs.appendFileSync(logPath,
          `[${ts}] [Electron] open_backup FAILED: ${error.message} | udid=${params?.udid} dir=${params?.backup_dir}\n`);
      }
      return { success: false, error: error.message };
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
    if (!(size in TEXT_SIZE_ZOOM)) return;
    store.set('textSize', size);
    applyTextSize();
  });

  ipcMain.handle('dialog:saveFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Export Location',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:saveFile', async (_event: any, options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || 'Save File',
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
    return result.canceled ? null : result.filePath;
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

  ipcMain.handle('increment-export-count', (event: any, area?: string) => {
    const stats = store.get('stats', { totalExports: 0 }) as any;
    stats.totalExports = (stats.totalExports || 0) + 1;
    store.set('stats', stats);
    // Every export calls this after it succeeds, so this is where the one-time
    // share prompt starts. Remembered locally; nothing is sent anywhere.
    if (!store.get('sharePromptShown', false)) {
      store.set('sharePromptShown', true);
      event.sender.send('share-prompt:show');
    } else if (!exportCheckShownThisRun && !store.get('exportCheckOptOut', false)) {
      // "Did this export come out right?" catches exports that finish without
      // an error but come out empty or wrong. The answer stays on this computer.
      exportCheckShownThisRun = true;
      event.sender.send('export-check:show', typeof area === 'string' ? area : undefined);
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
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
