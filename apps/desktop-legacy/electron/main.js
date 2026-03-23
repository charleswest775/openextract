"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
function getPythonPath() {
    if (isDev) {
        return process.platform === 'win32'
            ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
            : path.join(__dirname, '..', '.venv', 'bin', 'python');
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
    await sidecar.start();
    console.log('Python sidecar started');
    createWindow();
    // Bridge IPC: renderer -> Python sidecar
    ipcMain.handle('sidecar:call', async (_event, method, params) => {
        try {
            const result = await sidecar.call(method, params);
            return { success: true, data: result };
        }
        catch (error) {
            console.error(`Sidecar call failed: ${method}`, error);
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
