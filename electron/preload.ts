const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openextract', {
  // Call Python sidecar methods
  call: (method: string, params?: any) =>
    ipcRenderer.invoke('sidecar:call', method, params || {}),

  // Export conversations as PDF (rendered by the main process)
  exportPdf: (method: 'export_conversation' | 'export_conversations', params: any) =>
    ipcRenderer.invoke('export:pdf', method, params),

  // Native dialogs
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  saveFolder: () => ipcRenderer.invoke('dialog:saveFolder'),
  saveFile: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('dialog:saveFile', options),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('fs:writeFile', filePath, content),

  // Open URL in system browser
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Quit and reopen the app (e.g. after granting macOS Full Disk Access)
  relaunch: () => ipcRenderer.invoke('app:relaunch'),

  // Open a local file in the system default app (e.g. video player)
  openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),

  // Reveal a saved file or folder in Finder / Explorer
  showInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),

  // 'darwin', 'win32' or 'linux', for platform-specific window chrome
  platform: process.platform,

  // Text size (Settings): scales the whole window, like the View menu's zoom
  textSize: {
    get: () => ipcRenderer.invoke('text-size:get'),
    set: (size: 'default' | 'large' | 'larger') => ipcRenderer.invoke('text-size:set', size),
  },

  // Subscribe to JSON-RPC notifications pushed by the Python sidecar.
  onNotification: (callback: (notification: any) => void) => {
    const listener = (_event: any, notification: any) => callback(notification);
    ipcRenderer.on('sidecar:notification', listener);
    return () => ipcRenderer.removeListener('sidecar:notification', listener);
  },

  // App version (the packaged one, not a hard-coded string)
  getVersion: () => ipcRenderer.invoke('app:get-version'),

  // Auto-update. Nothing is checked until the user allows it (setAutoCheck) or clicks Check.
  updates: {
    getState: () => ipcRenderer.invoke('updates:get-state'),
    setAutoCheck: (enabled: boolean) => ipcRenderer.invoke('updates:set-auto-check', enabled),
    askLater: () => ipcRenderer.invoke('updates:ask-later'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onStatus: (callback: (status: any) => void) => {
      const listener = (_event: any, status: any) => callback(status);
      ipcRenderer.on('updates:status', listener);
      return () => ipcRenderer.removeListener('updates:status', listener);
    },
  },

  // App state persistence
  getAppState: () => ipcRenderer.invoke('get-app-state'),
  setFirstLaunchCompleted: () => ipcRenderer.invoke('set-first-launch-completed'),
  addSession: (session: any) => ipcRenderer.invoke('add-session', session),
  removeSession: (id: string) => ipcRenderer.invoke('remove-session', id),
  getRecentSessions: () => ipcRenderer.invoke('get-recent-sessions'),
  // `area` (e.g. 'calls') only labels the follow-up "did it come out right?" card.
  incrementExportCount: (area?: string) => ipcRenderer.invoke('increment-export-count', area),

  // One-time "say thanks or tell a friend" prompt after the first successful export.
  onSharePrompt: (callback: (area?: string) => void) => {
    const listener = (_event: any, area?: string) => callback(area);
    ipcRenderer.on('share-prompt:show', listener);
    return () => ipcRenderer.removeListener('share-prompt:show', listener);
  },

  // In-app feedback. A report is sent only when the user clicks Send in the form.
  feedback: {
    getDiagnostics: (reportedError?: string) => ipcRenderer.invoke('feedback:get-diagnostics', reportedError),
    send: (input: any) => ipcRenderer.invoke('feedback:send', input),
    savedEmail: () => ipcRenderer.invoke('feedback:saved-email'),
    fixedReports: () => ipcRenderer.invoke('feedback:fixed-reports'),
    markAnnounced: (reference: string) => ipcRenderer.invoke('feedback:mark-announced', reference),
    onFixed: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('feedback:fixed', listener);
      return () => ipcRenderer.removeListener('feedback:fixed', listener);
    },
    optOutOfExportCheck: () => ipcRenderer.invoke('feedback:export-check-opt-out'),
    thanksOffered: () => ipcRenderer.invoke('feedback:thanks-offered'),
    onExportCheck: (callback: (area?: string, offerThanks?: boolean) => void) => {
      const listener = (_event: any, area?: string, offerThanks?: boolean) => callback(area, offerThanks);
      ipcRenderer.on('export-check:show', listener);
      return () => ipcRenderer.removeListener('export-check:show', listener);
    },
  },

  // Clipboard (used by the share prompt's Copy link and the feedback form)
  copyText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
});
