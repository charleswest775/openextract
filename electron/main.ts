export {};
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
import { PythonSidecar } from './sidecar';

let mainWindow: any = null;
let sidecar: any = null;

const isDev = !app.isPackaged;

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
  sessions: [],
  stats: { totalExports: 0 },
});

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'OpenExtract',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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
  sidecar = new PythonSidecar(getPythonPath(), getPythonArgs());

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

  // ── Sidecar IPC bridge ──────────────────────────────────────────────────
  ipcMain.handle('sidecar:call', async (_event: any, method: string, params: any) => {
    try {
      const timeoutMs = method === 'backup.start' ? 7_200_000 : undefined;
      const result = await sidecar.call(method, params, timeoutMs);
      if (method === 'open_backup') {
        const ts = new Date().toTimeString().slice(0, 8);
        const status = (result as any)?.status ?? 'unknown';
        fs.appendFileSync('python_log.txt',
          `[${ts}] [Electron] open_backup → status=${status} udid=${params?.udid} dir=${params?.backup_dir}\n`);
      }
      return { success: true, data: result };
    } catch (error: any) {
      console.error(`Sidecar call failed: ${method}`, error);
      if (method === 'open_backup') {
        const ts = new Date().toTimeString().slice(0, 8);
        fs.appendFileSync('python_log.txt',
          `[${ts}] [Electron] open_backup FAILED: ${error.message} | udid=${params?.udid} dir=${params?.backup_dir}\n`);
      }
      return { success: false, error: error.message };
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

  ipcMain.handle('shell:openExternal', (_event: any, url: string) => {
    shell.openExternal(url);
  });

  ipcMain.handle('shell:openPath', (_event: any, filePath: string) => {
    return shell.openPath(filePath);
  });

  ipcMain.handle('dialog:saveFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Export Location',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── App state persistence ───────────────────────────────────────────────
  ipcMain.handle('get-app-state', async () => {
    const sessions = store.get('sessions', []) as any[];
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
    if (existing >= 0) {
      sessions[existing] = { ...sessions[existing], ...session };
    } else {
      sessions.unshift(session);
    }
    store.set('sessions', sessions.slice(0, 20));
  });

  ipcMain.handle('remove-session', (_event: any, id: string) => {
    const sessions = store.get('sessions', []) as any[];
    store.set('sessions', sessions.filter((s: any) => s.id !== id));
  });

  ipcMain.handle('get-recent-sessions', () => {
    return store.get('sessions', []);
  });

  ipcMain.handle('increment-export-count', () => {
    const stats = store.get('stats', { totalExports: 0 }) as any;
    stats.totalExports = (stats.totalExports || 0) + 1;
    store.set('stats', stats);
    return stats.totalExports;
  });
});

app.on('window-all-closed', () => {
  if (sidecar) sidecar.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
