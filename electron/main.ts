export {};
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net, session, clipboard, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
import { PythonSidecar } from './sidecar';
import { initUpdater } from './updater';
import { exportHtmlToPdf, exportMessagesPdf, PdfExportMethod, removeStaleStagingDirs } from './pdfExport';
import { safeBaseName, writeNewFile } from './newFile';
import { FeedbackRecorder } from './feedback';
import { FeedbackReports } from './feedbackReports';
import { installFolderFor, installFolderWarning, isInsideFolder, resolveReal } from './installFolder';
import { CHECK_OLDER_TIMEOUT_MS, takeMoveLock, trashOlderBackup } from './olderBackups';
import { isBusinessAnswer, recordSave, shouldAskBusiness } from './businessUse';
import { aiIndexUrl, bundledAddon } from './aiAddon';
import { registerAskAi } from './askAi';
// ── Media in the window (videos, posters): only from the engine's copy folders ──
const os = require('os');
const { nativeImage } = require('electron');
import { handleLocalMedia, mediaThumbnail } from './localMedia';

// Extensions that start a program or script when opened, on Windows, macOS or Linux.
// shell:openPath refuses these: it opens media and documents from a backup, and a
// file someone sent over WhatsApp can be named anything.
const CODE_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.scr', '.pif', '.msi', '.msp', '.mst', '.cpl', '.msc', '.jar',
  '.ps1', '.psm1', '.ps1xml', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.wsc', '.hta', '.chm',
  '.lnk', '.url', '.reg', '.inf', '.scf', '.application', '.appref-ms', '.gadget', '.xbap',
  '.settingcontent-ms', '.library-ms', '.diagcab', '.iso', '.img', '.vhd', '.vhdx',
  '.py', '.pyw', '.pyc', '.pl', '.rb', '.php',
  '.app', '.command', '.terminal', '.tool', '.pkg', '.mpkg', '.dmg', '.workflow', '.action',
  '.scpt', '.scptd', '.applescript', '.webloc', '.inetloc', '.fileloc', '.definition',
  '.sh', '.bash', '.zsh', '.csh', '.ksh', '.desktop', '.run', '.appimage', '.bin',
]);

/** Whether opening this path would run a program (Windows ignores trailing dots and spaces). */
export function runsCode(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !filePath) return true;
  return CODE_EXTENSIONS.has(path.extname(filePath.replace(/[. ]+$/, '')).toLowerCase());
}

/**
 * Whether the file's name says what kind of file it is. A name with no extension
 * doesn't, so the computer can't pick an app for it, and macOS runs such a file when
 * it is marked executable, as every file on an exFAT or NTFS drive is: a video opened
 * straight from a backup's folder, where files have no extension, started Terminal (#297).
 */
export function hasFileType(filePath: string): boolean {
  return path.extname(filePath.replace(/[. ]+$/, '')) !== '';
}

let mainWindow: any = null;
let sidecar: any = null;

const isDev = !app.isPackaged;
// The end-to-end tests (scripts/e2e) run an unpackaged build with the renderer from dist/,
// as packaged builds load it, and the engine from python/. Development builds only.
const isE2E = isDev && process.env.OPENEXTRACT_E2E === '1';
// The tests can also run with the window never shown (run.mjs --background), so a run on
// someone's Mac doesn't take the screen and keyboard from what they're doing. Showing a
// window is what brings the app to the front on macOS, even showInactive(). A window that
// was never shown still renders (paintWhenInitiallyHidden), so the tests and screenshots work.
const e2eHidden = isE2E && process.env.OPENEXTRACT_E2E_HIDDEN === '1';

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
  // True once the "Pay it forward" card has introduced Charles (the first export). Later
  // exports get the shorter ask. It replaced `thanksCardShown` (the older "Say thanks"
  // card), so people who saw that one get the introduction once too.
  payIntroShown: false,
  // True once the person says they paid ("I've paid" / "Already paid? Stop asking"). The app
  // can't see payments, so this is on trust; it stops the asks after exports for good.
  paidItForward: false,
  // True once the user picks "Don't ask again" on the "Did this export come out right?" card.
  exportCheckOptOut: false,
  // True once a thank-you was sent from the feedback form; the ask then drops its Say thanks button.
  thanksSent: false,
  // "Using it for paid work?" (businessUse.ts): hashed iPhone IDs → when something was last
  // saved from each, for the past year only; whether the question has shown (it shows once);
  // and the answer, 'work' or 'personal' (null if the card was closed without one).
  devicesSaved: {},
  businessAskShown: false,
  businessUse: null,
  // Feedback reports sent from this computer (reference, random lookup code, status),
  // the email last typed into the form, and when their status was last checked.
  feedbackReports: [],
  feedbackEmail: '',
  feedbackLastCheck: 0,
});

