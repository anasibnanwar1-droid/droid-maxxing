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

  nativeBrowserOpen: (url, bounds) => ipcRenderer.invoke('native-browser-open', { url, bounds }),
  nativeBrowserSetBounds: (bounds) => ipcRenderer.invoke('native-browser-set-bounds', { bounds }),
  nativeBrowserClose: () => ipcRenderer.invoke('native-browser-close'),
  nativeBrowserReload: () => ipcRenderer.invoke('native-browser-reload'),
  nativeBrowserSetDesignMode: (active) => ipcRenderer.invoke('native-browser-set-design-mode', { active }),
  nativeBrowserSetSketchMode: (active) => ipcRenderer.invoke('native-browser-set-sketch-mode', { active }),
  nativeBrowserAgentAction: (request) => ipcRenderer.invoke('native-browser-agent-action', { request }),

  onNativeBrowserSelection: (handler) => on('native-browser-selection', handler),
  onNativeBrowserDesignPrompt: (handler) => on('native-browser-design-prompt', handler),
  onNativeBrowserLoaded: (handler) => on('native-browser-loaded', handler),
  onNativeBrowserAgentResult: (handler) => on('native-browser-agent-result', handler),
});
