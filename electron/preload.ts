const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openextract', {
  // Call Python sidecar methods
  call: (method: string, params?: any) =>
    ipcRenderer.invoke('sidecar:call', method, params || {}),

  // Native dialogs
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  saveFolder: () => ipcRenderer.invoke('dialog:saveFolder'),
  saveFile: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('dialog:saveFile', options),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('fs:writeFile', filePath, content),

  // Open URL in system browser
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Open a local file in the system default app (e.g. video player)
  openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),

  // Subscribe to JSON-RPC notifications pushed by the Python sidecar.
  onNotification: (callback: (notification: any) => void) => {
    const listener = (_event: any, notification: any) => callback(notification);
    ipcRenderer.on('sidecar:notification', listener);
    return () => ipcRenderer.removeListener('sidecar:notification', listener);
  },

  // App state persistence
  getAppState: () => ipcRenderer.invoke('get-app-state'),
  setFirstLaunchCompleted: () => ipcRenderer.invoke('set-first-launch-completed'),
  addSession: (session: any) => ipcRenderer.invoke('add-session', session),
  removeSession: (id: string) => ipcRenderer.invoke('remove-session', id),
  getRecentSessions: () => ipcRenderer.invoke('get-recent-sessions'),
  incrementExportCount: () => ipcRenderer.invoke('increment-export-count'),
});