// Asks about open feedback reports this long after startup, if a check is due.
const FEEDBACK_CHECK_DELAY_MS = 15_000;

// The export check shows at most once per run, and never on the same export as the ask.
let exportCheckShownThisRun = false;
// The "Pay it forward" card was dismissed (its × or Say thanks): no more asks after exports until the app is opened again.
let askSnoozedThisRun = false;
// The iPhone whose backup is open (its ID from the last open_backup that opened), so a save
// can be counted against it for "Using it for paid work?".
let openDeviceId: string | null = null;

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
    show: !e2eHidden,
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

/**
 * The temp folders the engine's copies are in (python/app_copies.py uses Python's
 * tempfile.gettempdir(), which follows the same TMPDIR / TEMP as these).
 */
function mediaFolders(): string[] {
  const folders = [os.tmpdir()];
  try {
    folders.push(app.getPath('temp'));
  } catch {
    // os.tmpdir() alone
  }
  return folders;
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
// The engine adds this when the folder had an earlier backup, which a failed try doesn't touch
// (EARLIER_UNCHANGED in python/device_backup.py). It's as true when the computer slept.
const EARLIER_UNCHANGED = "The backup that was already in that folder hasn't been changed.";
// How long the app waits for a search for iPhones (backup.list_devices; see the sidecar:call
// handler). python/tests/test_fake_iphone_search.py checks the engine's own limits fit inside it.
const LIST_DEVICES_TIMEOUT_MS = 90_000;

app.whenReady().then(async () => {
  // Belt and braces for the spellcheck: false above: with no languages set,
  // the default session has no dictionary to fetch. No-op on macOS.
  try {
    session.defaultSession.setSpellCheckerEnabled(false);
    session.defaultSession.setSpellCheckerLanguages([]);
  } catch {
    // macOS uses the system spell checker and rejects language changes.
  }

  // local-media://media/<path>: a video or sound the engine copied out of the backup,
  // played in the window with seeking. Only files in the engine's copy folders
  // (electron/localMedia.ts); anything else on the computer is "not found".
  protocol.handle('local-media', (request: any) => handleLocalMedia(request, mediaFolders()));

  // Start the Python sidecar
  const logPath = path.join(app.getPath('userData'), 'python_log.txt');
  sidecar = new PythonSidecar(getPythonPath(), getPythonArgs(), logPath);
  const feedback = new FeedbackRecorder(logPath, app.getVersion());
  // Before the engine starts and writes to the log: it is kept one file per time the app
  // is opened, so a report carries this time's errors and not ones from versions ago (#298).
  feedback.beginSession();

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

  // Ask AI (askAi.ts): only in builds made with OPENEXTRACT_AI_INDEX_URL, or carrying the add-on
  // (OPENEXTRACT_AI_BUNDLED_MCPB), which a packaged app reads from build-info.json beside this file. Without it every call answers that it's off, and
  // the hooks below (what the engine found and opened, for the add-on's backups.json) do nothing.
  const askAi = registerAskAi({
    ipcMain,
    shell,
    store,
    indexUrl: aiIndexUrl({ isPackaged: app.isPackaged, buildInfoDir: __dirname, env: process.env }),
    bundled: bundledAddon({ isPackaged: app.isPackaged, buildInfoDir: __dirname, resourcesPath: (process as any).resourcesPath, env: process.env }),
    platform: process.platform,
    arch: process.arch,
    translated: app.runningUnderARM64Translation === true,
    env: process.env,
    homedir: os.homedir(),
    fetch: (url: string, init: any) => net.fetch(url, init),
  });

  // ── Sidecar IPC bridge ──────────────────────────────────────────────────
  ipcMain.handle('sidecar:call', async (_event: any, method: string, params: any) => {
    const awake = method === 'backup.start' ? keepAwakeDuringBackup(logPath) : null;
    try {
      // Backups and saves send progress reports, and each one starts the time limit
      // over (sidecar.ts), so these limits are how long they may go without one.
      const timeoutMs = method === 'backup.start' ? 7_200_000 // the iPhone can sit preparing or waiting for its passcode
        : method === 'backup.install_device_support' ? 900_000 // winget may download slowly
        : method.startsWith('export_') ? 21_600_000 // a whole photo library to a slow drive can take hours
        // The engine gives each step of the search its own limit and lists an iPhone that
        // doesn't answer, so a search ends within about 40 seconds (python/device_backup.py,
        // _ANSWER_TIMEOUT_S). This is in case it doesn't: before, one silent iPhone held the
        // search for the 5-minute default (OE-37, OE-8, OE-31). It leaves room for the first
        // search on Windows, which may have to start Apple Devices first.
        : method === 'backup.list_devices' ? LIST_DEVICES_TIMEOUT_MS
        : undefined;
      const result = await sidecar.call(method, params, timeoutMs);
      feedback.recordCall(method, params, { ok: true, result });
      if (method === 'open_backup' && (result as any)?.status !== 'password_required') {
        // Info.plist's ID when the engine has it: a newer backup beside an older one has a
        // dated folder name, but it's still the same iPhone.
        const id = (result as any)?.info?.udid ?? params?.udid;
        openDeviceId = typeof id === 'string' && id.trim() ? id : null;
      }
      if (method === 'open_backup' && (result as any)?.status === 'open') {
        askAi.backupOpened((result as any)?.info?.backup_dir ?? params?.backup_dir);
      }
      if (method === 'list_backups' && Array.isArray((result as any)?.backups)) {
        askAi.backupsFound((result as any).backups.map((b: any) => b?.backup_dir));
      }
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
        message = message.includes(EARLIER_UNCHANGED) ? `${COMPUTER_SLEPT} ${EARLIER_UNCHANGED}` : COMPUTER_SLEPT;
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

  // ── An older backup to the Trash ────────────────────────────────────────
  // The only thing in the app that removes a backup, and only to the Trash (olderBackups.ts).
  // The window says which; it can't skip the checks or the question.
  ipcMain.handle('backup:trashOlder', async (_event: any, udid: unknown, backupDir: unknown) => {
    const params = { udid, backup_dir: backupDir };
    try {
      return await trashOlderBackup({
        platform: process.platform,
        lock: () => takeMoveLock(process.platform),
        check: async (id, dir) => {
          const found = await sidecar.call('backup.check_older', { udid: id, backup_dir: dir }, CHECK_OLDER_TIMEOUT_MS);
          feedback.recordCall('backup.check_older', params, { ok: true, result: found });
          return found;
        },
        // No window to ask in means no.
        confirm: async options =>
          mainWindow && !mainWindow.isDestroyed() ? dialog.showMessageBox(mainWindow, options) : { response: 0 },
        trashItem: target => {
          // Windows won't move the folder this process is working in, as a file dialog can leave it.
          try {
            if (isInsideFolder(resolveReal(process.cwd()), resolveReal(target))) process.chdir(os.homedir());
          } catch {
            // The working folder has gone, so it's in nobody's way.
          }
          return shell.trashItem(target);
        },
        exists: target => {
          try {
            fs.lstatSync(target);
            return true;
          } catch (err: any) {
            return err?.code === 'ENOENT' ? false : null;
          }
        },
      }, udid, backupDir);
    } catch (error: any) {
      const message = String(error?.message ?? error);
      console.error('Checking an older backup failed', error);
      feedback.recordCall('backup.check_older', params, { ok: false, error: message });
      return { status: 'failed', message: "OpenExtract couldn't check that backup, so it didn't move it." };
    }
  });

  // ── PDF export of conversations (#91) ───────────────────────────────────
  removeStaleStagingDirs();
  ipcMain.handle('export:pdf', async (_event: any, method: PdfExportMethod, params: any) => {
    try {
      const data = await exportMessagesPdf(sidecar, method, params, step => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sidecar:notification', { jsonrpc: '2.0', method: 'pdf.progress', params: step });
        }
      });
      return { success: true, data };
    } catch (error: any) {
      console.error('PDF export failed', error);
      feedback.recordCall(`pdf:${method}`, params, { ok: false, error: String(error?.message ?? error) });
      return { success: false, error: error?.message || String(error) };
    }
  });
  // A page the window built (the Timeline), printed the same way. Only the folder is
  // recorded for feedback, never the page: it holds the backup's messages.
  ipcMain.handle('export:pdf-html', async (_event: any, html: string, outputDir: string, baseName: string) => {
    try {
      const data = await exportHtmlToPdf(html, outputDir, baseName);
      return { success: true, data };
    } catch (error: any) {
      console.error('PDF export failed', error);
      feedback.recordCall('pdf:page', { output_dir: outputDir }, { ok: false, error: String(error?.message ?? error) });
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
    // A second guard behind the engine's (python/app_copies.py marks such copies as
    // not openable): a file someone sent, named "Invoice.pdf.exe", must never run.
    if (runsCode(filePath)) return "OpenExtract doesn't open programs or scripts.";
    // And never a file where it lies in a backup's folder: the engine hands over a copy
    // under the file's own name, and anything without a file type isn't one of those.
    if (!hasFileType(filePath)) return "OpenExtract doesn't open a file with no file type in its name.";
    return shell.openPath(filePath);
  });

  ipcMain.handle('shell:showItemInFolder', (_event: any, filePath: string) => {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
  });

  // A video's poster frame, from a copy the engine made (get_attachment / get_whatsapp_attachment
  // with as_file): a JPEG data: URL, or null (Linux, a path outside the copy folders, or a file the
  // system's previewer can't draw).
  ipcMain.handle('media:thumbnail', (_event: any, filePath: unknown, size: unknown) =>
    mediaThumbnail(filePath, size, { tempDirs: mediaFolders(), nativeImage }));

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
          // macOS and Windows always ask before replacing a file; Linux only with this
          properties: ['showOverwriteConfirmation'],
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

  // fs:writeFile replaces, so it's only for a file chosen in the Save dialog, which asks first.
  // A save into a chosen folder uses fs:writeNewFile, and shows the path that returns.
  ipcMain.handle('fs:writeFile', async (_event: any, filePath: string, content: string) => {
    fs.writeFileSync(filePath, content, 'utf-8');
  });
  ipcMain.handle('fs:writeNewFile', async (_event: any, folder: string, baseName: string, extension: string, content: string) => {
    if (typeof folder !== 'string' || !folder) throw new Error('Choose a folder to save in.');
    if (!/^[a-z0-9]{1,8}$/i.test(extension)) throw new Error(`Can't save a .${extension} file.`);
    return writeNewFile(path.join(folder, `${safeBaseName(baseName)}.${extension}`), content);
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

  // "Pay it forward": all of it stays on this computer. The app never sees payments.
  ipcMain.handle('support:status', () => ({
    paid: store.get('paidItForward', false) === true,
    thanksSent: store.get('thanksSent', false) === true,
  }));
  ipcMain.handle('support:snooze', () => {
    askSnoozedThisRun = true;
  });
  ipcMain.handle('support:paid', () => {
    store.set('paidItForward', true);
  });
  // "Using it for paid work?": 'work' or 'personal'. Kept on this computer only.
  ipcMain.handle('support:business-answer', (_event: any, answer: unknown) => {
    if (isBusinessAnswer(answer)) store.set('businessUse', answer);
  });

  ipcMain.handle('increment-export-count', (event: any, area?: string) => {
    const stats = store.get('stats', { totalExports: 0 }) as any;
    stats.totalExports = (stats.totalExports || 0) + 1;
    store.set('stats', stats);
    // Every export calls this after it succeeds, so the card after an export starts
    // here, never before or during one. Remembered locally; nothing is sent anywhere.
    //  - First export: "Pay it forward" with Charles's introduction.
    //  - Once per run: "Did this export come out right?", which catches exports that finish
    //    without an error but come out empty or wrong. "Looks right" leads to the ask.
    //  - Every other export: the shorter ask.
    // Dismissing the ask quiets it until the app is opened again; "I've paid" ends it.
    const exportArea = typeof area === 'string' ? area : undefined;
    const paid = store.get('paidItForward', false) === true;
    // Many different iPhones in a year: once, ask whether it's paid work, instead of the
    // other cards on this export (businessUse.ts). Only hashed IDs are kept.
    if (openDeviceId) {
      const saved = recordSave(store.get('devicesSaved', {}), openDeviceId, Date.now());
      store.set('devicesSaved', saved.log);
      if (shouldAskBusiness({ count: saved.count, shown: store.get('businessAskShown', false) === true, paid })) {
        store.set('businessAskShown', true);
        event.sender.send('business-card:show', saved.count);
        return stats.totalExports;
      }
    }
    if (!paid && !store.get('payIntroShown', false)) {
      store.set('payIntroShown', true);
      event.sender.send('share-prompt:show', exportArea, true);
    } else if (!exportCheckShownThisRun && !store.get('exportCheckOptOut', false)) {
      exportCheckShownThisRun = true;
      event.sender.send('export-check:show', exportArea, !paid && !askSnoozedThisRun);
    } else if (!paid && !askSnoozedThisRun) {
      event.sender.send('share-prompt:show', exportArea, false);
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
