"use strict";
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('openextract', {
    // Call Python sidecar methods
    call: (method, params) => ipcRenderer.invoke('sidecar:call', method, params || {}),
    // Save an engine export as PDF (printed by the main process from the engine's print-ready page)
    exportPdf: (method, params) => ipcRenderer.invoke('export:pdf', method, params),
    // Print a page the window built (the Timeline) to <outputDir>/<baseName>.pdf, never overwriting
    exportHtmlPdf: (html, outputDir, baseName) => ipcRenderer.invoke('export:pdf-html', html, outputDir, baseName),
    // Native dialogs
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
    saveFolder: () => ipcRenderer.invoke('dialog:saveFolder'),
    // "OneDrive", "iCloud Drive", … when a chosen folder is in one, else null
    syncedFolder: (folder) => ipcRenderer.invoke('folder:syncedService', folder),
    saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
    writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
    // Save text as <folder>/<baseName>.<extension>, never overwriting; resolves to the path written
    writeNewFile: (folder, baseName, extension, content) => ipcRenderer.invoke('fs:writeNewFile', folder, baseName, extension, content),
    // Open URL in system browser
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    // Quit and reopen the app (e.g. after granting macOS Full Disk Access)
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    // Open a local file in the system default app (e.g. video player)
    openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
    // Reveal a saved file or folder in Finder / Explorer
    showInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
    // Ask to move an older backup to the Trash; the main process checks, asks and does it
    trashOlderBackup: (udid, backupDir) => ipcRenderer.invoke('backup:trashOlder', udid, backupDir),
    // Ask to move any backup on the home screen's list to the Trash; the main process checks, asks and does it
    trashBackup: (backupDir) => ipcRenderer.invoke('backup:trash', backupDir),
    // A video's poster frame from a copy the engine made: a data: URL, or null (Linux, or it can't be drawn)
    mediaThumbnail: (filePath, size) => ipcRenderer.invoke('media:thumbnail', filePath, size),
    // 'darwin', 'win32' or 'linux', for platform-specific window chrome
    platform: process.platform,
    // Text size (Settings): scales the whole window, like the View menu's zoom
    textSize: {
        get: () => ipcRenderer.invoke('text-size:get'),
        set: (size) => ipcRenderer.invoke('text-size:set', size),
    },
    // Subscribe to JSON-RPC notifications pushed by the Python sidecar.
    onNotification: (callback) => {
        const listener = (_event, notification) => callback(notification);
        ipcRenderer.on('sidecar:notification', listener);
        return () => ipcRenderer.removeListener('sidecar:notification', listener);
    },
    // App version (the packaged one, not a hard-coded string)
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    // Auto-update. Nothing is checked until the user allows it (setAutoCheck) or clicks Check.
    updates: {
        getState: () => ipcRenderer.invoke('updates:get-state'),
        setAutoCheck: (enabled) => ipcRenderer.invoke('updates:set-auto-check', enabled),
        askLater: () => ipcRenderer.invoke('updates:ask-later'),
        check: () => ipcRenderer.invoke('updates:check'),
        download: () => ipcRenderer.invoke('updates:download'),
        install: () => ipcRenderer.invoke('updates:install'),
        onStatus: (callback) => {
            const listener = (_event, status) => callback(status);
            ipcRenderer.on('updates:status', listener);
            return () => ipcRenderer.removeListener('updates:status', listener);
        },
    },
    // App state persistence
    getAppState: () => ipcRenderer.invoke('get-app-state'),
    setFirstLaunchCompleted: () => ipcRenderer.invoke('set-first-launch-completed'),
    addSession: (session) => ipcRenderer.invoke('add-session', session),
    removeSession: (id) => ipcRenderer.invoke('remove-session', id),
    getRecentSessions: () => ipcRenderer.invoke('get-recent-sessions'),
    // `area` (e.g. 'calls') only labels the follow-up "did it come out right?" card.
    incrementExportCount: (area) => ipcRenderer.invoke('increment-export-count', area),
    // "Pay it forward" card after an export (`intro` the first time). The main process decides when.
    onSharePrompt: (callback) => {
        const listener = (_event, area, intro) => callback(area, intro);
        ipcRenderer.on('share-prompt:show', listener);
        return () => ipcRenderer.removeListener('share-prompt:show', listener);
    },
    // The "Pay it forward" ask. Remembered on this computer only; the app never sees payments.
    support: {
        status: () => ipcRenderer.invoke('support:status'),
        snooze: () => ipcRenderer.invoke('support:snooze'),
        markPaid: () => ipcRenderer.invoke('support:paid'),
        // "Using it for paid work?": 'work' or 'personal'.
        answerBusiness: (answer) => ipcRenderer.invoke('support:business-answer', answer),
    },
    // "Using it for paid work?" after a save from many different iPhones (`devices` in the past year). Once.
    onBusinessCard: (callback) => {
        const listener = (_event, devices) => callback(devices);
        ipcRenderer.on('business-card:show', listener);
        return () => ipcRenderer.removeListener('business-card:show', listener);
    },
    // In-app feedback. A report is sent only when the user clicks Send in the form.
    feedback: {
        getDiagnostics: (reportedError) => ipcRenderer.invoke('feedback:get-diagnostics', reportedError),
        send: (input) => ipcRenderer.invoke('feedback:send', input),
        savedEmail: () => ipcRenderer.invoke('feedback:saved-email'),
        fixedReports: () => ipcRenderer.invoke('feedback:fixed-reports'),
        markAnnounced: (reference) => ipcRenderer.invoke('feedback:mark-announced', reference),
        onFixed: (callback) => {
            const listener = () => callback();
            ipcRenderer.on('feedback:fixed', listener);
            return () => ipcRenderer.removeListener('feedback:fixed', listener);
        },
        optOutOfExportCheck: () => ipcRenderer.invoke('feedback:export-check-opt-out'),
        onExportCheck: (callback) => {
            const listener = (_event, area, offerAsk) => callback(area, offerAsk);
            ipcRenderer.on('export-check:show', listener);
            return () => ipcRenderer.removeListener('export-check:show', listener);
        },
    },
    // Clipboard (used by the share prompt's Copy link and the feedback form)
    copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
    // Ask AI (electron/askAi.ts). Only builds made with OPENEXTRACT_AI_INDEX_URL have it; in every
    // other build state() is { enabled: false } and the rest answer that it's off, doing nothing.
    askAi: {
        state: () => ipcRenderer.invoke('ask-ai:state'),
        status: () => ipcRenderer.invoke('ask-ai:status'),
        install: () => ipcRenderer.invoke('ask-ai:install'),
        connectClaude: () => ipcRenderer.invoke('ask-ai:connect-claude'),
        // `consent`: the person said OK to one entry being added to ChatGPT's settings file.
        connectChatGpt: (consent) => ipcRenderer.invoke('ask-ai:connect-chatgpt', consent),
        setHidden: (hidden) => ipcRenderer.invoke('ask-ai:set-hidden', hidden),
        noteSeen: () => ipcRenderer.invoke('ask-ai:note-seen'),
        // "Open Settings" on the Full Disk Access step (macOS): main opens its one fixed address.
        openFullDiskAccess: () => ipcRenderer.invoke('ask-ai:open-full-disk-access'),
        onProgress: (callback) => {
            const listener = (_event, progress) => callback(progress);
            ipcRenderer.on('ask-ai:progress', listener);
            return () => ipcRenderer.removeListener('ask-ai:progress', listener);
        },
    },
});
