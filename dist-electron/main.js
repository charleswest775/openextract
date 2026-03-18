"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const sidecar_1 = require("./sidecar");
let mainWindow = null;
let sidecar = null;
const isDev = !app.isPackaged;
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
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
    }
    else {
        mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    }
}
function findVenvPython() {
    const fs = require('fs');
    const rel = process.platform === 'win32'
        ? path.join('.venv', 'Scripts', 'python.exe')
        : path.join('.venv', 'bin', 'python');
    // Start at the project root (one above electron/) and walk up to handle
    // git worktrees where .venv lives in the main repo, not the worktree.
    let dir = path.resolve(__dirname, '..');
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, rel);
        if (fs.existsSync(candidate))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            break; // reached filesystem root
        dir = parent;
    }
    // Fallback: hope Python is on PATH
    return process.platform === 'win32' ? 'python.exe' : 'python3';
}
function getPythonPath() {
    if (isDev) {
        return findVenvPython();
    }
    // In production, use the bundled PyInstaller executable
    const resourcePath = process.resourcesPath || '';
    const binaryName = process.platform === 'win32' ? 'openextract-engine.exe' : 'openextract-engine';
    return path.join(resourcePath, 'python', binaryName);
}
function getPythonArgs() {
    if (isDev) {
        return [path.join(__dirname, '..', 'python', 'main.py'), '--debug'];
    }
    return [];
}
app.whenReady().then(async () => {
    // Start the Python sidecar
    sidecar = new sidecar_1.PythonSidecar(getPythonPath(), getPythonArgs());
    // Forward JSON-RPC notifications from the sidecar to the renderer.
    // The sidecar sends notifications (no id field) during long-running
    // operations such as backup.start — this pipes them through to the
    // renderer via the 'sidecar:notification' IPC channel.
    sidecar.notificationHandler = (notification) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('sidecar:notification', notification);
        }
    };
    try {
        await sidecar.start();
        console.log('Python sidecar started');
    }
    catch (err) {
        console.error('Failed to start Python sidecar:', err);
    }
    createWindow();
    // Bridge IPC: renderer -> Python sidecar
    ipcMain.handle('sidecar:call', async (_event, method, params) => {
        try {
            // Backup operations can take hours on large devices — use a much longer timeout.
            const timeoutMs = method === 'backup.start' ? 7200000 : undefined; // 2 hours
            const result = await sidecar.call(method, params, timeoutMs);
            // Log open_backup results so failures are visible in python_log.txt
            if (method === 'open_backup') {
                const fs = require('fs');
                const ts = new Date().toTimeString().slice(0, 8);
                const status = result?.status ?? 'unknown';
                fs.appendFileSync('python_log.txt', `[${ts}] [Electron] open_backup → status=${status} udid=${params?.udid} dir=${params?.backup_dir}\n`);
            }
            return { success: true, data: result };
        }
        catch (error) {
            console.error(`Sidecar call failed: ${method}`, error);
            // Always log open_backup failures to python_log.txt
            if (method === 'open_backup') {
                const fs = require('fs');
                const ts = new Date().toTimeString().slice(0, 8);
                fs.appendFileSync('python_log.txt', `[${ts}] [Electron] open_backup FAILED: ${error.message} | udid=${params?.udid} dir=${params?.backup_dir}\n`);
            }
            return { success: false, error: error.message };
        }
    });
    // Native dialog for selecting backup folder
    ipcMain.handle('dialog:selectFolder', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            title: 'Select iPhone Backup Folder',
        });
        return result.canceled ? null : result.filePaths[0];
    });
    // Open URL in the system browser
    ipcMain.handle('shell:openExternal', (_event, url) => {
        shell.openExternal(url);
    });
    // Native dialog for save location
    ipcMain.handle('dialog:saveFolder', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'createDirectory'],
            title: 'Choose Export Location',
        });
        return result.canceled ? null : result.filePaths[0];
    });
});
app.on('window-all-closed', () => {
    if (sidecar)
        sidecar.stop();
    if (process.platform !== 'darwin')
        app.quit();
});
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0)
        createWindow();
});
