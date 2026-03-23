"use strict";
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('openextract', {
    // Call Python sidecar methods
    call: (method, params) => ipcRenderer.invoke('sidecar:call', method, params || {}),
    // Native dialogs
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
    saveFolder: () => ipcRenderer.invoke('dialog:saveFolder'),
    // Open URL in system browser
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    // Subscribe to JSON-RPC notifications pushed by the Python sidecar.
    // Used to receive backup.progress events during a live backup.
    onNotification: (callback) => {
        const listener = (_event, notification) => callback(notification);
        ipcRenderer.on('sidecar:notification', listener);
        // Return a cleanup function so the caller can unsubscribe.
        return () => ipcRenderer.removeListener('sidecar:notification', listener);
    },
});
