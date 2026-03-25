export {};
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
import { PythonSidecar } from './sidecar';
import { TrayManager } from './tray';
import { DeviceWatcher } from './device-watcher';

let mainWindow: any = null;
let sidecar: any = null;
let trayManager: TrayManager | null = null;
let deviceWatcher: DeviceWatcher | null = null;

// Track extraction state for the status IPC handler
let extractionStatus: { running: boolean; progress: number; message: string } = {
  running: false,
  progress: 0,
  message: 'Idle',
};

const isDev = !app.isPackaged;

function createWindow(route?: string) {
  // If the window already exists, just show it and optionally navigate
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    if (route) {
      navigateToRoute(route);
    }
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'OpenExtract',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (route) {
      navigateToRoute(route);
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5179');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // When the window is closed, null the reference but don't quit
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function navigateToRoute(route: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isDev) {
    mainWindow.loadURL(`http://127.0.0.1:5179/#${route}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      hash: route,
    });
  }
}

function findVenvPython(): string {
  const fs = require('fs');
  const rel = process.platform === 'win32'
    ? path.join('.venv', 'Scripts', 'python.exe')
    : path.join('.venv', 'bin', 'python');
  // Start at the project root (one above electron/) and walk up to handle
  // git worktrees where .venv lives in the main repo, not the worktree.
  let dir = path.resolve(__dirname, '..');
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  // Fallback: hope Python is on PATH
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function getPythonPath(): string {
  if (isDev) {
    return findVenvPython();
  }
  // In production, use the bundled PyInstaller executable
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

/**
 * Forward a sidecar notification to both the main window (if open) and the tray.
 */
function handleSidecarNotification(notification: any) {
  // Forward to renderer window if it exists
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sidecar:notification', notification);
  }

  // Forward relevant notifications to the tray
  if (!trayManager) return;

  const method: string = notification.method || '';
  const params: any = notification.params || {};

  if (method === 'backup.progress') {
    const pct = params.percent ?? params.progress ?? 0;
    const msg = params.message || 'Backup in progress...';
    // Silently update tooltip only — no balloon on every tick
    trayManager.setTooltip(`OpenExtract — Backup ${pct}%: ${msg}`);
    trayManager.setIconState('syncing');
  } else if (method === 'extraction.progress') {
    const pct = params.percent ?? params.progress ?? 0;
    const msg = params.message || 'Extracting...';
    // Silently update tooltip only — no balloon on every tick
    trayManager.setTooltip(`OpenExtract — Extraction ${pct}%: ${msg}`);
    trayManager.setIconState('syncing');
    extractionStatus = { running: true, progress: pct, message: msg };
  } else if (method === 'extraction.complete') {
    const count = params.count ?? params.total ?? 0;
    trayManager.setTooltip('OpenExtract — Extraction complete');
    trayManager.setIconState('idle');
    trayManager.showBalloon('Extraction Complete', `Extracted ${count} items successfully.`);
    extractionStatus = { running: false, progress: 100, message: `Done — ${count} items` };
  }
}

// On macOS, hide from Dock to be tray-only
if (process.platform === 'darwin') {
  app.dock.hide();
}

app.whenReady().then(async () => {
  // Start the Python sidecar
  sidecar = new PythonSidecar(getPythonPath(), getPythonArgs());

  // Route all sidecar notifications through the unified handler
  sidecar.notificationHandler = handleSidecarNotification;

  try {
    await sidecar.start();
    console.log('Python sidecar started');
  } catch (err) {
    console.error('Failed to start Python sidecar:', err);
  }

  // --- System Tray Setup (NO window on startup) ---
  trayManager = new TrayManager();

  const iconDir = isDev
    ? path.join(__dirname, '..', 'assets')
    : path.join((process as any).resourcesPath || __dirname, 'assets');

  trayManager.create(iconDir);
  trayManager.setTooltip('OpenExtract — Ready');
  trayManager.setIconState('idle');

  // Wire tray callbacks
  trayManager.onShowFullUI = () => {
    createWindow();
  };

  trayManager.onShowSettings = () => {
    createWindow('/settings');
  };

  trayManager.onQuickAnalyze = (objective: string) => {
    // Placeholder: send analysis request to sidecar
    if (sidecar) {
      sidecar.call('analyze.quick', { objective }).catch((err: Error) => {
        console.error('Quick analyze failed:', err);
      });
    }
    // Also open the UI so the user can see results
    createWindow();
  };

  trayManager.onExtractFromBackup = async () => {
    // Let the user pick any existing backup folder and run extraction on it
    const parentWindow = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
    const result = await dialog.showOpenDialog(parentWindow, {
      properties: ['openDirectory'],
      title: 'Select iPhone Backup Folder',
    });
    if (result.canceled || !result.filePaths[0]) return;

    const backupDir = result.filePaths[0];
    trayManager?.setIconState('syncing');
    trayManager?.setTooltip('OpenExtract — Opening backup...');

    try {
      // Open the backup (reads Manifest.db, Info.plist)
      const openResult = await sidecar.call('open_backup', { backup_dir: backupDir });
      const udid = openResult?.udid || openResult?.backup_info?.udid || 'unknown';

      trayManager?.showBalloon('Extraction Started', `Extracting artifacts from backup...`);
      trayManager?.setTooltip('OpenExtract — Extracting...');

      // Run extraction
      const extractResult = await sidecar.call(
        'extraction.start',
        { udid, backup_dir: backupDir },
        7_200_000,
      );

      const count = extractResult?.total_artifacts || 0;
      trayManager?.setIconState('idle');
      trayManager?.setTooltip('OpenExtract — Ready');
      trayManager?.showBalloon('Extraction Complete', `${count} artifacts extracted successfully.`);
    } catch (err: any) {
      console.error('Extract from backup failed:', err);
      trayManager?.setIconState('attention');
      trayManager?.setTooltip('OpenExtract — Extraction failed');
      trayManager?.showBalloon('Extraction Failed', err.message || 'Unknown error');
    }
  };

  trayManager.onExport = async () => {
    // If no window, create one first so the dialog has a parent
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      // Wait a beat for the window to be ready
      await new Promise((r) => setTimeout(r, 500));
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Export Location',
    });
    if (!result.canceled && result.filePaths[0]) {
      if (sidecar) {
        try {
          await sidecar.call('export.start', { output_dir: result.filePaths[0] });
        } catch (err: any) {
          console.error('Export failed:', err);
        }
      }
    }
  };

  trayManager.onQuit = () => {
    if (deviceWatcher) deviceWatcher.stop();
    if (sidecar) sidecar.stop();
    if (trayManager) trayManager.destroy();
    deviceWatcher = null;
    trayManager = null;
    app.quit();
  };

  // --- DeviceWatcher (auto-backup + extraction) ---
  deviceWatcher = new DeviceWatcher(sidecar);

  deviceWatcher.onDeviceConnected = (device) => {
    console.log(`[Main] Device connected: ${device.name}`);
    trayManager?.setIconState('connected');
    trayManager?.setTooltip(`OpenExtract — ${device.name} connected`);
    trayManager?.showBalloon('iPhone Connected', `${device.name} detected. Syncing...`);
  };

  deviceWatcher.onDeviceDisconnected = (device) => {
    console.log(`[Main] Device disconnected: ${device.name}`);
    trayManager?.setIconState('idle');
    trayManager?.setTooltip('OpenExtract — Ready');
  };

  deviceWatcher.onBackupStarted = (device) => {
    trayManager?.setIconState('syncing');
    trayManager?.setTooltip(`OpenExtract — Backing up ${device.name}...`);
  };

  deviceWatcher.onBackupComplete = (device, backupPath) => {
    trayManager?.showBalloon('Backup Complete', `${device.name} backed up. Extracting artifacts...`);
  };

  deviceWatcher.onExtractionComplete = (udid, count) => {
    trayManager?.setIconState('idle');
    trayManager?.setTooltip('OpenExtract — Ready');
    trayManager?.showBalloon('Extraction Complete', `${count} artifacts extracted successfully.`);
  };

  deviceWatcher.onError = (device, phase, error) => {
    console.error(`[Main] DeviceWatcher error (${phase}):`, error);
    trayManager?.setIconState('attention');
    const deviceName = device?.name || 'Unknown device';
    trayManager?.setTooltip(`OpenExtract — ${phase} failed`);
    trayManager?.showBalloon(`${phase.charAt(0).toUpperCase() + phase.slice(1)} Failed`, `${deviceName}: ${error}`);
  };

  deviceWatcher.start();

  // --- IPC Handlers ---

  // Bridge IPC: renderer -> Python sidecar
  ipcMain.handle('sidecar:call', async (_event: any, method: string, params: any) => {
    try {
      // Backup operations can take hours on large devices — use a much longer timeout.
      const timeoutMs = method === 'backup.start' ? 7_200_000 : undefined; // 2 hours
      const result = await sidecar.call(method, params, timeoutMs);
      // Log open_backup results so failures are visible in python_log.txt
      if (method === 'open_backup') {
        const fs = require('fs');
        const ts = new Date().toTimeString().slice(0, 8);
        const status = (result as any)?.status ?? 'unknown';
        fs.appendFileSync('python_log.txt',
          `[${ts}] [Electron] open_backup → status=${status} udid=${params?.udid} dir=${params?.backup_dir}\n`);
      }
      return { success: true, data: result };
    } catch (error: any) {
      console.error(`Sidecar call failed: ${method}`, error);
      // Always log open_backup failures to python_log.txt
      if (method === 'open_backup') {
        const fs = require('fs');
        const ts = new Date().toTimeString().slice(0, 8);
        fs.appendFileSync('python_log.txt',
          `[${ts}] [Electron] open_backup FAILED: ${error.message} | udid=${params?.udid} dir=${params?.backup_dir}\n`);
      }
      return { success: false, error: error.message };
    }
  });

  // Native dialog for selecting backup folder
  ipcMain.handle('dialog:selectFolder', async () => {
    // Use mainWindow as parent if available, otherwise null (dialog still works)
    const parentWindow = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
    const result = await dialog.showOpenDialog(parentWindow, {
      properties: ['openDirectory'],
      title: 'Select iPhone Backup Folder',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Open URL in the system browser
  ipcMain.handle('shell:openExternal', (_event: any, url: string) => {
    shell.openExternal(url);
  });

  // Native dialog for save location
  ipcMain.handle('dialog:saveFolder', async () => {
    const parentWindow = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
    const result = await dialog.showOpenDialog(parentWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Export Location',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // New: trigger extraction via sidecar
  ipcMain.handle('extraction:start', async (_event: any, params: any) => {
    if (!sidecar) {
      return { success: false, error: 'Sidecar is not running' };
    }
    try {
      extractionStatus = { running: true, progress: 0, message: 'Starting extraction...' };
      const result = await sidecar.call('extraction.start', params || {}, 7_200_000);
      extractionStatus = { running: false, progress: 100, message: 'Complete' };
      return { success: true, data: result };
    } catch (error: any) {
      extractionStatus = { running: false, progress: 0, message: `Failed: ${error.message}` };
      return { success: false, error: error.message };
    }
  });

  // New: return current extraction status
  ipcMain.handle('extraction:status', async () => {
    return { success: true, data: extractionStatus };
  });
});

// Keep tray running when all windows are closed — do NOT quit
app.on('window-all-closed', () => {
  // No-op: the app stays alive in the system tray.
  // Quitting is handled by the tray's Quit menu item.
});

app.on('activate', () => {
  // On macOS, re-create the window when the dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
