const { contextBridge, ipcRenderer } = require('electron');

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('droidControl', {
  bridgeInfo: () => ipcRenderer.invoke('bridge-info'),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', { key }),
  clearApiKey: () => ipcRenderer.invoke('clear-api-key'),
  listFiles: (dir) => ipcRenderer.invoke('list-files', { dir }),
  readFile: (path) => ipcRenderer.invoke('read-file', { path }),
  repoStatus: (dir) => ipcRenderer.invoke('repo-status', { dir }),
  openProject: (dir, editor, target) => ipcRenderer.invoke('open-project', { dir, editor, target }),

  nativeBrowserOpen: (sessionId, url, bounds, viewport) => ipcRenderer.invoke('native-browser-open', { sessionId, url, bounds, viewport }),
  nativeBrowserAttach: (sessionId, bounds, url) => ipcRenderer.invoke('native-browser-attach', { sessionId, bounds, url }),
  nativeBrowserDetach: (sessionId) => ipcRenderer.invoke('native-browser-detach', { sessionId }),
  nativeBrowserSetBounds: (sessionId, bounds) => ipcRenderer.invoke('native-browser-set-bounds', { sessionId, bounds }),
  nativeBrowserClose: (sessionId) => ipcRenderer.invoke('native-browser-close', { sessionId }),
  nativeBrowserReload: (sessionId) => ipcRenderer.invoke('native-browser-reload', { sessionId }),
  nativeBrowserSetDesignMode: (sessionId, active) => ipcRenderer.invoke('native-browser-set-design-mode', { sessionId, active }),
  nativeBrowserSetSketchMode: (sessionId, active) => ipcRenderer.invoke('native-browser-set-sketch-mode', { sessionId, active }),
  nativeBrowserAgentAction: (request) => ipcRenderer.invoke('native-browser-agent-action', { request }),

  onNativeBrowserSelection: (handler) => on('native-browser-selection', handler),
  onNativeBrowserDesignPrompt: (handler) => on('native-browser-design-prompt', handler),
  onNativeBrowserLoaded: (handler) => on('native-browser-loaded', handler),
  onNativeBrowserAgentResult: (handler) => on('native-browser-agent-result', handler),
});
