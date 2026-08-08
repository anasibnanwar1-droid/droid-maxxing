const { contextBridge, ipcRenderer } = require('electron');

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('droidControl', {
  bridgeInfo: () => ipcRenderer.invoke('bridge-info'),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  saveImage: (dataUrl) => ipcRenderer.invoke('save-image', { dataUrl }),
  discardImage: (path) => ipcRenderer.invoke('discard-image', { path }),
  notify: (title, body, options) =>
    ipcRenderer.invoke('notify', {
      title,
      body,
      silent: options?.silent === true,
      appSessionId: typeof options?.appSessionId === 'string' ? options.appSessionId : undefined,
    }),
  onNotificationActivate: (handler) => on('notification-activate', handler),
  takePendingNotificationSession: () => ipcRenderer.invoke('notification-take-pending'),
  ackNotificationActivate: (appSessionId) =>
    ipcRenderer.invoke('notification-activate-ack', { appSessionId }),
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
  gitMarkTurnStart: (dir, ownerId) => ipcRenderer.invoke('git-mark-turn-start', { dir, ownerId }),
  gitAdoptTurnBaseline: (dir, clientRef, appSessionId) =>
    ipcRenderer.invoke('git-adopt-turn-baseline', { dir, clientRef, appSessionId }),
  gitCreateBranch: (dir, options) => ipcRenderer.invoke('git-create-branch', { dir, options }),
  gitCheckout: (dir, options) => ipcRenderer.invoke('git-checkout', { dir, options }),
  gitCreateWorktree: (dir, options) => ipcRenderer.invoke('git-create-worktree', { dir, options }),
  gitRemoveWorktree: (dir, options) => ipcRenderer.invoke('git-remove-worktree', { dir, options }),
  gitCommit: (dir, options) => ipcRenderer.invoke('git-commit', { dir, options }),
  gitPush: (dir, options) => ipcRenderer.invoke('git-push', { dir, options }),
  gitFetch: (dir) => ipcRenderer.invoke('git-fetch', { dir }),

  githubAvailable: () => ipcRenderer.invoke('github-available'),
  githubInstall: () => ipcRenderer.invoke('github-install'),
  githubAuthenticate: () => ipcRenderer.invoke('github-authenticate'),
  githubDetectPr: (dir, options) => ipcRenderer.invoke('github-detect-pr', { dir, options }),
  githubPrChecks: (dir, options) => ipcRenderer.invoke('github-pr-checks', { dir, options }),
  githubPrComments: (dir, options) => ipcRenderer.invoke('github-pr-comments', { dir, options }),
  githubCreatePr: (dir, options) => ipcRenderer.invoke('github-create-pr', { dir, options }),
  githubPostComment: (dir, options) => ipcRenderer.invoke('github-post-comment', { dir, options }),

  getOnboarding: () => ipcRenderer.invoke('onboarding-get'),
  setOnboarding: (patch) => ipcRenderer.invoke('onboarding-set', { patch }),
  appVersion: () => ipcRenderer.invoke('app-version'),
  checkAppUpdate: (options) => ipcRenderer.invoke('app-check-update', options),
  downloadAppUpdate: () => ipcRenderer.invoke('app-download-update'),
  submitFeedbackReport: (report) => ipcRenderer.invoke('feedback-report', report),
  getAutomaticDiagnostics: () => ipcRenderer.invoke('diagnostics-preference-get'),
  setAutomaticDiagnostics: (enabled) =>
    ipcRenderer.invoke('diagnostics-preference-set', { enabled }),
  relaunchApp: () => ipcRenderer.invoke('app-relaunch'),
  setAppIcon: (mode) => ipcRenderer.invoke('app-set-icon', { mode }),
  openExternal: (url) => ipcRenderer.invoke('open-external', { url }),

  terminalCreate: (options) => ipcRenderer.invoke('terminal-create', options),
  terminalWrite: (id, data) => ipcRenderer.invoke('terminal-write', { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke('terminal-resize', { id, cols, rows }),
  terminalKill: (id) => ipcRenderer.invoke('terminal-kill', { id }),
  terminalList: (appSessionId) => ipcRenderer.invoke('terminal-list', { appSessionId }),
  terminalSubscribe: (id) => ipcRenderer.invoke('terminal-subscribe', { id }),
  terminalUnsubscribe: (id) => ipcRenderer.invoke('terminal-unsubscribe', { id }),
  onTerminalEvent: (handler) => on('terminal-event', handler),
  filesAuthorizeRoot: (root) => ipcRenderer.invoke('files-authorize-root', { root }),
  filesList: (accessToken, relative) => ipcRenderer.invoke('files-list', { accessToken, relative }),
  filesPreview: (accessToken, relative) =>
    ipcRenderer.invoke('files-preview', { accessToken, relative }),
  filesOpen: (accessToken, relative) => ipcRenderer.invoke('files-open', { accessToken, relative }),
  filesReveal: (accessToken, relative) =>
    ipcRenderer.invoke('files-reveal', { accessToken, relative }),

  nativeBrowserOpen: (browserSessionId, url, bounds, viewport) =>
    ipcRenderer.invoke('native-browser-open', { browserSessionId, url, bounds, viewport }),
  nativeBrowserAttach: (browserSessionId, bounds, url) =>
    ipcRenderer.invoke('native-browser-attach', { browserSessionId, bounds, url }),
  nativeBrowserDetach: (browserSessionId) =>
    ipcRenderer.invoke('native-browser-detach', { browserSessionId }),
  nativeBrowserSetBounds: (browserSessionId, bounds) =>
    ipcRenderer.invoke('native-browser-set-bounds', { browserSessionId, bounds }),
  nativeBrowserSetVisible: (browserSessionId, visible) =>
    ipcRenderer.invoke('native-browser-visible', { browserSessionId, visible }),
  nativeBrowserClose: (browserSessionId) =>
    ipcRenderer.invoke('native-browser-close', { browserSessionId }),
  nativeBrowserReload: (browserSessionId) =>
    ipcRenderer.invoke('native-browser-reload', { browserSessionId }),
  nativeBrowserGoBack: (browserSessionId) =>
    ipcRenderer.invoke('native-browser-go-back', { browserSessionId }),
  nativeBrowserGoForward: (browserSessionId) =>
    ipcRenderer.invoke('native-browser-go-forward', { browserSessionId }),
  nativeBrowserSetDesignMode: (browserSessionId, active) =>
    ipcRenderer.invoke('native-browser-set-design-mode', { browserSessionId, active }),
  nativeBrowserSetPencilMode: (browserSessionId, active) =>
    ipcRenderer.invoke('native-browser-set-pencil-mode', { browserSessionId, active }),
  nativeBrowserAgentAction: (request) =>
    ipcRenderer.invoke('native-browser-agent-action', { request }),
  nativeBrowserCapture: (browserSessionId, box, options) =>
    ipcRenderer.invoke('native-browser-capture', { browserSessionId, box, options }),

  onNativeBrowserSelection: (handler) => on('native-browser-selection', handler),
  onNativeBrowserDesignPrompt: (handler) => on('native-browser-design-prompt', handler),
  onNativeBrowserLoaded: (handler) => on('native-browser-loaded', handler),
  onNativeBrowserLoadFailed: (handler) => on('native-browser-load-failed', handler),
  onNativeBrowserAgentResult: (handler) => on('native-browser-agent-result', handler),
});
