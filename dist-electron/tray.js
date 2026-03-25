"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrayManager = void 0;
const { Tray, Menu, nativeImage, BrowserWindow } = require('electron');
const path = require('path');
class TrayManager {
    constructor() {
        this.tray = null;
        this.statusWindow = null;
        this.iconState = 'idle';
        this.tooltipText = 'OpenExtract — Starting...';
        // Callbacks set by main.ts
        this.onShowFullUI = null;
        this.onShowSettings = null;
        this.onQuickAnalyze = null;
        this.onExtractFromBackup = null;
        this.onExport = null;
        this.onQuit = null;
    }
    create(iconDir) {
        // Prefer .ico on Windows (renders crisply in the system tray),
        // fall back to .png on other platforms or if .ico is missing.
        const fs = require('fs');
        const icoPath = path.join(iconDir, 'icon.ico');
        const pngPath = path.join(iconDir, 'icon.png');
        const iconPath = (process.platform === 'win32' && fs.existsSync(icoPath))
            ? icoPath
            : pngPath;
        let icon;
        try {
            icon = nativeImage.createFromPath(iconPath);
            if (icon.isEmpty())
                throw new Error('empty');
        }
        catch {
            // Fallback: create a tiny 16x16 placeholder icon
            icon = nativeImage.createEmpty();
        }
        this.tray = new Tray(icon);
        this.tray.setToolTip(this.tooltipText);
        this.rebuildMenu();
        // Double-click opens the full UI
        this.tray.on('double-click', () => {
            this.onShowFullUI?.();
        });
    }
    rebuildMenu() {
        if (!this.tray)
            return;
        const template = [
            { label: 'Status', click: () => this.showStatusWindow() },
            { type: 'separator' },
            {
                label: 'Quick Analyze...',
                submenu: [
                    { label: "Summarize today's messages", click: () => this.onQuickAnalyze?.('messages_today') },
                    { label: 'Who am I? (full profile)', click: () => this.onQuickAnalyze?.('identity_profile') },
                    { label: 'Recent locations timeline', click: () => this.onQuickAnalyze?.('locations_recent') },
                    { type: 'separator' },
                    { label: 'Custom objective...', click: () => this.onQuickAnalyze?.('custom') },
                ],
            },
            { label: 'Extract from Backup...', click: () => this.onExtractFromBackup?.() },
            { label: 'Browse My Data', click: () => this.onShowFullUI?.() },
            { label: 'Export...', click: () => this.onExport?.() },
            { type: 'separator' },
            { label: 'Settings', click: () => this.onShowSettings?.() },
            { label: 'Quit OpenExtract', click: () => this.onQuit?.() },
        ];
        const contextMenu = Menu.buildFromTemplate(template);
        this.tray.setContextMenu(contextMenu);
    }
    setIconState(state) {
        this.iconState = state;
        // TODO: swap tray icon image per state (green/blue/idle/yellow)
        // For now just update the tooltip
        const stateLabels = {
            idle: 'Idle',
            connected: 'Device Connected',
            syncing: 'Syncing...',
            attention: 'Attention Needed',
        };
        this.tray?.setToolTip(`OpenExtract — ${stateLabels[state]}`);
    }
    setTooltip(text) {
        this.tooltipText = text;
        this.tray?.setToolTip(text);
    }
    /**
     * Show a native Windows notification balloon / toast.
     */
    showBalloon(title, content) {
        this.tray?.displayBalloon({
            iconType: 'info',
            title,
            content,
            respectQuietTime: true,
        });
    }
    showStatusWindow() {
        if (this.statusWindow && !this.statusWindow.isDestroyed()) {
            this.statusWindow.focus();
            return;
        }
        this.statusWindow = new BrowserWindow({
            width: 400,
            height: 500,
            resizable: false,
            frame: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            show: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        // Position near the tray icon (bottom-right on Windows)
        const { screen } = require('electron');
        const display = screen.getPrimaryDisplay();
        const { width, height } = display.workAreaSize;
        this.statusWindow.setPosition(width - 420, height - 520);
        // Load the main app in the status popup
        const isDev = !require('electron').app.isPackaged;
        if (isDev) {
            this.statusWindow.loadURL('http://127.0.0.1:5179');
        }
        else {
            this.statusWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
        }
        this.statusWindow.once('ready-to-show', () => {
            this.statusWindow.show();
        });
        this.statusWindow.on('blur', () => {
            // Auto-hide status window when it loses focus
            if (this.statusWindow && !this.statusWindow.isDestroyed()) {
                this.statusWindow.hide();
            }
        });
    }
    getStatusWindow() {
        return this.statusWindow;
    }
    destroy() {
        if (this.statusWindow && !this.statusWindow.isDestroyed()) {
            this.statusWindow.destroy();
        }
        this.tray?.destroy();
        this.tray = null;
    }
}
exports.TrayManager = TrayManager;
