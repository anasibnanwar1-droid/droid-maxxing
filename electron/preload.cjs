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
  listEditors: () => ipcRenderer.invoke('list-editors'),
  openProject: (dir, editor, target) => ipcRenderer.invoke('open-project', { dir, editor, target }),

  gitEnvironment: (dir) => ipcRenderer.invoke('git-environment', { dir }),
  gitBranches: (dir) => ipcRenderer.invoke('git-branches', { dir }),
  gitWorktrees: (dir) => ipcRenderer.invoke('git-worktrees', { dir }),
  gitDiffStat: (dir, options) => ipcRenderer.invoke('git-diff-stat', { dir, options }),
  gitDiffFiles: (dir, options) => ipcRenderer.invoke('git-diff-files', { dir, options }),
  gitFileDiff: (dir, options) => ipcRenderer.invoke('git-file-diff', { dir, options }),
  gitMarkTurnStart: (dir, sessionId) =>
    ipcRenderer.invoke('git-mark-turn-start', { dir, sessionId }),
  gitCreateBranch: (dir, options) => ipcRenderer.invoke('git-create-branch', { dir, options }),
  gitCheckout: (dir, options) => ipcRenderer.invoke('git-checkout', { dir, options }),
  gitCreateWorktree: (dir, options) => ipcRenderer.invoke('git-create-worktree', { dir, options }),
  gitRemoveWorktree: (dir, options) => ipcRenderer.invoke('git-remove-worktree', { dir, options }),
  gitCommit: (dir, options) => ipcRenderer.invoke('git-commit', { dir, options }),
  gitPush: (dir, options) => ipcRenderer.invoke('git-push', { dir, options }),
  gitFetch: (dir) => ipcRenderer.invoke('git-fetch', { dir }),

  githubAvailable: () => ipcRenderer.invoke('github-available'),
  githubDetectPr: (dir, options) => ipcRenderer.invoke('github-detect-pr', { dir, options }),
  githubPrChecks: (dir, options) => ipcRenderer.invoke('github-pr-checks', { dir, options }),
  githubPrComments: (dir, options) => ipcRenderer.invoke('github-pr-comments', { dir, options }),
  githubCreatePr: (dir, options) => ipcRenderer.invoke('github-create-pr', { dir, options }),
  githubPostComment: (dir, options) => ipcRenderer.invoke('github-post-comment', { dir, options }),

  getOnboarding: () => ipcRenderer.invoke('onboarding-get'),
  setOnboarding: (patch) => ipcRenderer.invoke('onboarding-set', { patch }),
  appVersion: () => ipcRenderer.invoke('app-version'),
  checkAppUpdate: () => ipcRenderer.invoke('app-check-update'),
  downloadAppUpdate: (dmgUrl) => ipcRenderer.invoke('app-download-update', dmgUrl),
  relaunchApp: () => ipcRenderer.invoke('app-relaunch'),
  openExternal: (url) => ipcRenderer.invoke('open-external', { url }),

  terminalCreate: (options) => ipcRenderer.invoke('terminal-create', options),
  terminalWrite: (id, data) => ipcRenderer.invoke('terminal-write', { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke('terminal-resize', { id, cols, rows }),
  terminalKill: (id) => ipcRenderer.invoke('terminal-kill', { id }),
  terminalList: (missionId) => ipcRenderer.invoke('terminal-list', { missionId }),
  terminalSubscribe: (id) => ipcRenderer.invoke('terminal-subscribe', { id }),
  terminalUnsubscribe: (id) => ipcRenderer.invoke('terminal-unsubscribe', { id }),
  onTerminalEvent: (handler) => on('terminal-event', handler),
  filesList: (root, relative) => ipcRenderer.invoke('files-list', { root, relative }),
  filesPreview: (root, relative) => ipcRenderer.invoke('files-preview', { root, relative }),
  filesOpen: (root, relative) => ipcRenderer.invoke('files-open', { root, relative }),
  filesReveal: (root, relative) => ipcRenderer.invoke('files-reveal', { root, relative }),

  nativeBrowserOpen: (sessionId, url, bounds, viewport) =>
    ipcRenderer.invoke('native-browser-open', { sessionId, url, bounds, viewport }),
  nativeBrowserAttach: (sessionId, bounds, url) =>
    ipcRenderer.invoke('native-browser-attach', { sessionId, bounds, url }),
  nativeBrowserDetach: (sessionId) => ipcRenderer.invoke('native-browser-detach', { sessionId }),
  nativeBrowserSetBounds: (sessionId, bounds) =>
    ipcRenderer.invoke('native-browser-set-bounds', { sessionId, bounds }),
  nativeBrowserSetVisible: (sessionId, visible) =>
    ipcRenderer.invoke('native-browser-visible', { sessionId, visible }),
  nativeBrowserClose: (sessionId) => ipcRenderer.invoke('native-browser-close', { sessionId }),
  nativeBrowserReload: (sessionId) => ipcRenderer.invoke('native-browser-reload', { sessionId }),
  nativeBrowserGoBack: (sessionId) => ipcRenderer.invoke('native-browser-go-back', { sessionId }),
  nativeBrowserGoForward: (sessionId) =>
    ipcRenderer.invoke('native-browser-go-forward', { sessionId }),
  nativeBrowserSetDesignMode: (sessionId, active) =>
    ipcRenderer.invoke('native-browser-set-design-mode', { sessionId, active }),
  nativeBrowserSetPencilMode: (sessionId, active) =>
    ipcRenderer.invoke('native-browser-set-pencil-mode', { sessionId, active }),
  nativeBrowserAgentAction: (request) =>
    ipcRenderer.invoke('native-browser-agent-action', { request }),
  nativeBrowserCapture: (sessionId, box, options) =>
    ipcRenderer.invoke('native-browser-capture', { sessionId, box, options }),

  onNativeBrowserSelection: (handler) => on('native-browser-selection', handler),
  onNativeBrowserDesignPrompt: (handler) => on('native-browser-design-prompt', handler),
  onNativeBrowserLoaded: (handler) => on('native-browser-loaded', handler),
  onNativeBrowserLoadFailed: (handler) => on('native-browser-load-failed', handler),
  onNativeBrowserAgentResult: (handler) => on('native-browser-agent-result', handler),
});
