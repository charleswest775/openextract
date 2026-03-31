"use strict";
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('openextract', {
    // Call Python sidecar methods
    call: (method, params) => ipcRenderer.invoke('sidecar:call', method, params || {}),
    // Native dialogs
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
    saveFolder: () => ipcRenderer.invoke('dialog:saveFolder'),
    saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
    writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
    // Open URL in system browser
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    // Open a local file in the system default app (e.g. video player)
    openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
    // Subscribe to JSON-RPC notifications pushed by the Python sidecar.
    onNotification: (callback) => {
        const listener = (_event, notification) => callback(notification);
        ipcRenderer.on('sidecar:notification', listener);
        return () => ipcRenderer.removeListener('sidecar:notification', listener);
    },
    // App state persistence
    getAppState: () => ipcRenderer.invoke('get-app-state'),
    setFirstLaunchCompleted: () => ipcRenderer.invoke('set-first-launch-completed'),
    addSession: (session) => ipcRenderer.invoke('add-session', session),
    removeSession: (id) => ipcRenderer.invoke('remove-session', id),
    getRecentSessions: () => ipcRenderer.invoke('get-recent-sessions'),
    incrementExportCount: () => ipcRenderer.invoke('increment-export-count'),
});
