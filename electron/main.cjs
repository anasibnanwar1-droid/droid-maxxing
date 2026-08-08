const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  WebContentsView,
  dialog,
  ipcMain,
  nativeTheme,
  safeStorage,
  session,
  shell,
} = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const gitVcs = require('./git.cjs');
const githubVcs = require('./github.cjs');
const { createTerminalManager, createTerminalSubscriptionRegistry } = require('./terminal.cjs');
const files = require('./files.cjs');
const attachments = require('./attachments.cjs');
const {
  normalizeBrowserConsoleMessage,
  redactBrowserDiagnosticUrl,
} = require('./browserDiagnostics.cjs');
const { runWithWebContentsDebugger } = require('./nativeBrowserEmulation.cjs');
const { attachChildView, detachChildView } = require('./nativeBrowserHost.cjs');
const { createSidecarSupervisor } = require('./sidecar.cjs');
const { installRendererNavigationGuard } = require('./rendererSecurity.cjs');
const { installApplicationMenu } = require('./applicationMenu.cjs');
const { autoUpdater } = require('electron-updater');
const { createAppUpdater } = require('./appUpdater.cjs');
const Sentry = require('@sentry/electron/main');
const { createDiagnostics } = require('./diagnostics.cjs');
const { showDesktopNotification } = require('./notifications.cjs');
const APP_NAME = 'DROIDEX';
const buildMetadata = readBuildMetadata();
const terminalManager = createTerminalManager();
const terminalSubscriptions = createTerminalSubscriptionRegistry(terminalManager);
const filesRootAccess = files.createRootAccessRegistry();
const diagnostics = createDiagnostics({
  app,
  sentry: Sentry,
  dsn: buildMetadata.sentryDsn,
  logError: (message, error) => console.error('[diagnostics] %s:', message, error),
});
const sidecarSupervisor = createSidecarSupervisor({
  entryPath: sidecarEntry,
  cwd: () => (app.isPackaged ? process.resourcesPath : appRoot()),
  userData: () => app.getPath('userData'),
  onUnexpectedExit: (error) => diagnostics.captureException(error, { process: 'sidecar' }),
});
const appUpdater = createAppUpdater({
  app,
  autoUpdater,
  installMode: buildMetadata.updateInstallMode,
  sparkleFeedUrl: buildMetadata.sparkleFeedUrl,
  sparkleUpdater: () => require('@droidex/sparkle-updater'),
  prepareToInstall: () => sidecarSupervisor.stop(),
  logError: (message, error) => console.error('[update] %s:', message, error),
});

let mainWindow = null;
let hiddenNativeBrowserWindow = null;
// Selected app-icon appearance. 'system' tracks the OS light/dark setting via
// nativeTheme; 'light'/'dark' pin a specific artwork.
let appIconMode = 'system';
// Session to open after a finish-notification click. macOS often focuses the
// app before (or without) delivering the Notification `click` payload cleanly,
// so we queue the target and re-deliver on focus until the renderer acks.
/** @type {{ appSessionId: string, expiresAt: number } | null } */
let pendingNotificationOpen = null;
const PENDING_NOTIFICATION_OPEN_MS = 30_000;
let attachedBrowserSessionId = null;
const nativeBrowsers = new Map();
// Keep hidden browser sessions warm by default so authenticated pages and
// compositor state survive while the Browser pane is closed.
const HIDDEN_BROWSER_IDLE_MS = Number(process.env.DROID_NATIVE_BROWSER_IDLE_MS ?? 0);
// A single persistent partition keeps cookies, localStorage, and registered
// passkeys alive across reloads, dev-server restarts, and app restarts so the
// user does not have to sign in again every time.
const BROWSER_PARTITION = 'persist:droidex-browser';
let browserSessionConfigured = false;

app.setName(APP_NAME);
// Overridable so a second dev instance (e.g. a feature worktree) can run beside
// the main one without fighting over the Chromium profile lock.
app.setPath(
  'userData',
  process.env.DROIDEX_USER_DATA_DIR || path.join(app.getPath('appData'), APP_NAME),
);
const diagnosticsInitialization = diagnostics.initialize();
app.whenReady().then(async () => {
  await diagnosticsInitialization;
  installApplicationMenu({
    Menu,
    app,
    appName: APP_NAME,
    appUpdater,
    reload: reloadShell,
    shell,
    logError: (message) => console.error('[menu] %s', message),
  });
  registerIpc();
  createMainWindow();
  // Pin the DROIDEX mark on the dock/taskbar up front so OS notifications
  // inherit it instead of the bare Electron atom in dev builds.
  applyAppIcon();
  // Repaint the icon when the OS appearance flips while 'system' is selected.
  nativeTheme.on('updated', () => {
    if (appIconMode === 'system') applyAppIcon();
  });
  void sidecarSupervisor.start().catch((error) => console.error(error));
});

app.on('window-all-closed', () => {
  sidecarSupervisor.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  sidecarSupervisor.stop();
  githubVcs.cancelSetup();
  terminalManager.closeAll();
  terminalSubscriptions.clear();
  filesRootAccess.clear();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
  else focusMainWindow();
  deliverPendingNotificationOpen();
});

app.on('child-process-gone', (_event, details) => {
  const error = new Error(
    `Electron child process exited: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
  );
  console.error(error.message);
  diagnostics.captureException(error, { process: details.type, reason: details.reason });
});

function createMainWindow() {
  const devStartUrl = app.isPackaged ? undefined : process.env.ELECTRON_START_URL;
  const rendererFile = path.join(appRoot(), 'dist/index.html');
  const rendererEntryUrl = devStartUrl || pathToFileURL(rendererFile).toString();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: APP_NAME,
    icon: path.join(__dirname, 'assets', process.platform === 'darwin' ? 'icon.icns' : 'icon.png'),
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#0a0a0a',
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: 'active',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  installRendererNavigationGuard(mainWindow.webContents, rendererEntryUrl, (url) =>
    shell.openExternal(url),
  );
  installMainRendererLifecycle(mainWindow.webContents);

  if (devStartUrl) mainWindow.loadURL(devStartUrl);
  else mainWindow.loadFile(rendererFile);

  // Re-deliver a queued notification open once the window is actually frontmost
  // and the renderer can receive IPC (critical when coming back from Safari).
  mainWindow.on('focus', () => {
    deliverPendingNotificationOpen();
  });
  mainWindow.on('show', () => {
    deliverPendingNotificationOpen();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    deliverPendingNotificationOpen();
  });

  mainWindow.on('closed', () => {
    closeAllNativeBrowsers();
    terminalManager.closeAll();
    terminalSubscriptions.clear();
    filesRootAccess.clear();
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('bridge-info', (event) => {
    assertMainRenderer(event);
    return sidecarSupervisor.getBridgeInfo();
  });
  ipcMain.handle('pick-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    const selected = result.canceled ? null : (result.filePaths[0] ?? null);
    if (selected) await filesRootAccess.authorize(selected);
    return selected;
  });
  ipcMain.handle('pick-files', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  });
  // Composer image pastes/drops land in a temp dir and travel to Droid as
  // ordinary @-mentioned paths; discard only ever unlinks inside that dir.
  const attachmentsDir = path.join(os.tmpdir(), 'droidex-attachments');
  ipcMain.handle('save-image', (_event, { dataUrl }) => attachments.save(attachmentsDir, dataUrl));
  ipcMain.handle('discard-image', (_event, { path: target }) =>
    attachments.discard(attachmentsDir, target),
  );
  // OS finish/status banners. silent=false plays the system notification sound.
  // Foreground suppress is owned by the renderer; click opens the finished
  // session via the pending-open queue.
  ipcMain.handle('notify', (event, payload = {}) => {
    assertMainRenderer(event);
    const title =
      typeof payload.title === 'string' && payload.title.trim()
        ? payload.title.trim().slice(0, 120)
        : 'DROIDEX';
    const body = typeof payload.body === 'string' ? payload.body.trim().slice(0, 280) : '';
    const silent = payload.silent === true;
    const appSessionId =
      typeof payload.appSessionId === 'string' && payload.appSessionId.trim()
        ? payload.appSessionId.trim().slice(0, 200)
        : null;
    // Dock icon is applied on launch / icon settings; reuse that path for the banner.
    const iconPath = path.join(__dirname, 'assets', resolveAppIconFile(appIconMode));
    return showDesktopNotification(Notification, {
      title,
      body,
      silent,
      ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
      // Queue first so focus/show handlers can re-send if this IPC is dropped.
      onActivate: () => queueNotificationSessionOpen(appSessionId),
    });
  });
  // Renderer acks after applying SET_ACTIVE_SESSION so we stop re-delivering.
  ipcMain.handle('notification-activate-ack', (event, payload = {}) => {
    assertMainRenderer(event);
    const appSessionId =
      typeof payload.appSessionId === 'string' ? payload.appSessionId.trim() : '';
    if (
      pendingNotificationOpen &&
      (!appSessionId || pendingNotificationOpen.appSessionId === appSessionId)
    ) {
      pendingNotificationOpen = null;
    }
    return { ok: true };
  });
  // Pull path: renderer asks on focus/visibility in case the push event was lost.
  ipcMain.handle('notification-take-pending', (event) => {
    assertMainRenderer(event);
    return takePendingNotificationOpen();
  });
  ipcMain.handle('get-api-key', getApiKey);
  ipcMain.handle('set-api-key', (_event, { key }) => setApiKey(key));
  ipcMain.handle('clear-api-key', clearApiKey);
  ipcMain.handle('list-files', (_event, { dir }) => listFiles(dir));
  ipcMain.handle('read-file', (_event, { path: filePath }) => readFile(filePath));
  ipcMain.handle('repo-status', (_event, { dir }) => repoStatus(dir));
  ipcMain.handle('list-editors', () => listEditors());
  ipcMain.handle('open-project', (_event, { dir, editor, target }) =>
    openProject(dir, editor, target),
  );

  ipcMain.handle('git-environment', (_event, { dir }) => gitVcs.environment(dir));
  ipcMain.handle('git-branches', (_event, { dir }) => gitVcs.branches(dir));
  ipcMain.handle('git-worktrees', (_event, { dir }) => gitVcs.worktrees(dir));
  ipcMain.handle('git-diff-stat', (_event, { dir, options }) => gitVcs.diffStat(dir, options));
  ipcMain.handle('git-diff-files', (_event, { dir, options }) => gitVcs.diffFiles(dir, options));
  ipcMain.handle('git-file-diff', (_event, { dir, options }) => gitVcs.fileDiff(dir, options));
  ipcMain.handle('git-mark-turn-start', (_event, { dir, ownerId }) =>
    gitVcs.markTurnStart(dir, ownerId),
  );
  ipcMain.handle('git-adopt-turn-baseline', (_event, { dir, clientRef, appSessionId }) =>
    gitVcs.adoptTurnBaseline(dir, clientRef, appSessionId),
  );
  ipcMain.handle('git-create-branch', (_event, { dir, options }) =>
    gitVcs.createBranch(dir, options),
  );
  ipcMain.handle('git-checkout', (_event, { dir, options }) => gitVcs.checkout(dir, options));
  ipcMain.handle('git-create-worktree', (_event, { dir, options }) =>
    gitVcs.createWorktree(dir, options),
  );
  ipcMain.handle('git-remove-worktree', (_event, { dir, options }) =>
    gitVcs.removeWorktree(dir, options),
  );
  ipcMain.handle('git-commit', (_event, { dir, options }) => gitVcs.commit(dir, options));
  ipcMain.handle('git-push', (_event, { dir, options }) => gitVcs.push(dir, options));
  ipcMain.handle('git-fetch', (_event, { dir }) => gitVcs.fetchRemotes(dir));

  ipcMain.handle('github-available', (event) => {
    assertMainRenderer(event);
    return githubVcs.available();
  });
  ipcMain.handle('github-install', (event) => {
    assertMainRenderer(event);
    return githubVcs.install();
  });
  ipcMain.handle('github-authenticate', (event) => {
    assertMainRenderer(event);
    return githubVcs.authenticate({
      onDeviceCode: (code) => {
        if (!event.sender.isDestroyed()) event.sender.send('github-auth-code', { code });
      },
    });
  });
  ipcMain.handle('github-cancel-setup', (event) => {
    assertMainRenderer(event);
    githubVcs.cancelSetup();
    return { ok: true };
  });
  ipcMain.handle('github-detect-pr', (_event, { dir, options }) =>
    githubVcs.detectPr(dir, options),
  );
  ipcMain.handle('github-pr-checks', (_event, { dir, options }) =>
    githubVcs.prChecks(dir, options),
  );
  ipcMain.handle('github-pr-comments', (_event, { dir, options }) =>
    githubVcs.prComments(dir, options),
  );
  ipcMain.handle('github-create-pr', (_event, { dir, options }) =>
    githubVcs.createPr(dir, options),
  );
  ipcMain.handle('github-post-comment', (_event, { dir, options }) =>
    githubVcs.postComment(dir, options),
  );

  ipcMain.handle('onboarding-get', getOnboarding);
  ipcMain.handle('onboarding-set', (_event, { patch }) => setOnboarding(patch));
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('app-check-update', (event, options) => {
    assertMainRenderer(event);
    return appUpdater.check(options);
  });
  ipcMain.handle('app-download-update', (event) => {
    assertMainRenderer(event);
    return appUpdater.downloadAndInstall();
  });
  ipcMain.handle('feedback-report', async (event, report) => {
    assertMainRenderer(event);
    let screenshotPng = null;
    if (report?.attachments?.screenshot && event.sender && !event.sender.isDestroyed()) {
      try {
        const image = await Promise.race([
          event.sender.capturePage(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('capture timeout')), 3_000)),
        ]);
        if (!image.isEmpty()) {
          const buffer = image.toPNG();
          if (buffer && buffer.length > 0 && buffer.length <= 500_000) {
            screenshotPng = buffer;
          }
        }
      } catch (error) {
        console.error('[feedback] screenshot capture skipped:', error?.message || error);
      }
    }
    return diagnostics.reportFeedback(report, { screenshotPng });
  });
  ipcMain.handle('diagnostics-preference-get', (event) => {
    assertMainRenderer(event);
    return diagnostics.automaticDiagnosticsPreference();
  });
  ipcMain.handle('diagnostics-preference-set', async (event, { enabled }) => {
    assertMainRenderer(event);
    return diagnostics.setAutomaticDiagnosticsEnabled(enabled);
  });
  ipcMain.handle('app-relaunch', () => relaunchApp());
  ipcMain.handle('app-set-icon', (event, payload) => {
    assertMainRenderer(event);
    return setAppIcon(payload?.mode);
  });
  ipcMain.handle('open-external', (_event, { url }) => openExternal(url));

  ipcMain.handle('terminal-create', (event, args) => {
    assertMainRenderer(event);
    return terminalManager.create({
      appSessionId: args?.appSessionId,
      cwd: args?.cwd,
      cols: args?.cols,
      rows: args?.rows,
    });
  });
  ipcMain.handle('terminal-write', (event, { id, data }) => {
    assertMainRenderer(event);
    terminalManager.write(id, data);
  });
  ipcMain.handle('terminal-resize', (event, { id, cols, rows }) => {
    assertMainRenderer(event);
    terminalManager.resize(id, cols, rows);
  });
  ipcMain.handle('terminal-kill', (event, { id }) => {
    assertMainRenderer(event);
    terminalSubscriptions.unsubscribe(event.sender, id);
    terminalManager.kill(id);
  });
  ipcMain.handle('terminal-list', (event, filter) => {
    assertMainRenderer(event);
    return terminalManager.list({ appSessionId: filter?.appSessionId });
  });
  ipcMain.handle('terminal-subscribe', (event, { id }) => {
    assertMainRenderer(event);
    terminalSubscriptions.subscribe(event.sender, id);
  });
  ipcMain.handle('terminal-unsubscribe', (event, { id }) => {
    assertMainRenderer(event);
    terminalSubscriptions.unsubscribe(event.sender, id);
  });
  ipcMain.handle('files-authorize-root', async (event, { root }) => {
    assertMainRenderer(event);
    const authorized = await filesRootAccess.tokenFor(root);
    if (authorized) return authorized;
    const expectedRoot = await files.canonicalDirectory(root);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Allow Files access to this workspace',
      buttonLabel: 'Allow Files Access',
      defaultPath: expectedRoot,
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    if (result.canceled || !result.filePaths[0]) {
      throw new Error('Files access was not authorized.');
    }
    const selectedRoot = await files.canonicalDirectory(result.filePaths[0]);
    if (selectedRoot !== expectedRoot) {
      throw new Error('Select the current workspace folder to authorize Files access.');
    }
    return filesRootAccess.authorize(selectedRoot);
  });
  ipcMain.handle('files-list', (event, { accessToken, relative }) => {
    assertMainRenderer(event);
    return files.listDirectory(filesRootAccess.resolve(accessToken), relative);
  });
  ipcMain.handle('files-preview', (event, { accessToken, relative }) => {
    assertMainRenderer(event);
    return files.readPreview(filesRootAccess.resolve(accessToken), relative);
  });
  ipcMain.handle('files-open', (event, { accessToken, relative }) => {
    assertMainRenderer(event);
    return files.openDefault(filesRootAccess.resolve(accessToken), relative, shell);
  });
  ipcMain.handle('files-reveal', (event, { accessToken, relative }) => {
    assertMainRenderer(event);
    return files.revealInFolder(filesRootAccess.resolve(accessToken), relative, shell);
  });

  ipcMain.handle('native-browser-open', (event, { browserSessionId, url, bounds, viewport }) => {
    assertMainRenderer(event);
    return openNativeBrowser(browserSessionId, url, bounds, viewport);
  });
  ipcMain.handle('native-browser-attach', (event, { browserSessionId, bounds, url }) => {
    assertMainRenderer(event);
    return attachNativeBrowser(browserSessionId, bounds, { restoreUrl: url });
  });
  ipcMain.handle('native-browser-detach', (event, { browserSessionId }) => {
    assertMainRenderer(event);
    return detachNativeBrowser(browserSessionId);
  });
  ipcMain.handle('native-browser-set-bounds', (event, { browserSessionId, bounds }) => {
    assertMainRenderer(event);
    return setNativeBrowserBounds(browserSessionId, bounds);
  });
  ipcMain.handle('native-browser-visible', (event, { browserSessionId, visible }) => {
    assertMainRenderer(event);
    return setNativeBrowserVisible(browserSessionId, visible);
  });
  ipcMain.handle('native-browser-close', (event, { browserSessionId }) => {
    assertMainRenderer(event);
    return closeNativeBrowser(browserSessionId);
  });
  ipcMain.handle('native-browser-reload', (event, { browserSessionId }) => {
    assertMainRenderer(event);
    return reloadNativeBrowser(browserSessionId);
  });
  ipcMain.handle('native-browser-go-back', (event, { browserSessionId }) => {
    assertMainRenderer(event);
    return navigateNativeBrowserHistory(browserSessionId, 'back');
  });
  ipcMain.handle('native-browser-go-forward', (event, { browserSessionId }) => {
    assertMainRenderer(event);
    return navigateNativeBrowserHistory(browserSessionId, 'forward');
  });
  ipcMain.handle('native-browser-set-design-mode', (event, { browserSessionId, active }) => {
    assertMainRenderer(event);
    return setNativeBrowserDesignMode(browserSessionId, active);
  });
  ipcMain.handle('native-browser-set-pencil-mode', (event, { browserSessionId, active }) => {
    assertMainRenderer(event);
    return setNativeBrowserPencilMode(browserSessionId, active);
  });
  ipcMain.handle('native-browser-agent-action', (event, { request }) => {
    assertMainRenderer(event);
    return runNativeBrowserAgentAction(request);
  });
  ipcMain.handle('native-browser-capture', (event, { browserSessionId, box, options }) => {
    assertMainRenderer(event);
    return captureNativeBrowser(browserSessionId, box, options);
  });

  ipcMain.on('native-browser-selection', (event, selection) => {
    mainWindow?.webContents.send(
      'native-browser-selection',
      withNativeBrowserSession(event, selection),
    );
  });
  ipcMain.on('native-browser-design-prompt', async (event, payload) => {
    const browserSessionId = nativeBrowserSessionIdForWebContents(event.sender);
    let selection = { ...payload.selection, browserSessionId };
    // Capture the annotated region (pencil strokes, highlights) while it is
    // still on screen so the agent receives the marked screenshot, not a
    // clean page that lost the user's annotations.
    const screenshot = await captureDesignSelection(event.sender, selection).catch(() => undefined);
    if (screenshot) selection = { ...selection, screenshot };
    mainWindow?.webContents.send('native-browser-design-prompt', { ...payload, selection });
    // Echo the capture id so the preload only clears the matching pending
    // capture and ignores acks from superseded prompts.
    event.sender.send('native-browser-design-prompt-sent', { captureId: payload.captureId });
  });
  ipcMain.on('native-browser-agent-result', (_event, result) => {
    mainWindow?.webContents.send('native-browser-agent-result', result);
  });
  ipcMain.on('native-browser-credential-capture', (event, payload) => {
    void handleCredentialCapture(event.sender, payload);
  });
}

function assertMainRenderer(event) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Desktop request rejected for unknown renderer.');
  }
}

function resolveAppIconFile(mode) {
  const useDark = mode === 'dark' || (mode === 'system' && nativeTheme.shouldUseDarkColors);
  return useDark ? 'icon-dark.png' : 'icon.png';
}

function applyAppIcon() {
  const iconPath = path.join(__dirname, 'assets', resolveAppIconFile(appIconMode));
  if (!fs.existsSync(iconPath)) return;
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(iconPath);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIcon(iconPath);
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin' && app.dock) app.dock.bounce('informational');
}

function queueNotificationSessionOpen(appSessionId) {
  if (!appSessionId) {
    focusMainWindow();
    return;
  }
  pendingNotificationOpen = {
    appSessionId,
    expiresAt: Date.now() + PENDING_NOTIFICATION_OPEN_MS,
  };
  focusMainWindow();
  // Immediate attempt; focus/show/did-finish-load will retry until ack.
  deliverPendingNotificationOpen();
}

function pendingNotificationPayload() {
  if (!pendingNotificationOpen) return null;
  if (Date.now() > pendingNotificationOpen.expiresAt) {
    pendingNotificationOpen = null;
    return null;
  }
  return { appSessionId: pendingNotificationOpen.appSessionId };
}

function deliverPendingNotificationOpen() {
  const payload = pendingNotificationPayload();
  if (!payload || !isWindowUsable(mainWindow)) return;
  mainWindow.webContents.send('notification-activate', payload);
}

/** Return and clear the pending open (renderer pull on focus). */
function takePendingNotificationOpen() {
  const payload = pendingNotificationPayload();
  pendingNotificationOpen = null;
  return payload;
}

function setAppIcon(mode) {
  if (mode !== 'light' && mode !== 'dark' && mode !== 'system') {
    throw new Error('App icon mode must be light, dark, or system.');
  }
  appIconMode = mode;
  applyAppIcon();
  return mode;
}

function reloadShell(ignoreCache) {
  detachNativeBrowser();
  if (!isWindowUsable(mainWindow)) return;
  closeRendererOwnedTerminals();
  if (ignoreCache) mainWindow.webContents.reloadIgnoringCache();
  else mainWindow.webContents.reload();
}

function installMainRendererLifecycle(contents) {
  let hasLoadedMainFrame = false;
  let cleanedForNavigation = false;

  const cleanupForRendererReplacement = () => {
    if (!hasLoadedMainFrame || cleanedForNavigation) return;
    cleanedForNavigation = true;
    githubVcs.cancelSetup();
    closeRendererOwnedTerminals();
  };

  contents.on('did-finish-load', () => {
    hasLoadedMainFrame = true;
    cleanedForNavigation = false;
  });
  contents.on('will-frame-navigate', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) cleanupForRendererReplacement();
  });
  contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) cleanupForRendererReplacement();
  });
  contents.on('render-process-gone', cleanupForRendererReplacement);
}

function closeRendererOwnedTerminals() {
  terminalSubscriptions.clear();
  terminalManager.closeAll();
}

function appRoot() {
  // Packaged app files (renderer dist, electron/) live inside app.asar, which
  // Electron resolves transparently for loadFile/loadURL.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar')
    : path.resolve(__dirname, '..');
}

function sidecarEntry() {
  // The sidecar ships as an extraResource beside the asar so it can be spawned
  // as a plain Node script; an asar path would not survive as a child cwd/argv.
  if (!app.isPackaged && process.env.SIDECAR_ENTRY) return process.env.SIDECAR_ENTRY;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sidecar/dist/sidecar.mjs')
    : path.join(appRoot(), 'sidecar/dist/sidecar.mjs');
}

function readBuildMetadata() {
  if (!app.isPackaged) {
    return {
      sentryDsn: process.env.SENTRY_DSN || '',
      sparkleFeedUrl: process.env.SPARKLE_FEED_URL || '',
      updateInstallMode: 'sparkle',
    };
  }
  try {
    const metadata = require(path.join(app.getAppPath(), 'package.json'));
    return {
      sentryDsn: typeof metadata.sentryDsn === 'string' ? metadata.sentryDsn : '',
      sparkleFeedUrl: typeof metadata.sparkleFeedUrl === 'string' ? metadata.sparkleFeedUrl : '',
      updateInstallMode: metadata.updateInstallMode === 'automatic' ? 'automatic' : 'sparkle',
    };
  } catch {
    return { sentryDsn: '', sparkleFeedUrl: '', updateInstallMode: 'sparkle' };
  }
}

function configureBrowserSession() {
  if (browserSessionConfigured) return;
  const ses = session.fromPartition(BROWSER_PARTITION);
  // Keep Electron's safe defaults: deny WebHID/WebUSB device access for the
  // embedded browser. WebAuthn / passkeys are handled by Chromium natively and
  // do not flow through these handlers, so granting HID/USB to arbitrary sites
  // (and auto-selecting a device) would only open a hardware-permission
  // escalation path with no upside.
  ses.setDevicePermissionHandler(() => false);
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    recordNativeBrowserNetworkEvent(details);
  });
  ses.webRequest.onErrorOccurred({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    recordNativeBrowserNetworkEvent(details);
  });
  browserSessionConfigured = true;
}

const CREDENTIAL_VAULT_FILE = () => path.join(app.getPath('userData'), 'browser-credentials.enc');
const CREDENTIAL_CONSENT_FILE = () =>
  path.join(app.getPath('userData'), 'browser-credentials.consent');
let credentialCaptureBusy = false;

// Saved-login support is strictly opt-in. Until the user agrees the first time
// they sign in, nothing is captured, auto-filled, or exposed to the agent.
// 'unset' = never asked, 'enabled' = allowed, 'disabled' = user said never.
function getCredentialConsent() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CREDENTIAL_CONSENT_FILE(), 'utf8'));
    return parsed && (parsed.consent === 'enabled' || parsed.consent === 'disabled')
      ? parsed.consent
      : 'unset';
  } catch {
    return 'unset';
  }
}

function setCredentialConsent(consent) {
  try {
    fs.mkdirSync(path.dirname(CREDENTIAL_CONSENT_FILE()), { recursive: true });
    fs.writeFileSync(CREDENTIAL_CONSENT_FILE(), JSON.stringify({ consent }), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

function loadCredentialVault() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return [];
    const raw = fs.readFileSync(CREDENTIAL_VAULT_FILE(), 'utf8');
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (row) => row && typeof row.origin === 'string' && typeof row.enc === 'string',
    );
  } catch {
    return [];
  }
}

function saveCredentialVault(rows) {
  fs.mkdirSync(path.dirname(CREDENTIAL_VAULT_FILE()), { recursive: true });
  fs.writeFileSync(CREDENTIAL_VAULT_FILE(), JSON.stringify(rows), { mode: 0o600 });
}

function upsertCredential(origin, username, password) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const enc = safeStorage.encryptString(JSON.stringify({ username, password })).toString('base64');
  const rows = loadCredentialVault().filter((row) => row.origin !== origin);
  rows.push({ origin, enc });
  saveCredentialVault(rows);
  return true;
}

// Returns the decrypted credential for an origin. Callers must never forward
// the returned values to the renderer or agent; they are injected in-page only.
function findCredential(origin) {
  const row = loadCredentialVault().find((entry) => entry.origin === origin);
  if (!row) return undefined;
  try {
    const json = safeStorage.decryptString(Buffer.from(row.enc, 'base64'));
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.password === 'string') {
      return {
        username: typeof parsed.username === 'string' ? parsed.username : '',
        password: parsed.password,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function originFor(url) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

async function handleCredentialCapture(senderContents, payload) {
  if (credentialCaptureBusy) return;
  const origin = payload && typeof payload.origin === 'string' ? payload.origin : undefined;
  const password = payload && typeof payload.password === 'string' ? payload.password : '';
  if (!origin || origin === 'null' || !password) return;
  if (!safeStorage.isEncryptionAvailable()) return;
  const consent = getCredentialConsent();
  if (consent === 'disabled') return;
  const existing = findCredential(origin);
  if (existing && existing.password === password && existing.username === (payload.username || ''))
    return;
  credentialCaptureBusy = true;
  try {
    if (consent === 'unset') {
      // First-time opt-in. The user can enable, skip for now, or never ask.
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Enable & save login', 'Not now', 'Never'],
        defaultId: 0,
        cancelId: 1,
        title: `Save logins in ${APP_NAME}?`,
        message: `Let ${APP_NAME} securely save logins for its browser?`,
        detail: `Logins are encrypted with your OS keychain so you stay signed in across restarts (${origin}). The agent can use a saved login to sign in for you, but can never read the username or password. You can turn this off anytime by choosing Never.`,
      });
      if (response === 2) {
        setCredentialConsent('disabled');
        return;
      }
      if (response === 1) return; // Not now: ask again on the next sign-in.
      setCredentialConsent('enabled');
      upsertCredential(origin, payload.username || '', password);
      return;
    }
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Save password', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      title: 'Save password',
      message: `Save this login for ${origin}?`,
      detail: `${APP_NAME} stores it encrypted with your OS keychain. The agent can use it to sign in but can never read it.`,
    });
    if (response === 0) upsertCredential(origin, payload.username || '', password);
  } catch {
    /* dialog dismissed */
  } finally {
    credentialCaptureBusy = false;
  }
}

async function autofillSavedCredential(entry) {
  if (getCredentialConsent() !== 'enabled') return false;
  const contents = safeWebContents(entry?.view);
  if (!contents) return false;
  const origin = originFor(contents.getURL());
  if (!origin) return false;
  const credential = findCredential(origin);
  if (!credential) return false;
  try {
    const result = await contents.executeJavaScript(
      `window.__DROIDMAXX_FILL_CREDENTIALS?.(${JSON.stringify(credential)});`,
      true,
    );
    return Boolean(result && result.filled);
  } catch {
    return false;
  }
}

function ensureNativeBrowserEntry(browserSessionId) {
  browserSessionId = normalizeNativeBrowserSessionId(browserSessionId);
  let entry = nativeBrowsers.get(browserSessionId);
  if (!entry) {
    entry = createNativeBrowserEntry(browserSessionId);
    nativeBrowsers.set(browserSessionId, entry);
  }
  clearNativeBrowserIdleTimer(entry);
  return entry;
}

function createNativeBrowserEntry(browserSessionId) {
  return {
    browserSessionId,
    view: null,
    targetUrl: null,
    state: { designMode: false, pencilMode: false },
    attached: false,
    visible: true,
    windowAttached: false,
    hostWindow: null,
    idleTimer: null,
    loadingUrl: null,
    loadingPromise: null,
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    networkEvents: [],
    consoleEvents: [],
    rendererCrashes: [],
  };
}

function ensureNativeBrowserView(browserSessionId) {
  const entry = ensureNativeBrowserEntry(browserSessionId);
  if (isBrowserViewUsable(entry.view)) return entry;
  if (!isWindowUsable(mainWindow)) throw new Error(`${APP_NAME} window is not available.`);
  configureBrowserSession();
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'nativeBrowserPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      partition: BROWSER_PARTITION,
    },
  });
  entry.view = view;
  const contents = view.webContents;
  contents.setWindowOpenHandler(({ url: nextUrl }) => {
    if (entry.view === view) loadNativeBrowserUrl(entry, nextUrl);
    return { action: 'deny' };
  });
  contents.on('console-message', (details) => {
    entry.consoleEvents.push({
      timestamp: Date.now(),
      ...normalizeBrowserConsoleMessage(details),
    });
    if (entry.consoleEvents.length > 100) {
      entry.consoleEvents.splice(0, entry.consoleEvents.length - 100);
    }
  });
  contents.on('did-finish-load', () => {
    const current = safeWebContents(view);
    if (entry.view !== view || !current) return;
    const loadedUrl = current.getURL();
    if (isChromeErrorUrl(loadedUrl)) {
      if (entry.targetUrl && !isChromeErrorUrl(entry.targetUrl))
        emitNativeBrowserLoaded(entry, entry.targetUrl);
      return;
    }
    entry.targetUrl = loadedUrl;
    emitNativeBrowserLoaded(entry, loadedUrl);
    if (entry.state.designMode) applyNativeBrowserDesignState(entry);
    void autofillSavedCredential(entry);
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
    if (entry.view !== view || !isMainFrame || errorCode === -3) return;
    const fallback = httpFallbackUrl(failedUrl, errorCode);
    if (fallback) {
      void loadNativeBrowserUrl(entry, fallback, { force: true });
      return;
    }
    emitNativeBrowserLoadFailed(entry, failedUrl, errorDescription || `net error ${errorCode}`);
  });
  contents.on('dom-ready', () => {
    if (entry.view === view && entry.state.designMode) applyNativeBrowserDesignState(entry);
  });
  contents.on('destroyed', () => {
    if (entry.view === view) {
      entry.view = null;
      entry.attached = false;
      entry.windowAttached = false;
      entry.hostWindow = null;
      if (attachedBrowserSessionId === entry.browserSessionId) attachedBrowserSessionId = null;
    }
  });
  contents.on('render-process-gone', (_event, details) => {
    if (entry.view === view) recoverNativeBrowserRenderer(entry, view, details);
  });
  contents.on('did-navigate-in-page', (_event, nextUrl) => {
    if (entry.view !== view) return;
    entry.targetUrl = nextUrl;
    emitNativeBrowserLoaded(entry, nextUrl);
    if (entry.state.designMode) applyNativeBrowserDesignState(entry);
  });
  return entry;
}

async function openNativeBrowser(browserSessionId, url, bounds, viewport) {
  const entry = ensureNativeBrowserView(browserSessionId);
  if (viewport) entry.viewport = normalizeBrowserViewport(viewport);
  rejectHostAppUrl(url);
  url = normalizeNativeBrowserUrl(entry, url);
  validateUrl(url);
  if (bounds) await attachNativeBrowser(entry.browserSessionId, bounds, { restore: false });
  else {
    setHiddenNativeBrowserBounds(entry, entry.viewport);
    addHiddenNativeBrowserViewToWindow(entry);
  }
  await loadNativeBrowserUrl(entry, url, { force: true });
  scheduleNativeBrowserIdleClose(entry);
}

async function attachNativeBrowser(browserSessionId, bounds, options = {}) {
  const entry = ensureNativeBrowserView(browserSessionId);
  if (!isWindowUsable(mainWindow)) throw new Error(`${APP_NAME} window is not available.`);
  if (attachedBrowserSessionId && attachedBrowserSessionId !== entry.browserSessionId) {
    detachNativeBrowser(attachedBrowserSessionId);
  }
  const view = entry.view;
  if (!view) throw new Error(`${APP_NAME} browser is not open.`);
  attachNativeBrowserViewToMainWindow(entry);
  attachedBrowserSessionId = entry.browserSessionId;
  entry.attached = true;
  view.setBounds(normalizeBounds(bounds));
  clearNativeBrowserIdleTimer(entry);
  if (entry.state.designMode) applyNativeBrowserDesignState(entry);
  if (options.restore !== false) {
    const targetUrl =
      restorableUrlForEntry(entry, entry.targetUrl) ??
      restorableUrlForEntry(entry, options.restoreUrl);
    const currentUrl = safeWebContents(view)?.getURL() ?? '';
    if (
      targetUrl &&
      (!currentUrl || currentUrl === 'about:blank' || isChromeErrorUrl(currentUrl))
    ) {
      rejectHostAppUrl(targetUrl);
      validateUrl(targetUrl);
      await loadNativeBrowserUrl(entry, targetUrl, { force: true });
    }
  }
}

function detachNativeBrowser(browserSessionId) {
  const targetBrowserSessionId = browserSessionId ?? attachedBrowserSessionId;
  if (!targetBrowserSessionId) return;
  const entry = nativeBrowsers.get(targetBrowserSessionId);
  if (!entry) return;
  if (attachedBrowserSessionId === targetBrowserSessionId) attachedBrowserSessionId = null;
  entry.attached = false;
  safeWebContents(entry.view)?.setBackgroundThrottling(true);
  removeNativeBrowserViewFromWindow(entry, entry.view);
  setHiddenNativeBrowserBounds(entry, entry.viewport);
  addHiddenNativeBrowserViewToWindow(entry);
  scheduleNativeBrowserIdleClose(entry);
}

function setNativeBrowserBounds(browserSessionId, bounds) {
  const entry = nativeBrowsers.get(normalizeNativeBrowserSessionId(browserSessionId));
  if (!entry?.attached || !isBrowserViewUsable(entry.view)) return;
  entry.view.setBounds(normalizeBounds(bounds));
}

function setNativeBrowserVisible(browserSessionId, visible) {
  const entry = ensureNativeBrowserEntry(browserSessionId);
  entry.visible = Boolean(visible);
  if (!isBrowserViewUsable(entry.view) || !entry.attached) return;
  entry.view.setVisible(entry.visible);
  safeWebContents(entry.view)?.setBackgroundThrottling(!entry.visible);
}

function closeNativeBrowser(browserSessionId) {
  const entry = nativeBrowsers.get(normalizeNativeBrowserSessionId(browserSessionId));
  if (entry) closeNativeBrowserEntry(entry, true);
}

function reloadNativeBrowser(browserSessionId) {
  const entry = nativeBrowsers.get(normalizeNativeBrowserSessionId(browserSessionId));
  const contents = safeWebContents(entry?.view);
  if (!contents) throw new Error(`${APP_NAME} browser is not open.`);
  entry.targetUrl = contents.getURL();
  contents.reload();
}

function navigateNativeBrowserHistory(browserSessionId, direction) {
  const entry = nativeBrowsers.get(normalizeNativeBrowserSessionId(browserSessionId));
  const contents = safeWebContents(entry?.view);
  if (!contents) throw new Error(`${APP_NAME} browser is not open.`);
  const history = contents.navigationHistory;
  if (!history) return false;
  if (direction === 'back') {
    if (!history.canGoBack()) return false;
    history.goBack();
  } else {
    if (!history.canGoForward()) return false;
    history.goForward();
  }
  return true;
}

function setNativeBrowserDesignMode(browserSessionId, active) {
  const entry = ensureNativeBrowserEntry(browserSessionId);
  const next = Boolean(active);
  if (entry.state.designMode === next) return;
  entry.state.designMode = next;
  if (!entry.state.designMode) entry.state.pencilMode = false;
  return applyNativeBrowserDesignState(entry);
}

function setNativeBrowserPencilMode(browserSessionId, active) {
  const entry = ensureNativeBrowserEntry(browserSessionId);
  const next = entry.state.designMode && Boolean(active);
  if (entry.state.pencilMode === next) return;
  entry.state.pencilMode = next;
  return applyNativeBrowserDesignState(entry);
}

async function runNativeBrowserAgentAction(request) {
  const entry = await restoreNativeBrowserForAction(request.browserSessionId);
  try {
    const contents = safeWebContents(entry.view);
    if (!contents) throw new Error(`${APP_NAME} browser is not open.`);
    if (request.action === 'resize') {
      entry.viewport = normalizeBrowserViewport(request.viewport);
      // Attached bounds remain owned by the Browser pane layout.
      if (!entry.attached) setHiddenNativeBrowserBounds(entry, entry.viewport);
      return { requestId: request.requestId, ok: true };
    }
    if (request.action === 'network') {
      const networkEvents = entry.networkEvents.slice();
      if (request.clearNetworkLog) entry.networkEvents.length = 0;
      return { requestId: request.requestId, ok: true, networkEvents };
    }
    if (request.action === 'console') {
      const consoleEvents = entry.consoleEvents.slice();
      if (request.clearConsoleLog) entry.consoleEvents.length = 0;
      return { requestId: request.requestId, ok: true, consoleEvents };
    }
    const navigation = observeAgentNavigation(contents);
    contents.setBackgroundThrottling(false);
    try {
      if (request.action === 'fillCredentials') {
        return withNativeBrowserHistory(contents, await fillCredentialsForAgent(contents, request));
      }
      const execution = executeNativeBrowserAgentAction(contents, request).then(
        (result) => ({ type: 'result', result }),
        (error) => ({ type: 'error', error }),
      );
      const outcome = await Promise.race([
        execution,
        navigation.wait().then(() => ({ type: 'navigation' })),
      ]);
      if (outcome.type === 'navigation') {
        return await snapshotNativeBrowserAfterNavigation(contents, request);
      }
      if (outcome.type === 'error') {
        if (!navigation.started() || !isNavigationExecutionError(outcome.error))
          throw outcome.error;
        await navigation.wait();
        return await snapshotNativeBrowserAfterNavigation(contents, request);
      }
      return withNativeBrowserHistory(contents, outcome.result);
    } finally {
      navigation.dispose();
      restoreNativeBrowserBackgroundThrottling(contents, entry);
    }
  } finally {
    scheduleNativeBrowserIdleClose(entry);
  }
}

async function executeNativeBrowserAgentAction(contents, request) {
  if (
    request.action === 'scroll' &&
    Number.isFinite(Number(request.x)) &&
    Number.isFinite(Number(request.y))
  ) {
    const x = Math.round(Number(request.x));
    const y = Math.round(Number(request.y));
    const pixels = Math.max(1, Math.round(Number(request.pixels) || 500));
    const horizontal = request.direction === 'left' || request.direction === 'right';
    contents.sendInputEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX: horizontal ? (request.direction === 'left' ? -pixels : pixels) : 0,
      deltaY: horizontal ? 0 : request.direction === 'up' ? -pixels : pixels,
      canScroll: true,
    });
    return contents.executeJavaScript(
      `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify({
        ...request,
        action: 'snapshot',
      })});`,
      true,
    );
  }
  if (request.action === 'click' || request.action === 'hover') {
    const point = await resolveNativeBrowserPointer(contents, request);
    const x = point.x;
    const y = point.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('Browser pointer interaction requires finite viewport coordinates.');
    }
    contents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
    if (request.action === 'click') {
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }
    return contents.executeJavaScript(
      `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify({
        ...request,
        action: 'snapshot',
      })});`,
      true,
    );
  }
  return contents.executeJavaScript(
    `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify(request)});`,
    true,
  );
}

async function resolveNativeBrowserPointer(contents, request) {
  if (typeof request.selector === 'string' && request.selector) {
    const point = await contents.executeJavaScript(
      `(() => {
        const target = document.querySelector(${JSON.stringify(request.selector)});
        if (!target) return null;
        target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
        const box = target.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return null;
        return {
          x: Math.round(box.left + box.width / 2),
          y: Math.round(box.top + box.height / 2)
        };
      })()`,
      true,
    );
    if (!point) {
      throw new Error('Browser target is no longer available. Refresh the snapshot and try again.');
    }
    return point;
  }
  return {
    x: Math.round(Number(request.x)),
    y: Math.round(Number(request.y)),
  };
}

async function snapshotNativeBrowserAfterNavigation(contents, request) {
  try {
    const result = await contents.executeJavaScript(
      `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify({
        requestId: request.requestId,
        action: 'snapshot',
      })});`,
      true,
    );
    return withNativeBrowserHistory(contents, result);
  } catch {
    return withNativeBrowserHistory(contents, { requestId: request.requestId, ok: true });
  }
}

function withNativeBrowserHistory(contents, result) {
  if (!result || typeof result !== 'object') return result;
  if (contents.isDestroyed()) return result;
  const history = contents.navigationHistory;
  if (!history || !result.snapshot) return result;
  return {
    ...result,
    snapshot: {
      ...result.snapshot,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    },
  };
}

function observeAgentNavigation(contents, timeoutMs = 7_000) {
  let didStart = false;
  let settled = false;
  let timeout;
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    resolveCompletion();
  };
  const onStart = (_event, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame || didStart) return;
    didStart = true;
    timeout = setTimeout(finish, timeoutMs);
  };
  const onFinish = () => {
    if (didStart) finish();
  };
  const onFail = (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) finish();
  };
  const onDestroyed = () => finish();
  contents.on('did-start-navigation', onStart);
  contents.on('did-finish-load', onFinish);
  contents.on('did-fail-load', onFail);
  contents.on('destroyed', onDestroyed);
  return {
    started: () => didStart,
    wait: () => completion,
    dispose: () => {
      clearTimeout(timeout);
      contents.removeListener('did-start-navigation', onStart);
      contents.removeListener('did-finish-load', onFinish);
      contents.removeListener('did-fail-load', onFail);
      contents.removeListener('destroyed', onDestroyed);
    },
  };
}

function isNavigationExecutionError(err) {
  const message = String(err?.message || err).toLowerCase();
  return (
    message.includes('script execution was interrupted') ||
    message.includes('execution context was destroyed') ||
    message.includes('frame was disposed') ||
    message.includes('object has been destroyed')
  );
}

// Agent-blind login: the saved secret is decrypted and injected here in the
// main process. The request and the result never carry the values, and the
// returned snapshot has password fields redacted by the preload.
async function fillCredentialsForAgent(contents, request) {
  if (getCredentialConsent() !== 'enabled') {
    return {
      requestId: request.requestId,
      ok: false,
      error: `Saved logins are turned off for the ${APP_NAME} browser. Ask the user to sign in once; they will be prompted to enable and save the login first.`,
    };
  }
  const origin = originFor(contents.getURL());
  const credential = origin ? findCredential(origin) : undefined;
  if (!credential) {
    return {
      requestId: request.requestId,
      ok: false,
      error:
        'No saved credentials for this site. The user can sign in once and choose to save the password.',
    };
  }
  const fill = await contents
    .executeJavaScript(
      `window.__DROIDMAXX_FILL_CREDENTIALS?.(${JSON.stringify(credential)});`,
      true,
    )
    .catch(() => undefined);
  if (!fill || !fill.ok) {
    return {
      requestId: request.requestId,
      ok: false,
      error: (fill && fill.error) || 'Could not find a login form to fill on this page.',
    };
  }
  const probe = await contents
    .executeJavaScript(
      `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify({ ...request, action: 'snapshot' })});`,
      true,
    )
    .catch(() => undefined);
  return { requestId: request.requestId, ok: true, snapshot: probe?.snapshot };
}

async function captureNativeBrowser(browserSessionId, box, options = {}) {
  const entry = await restoreNativeBrowserForAction(browserSessionId);
  const contents = safeWebContents(entry.view);
  if (!contents) throw new Error(`${APP_NAME} browser is not open.`);
  contents.setBackgroundThrottling(false);
  try {
    const fullPage = Boolean(options?.fullPage);
    const scale =
      typeof options?.deviceScaleFactor === 'number' && options.deviceScaleFactor > 0
        ? options.deviceScaleFactor
        : 2;
    // A box crop is always already on-screen (the user just selected/sketched
    // it). Capture the composited frame directly: capturePage never re-renders
    // the page off-screen the way CDP's captureBeyondViewport does, so the live
    // pane no longer flickers on every selection or sketch.
    if (box && !fullPage) {
      const rect = normalizeCaptureRect(entry, box);
      if (!rect) throw new Error('Requested capture region is empty or out of bounds.');
      const cropped = await contents.capturePage(rect).catch(() => undefined);
      if (cropped && !cropped.isEmpty()) return cropped.toPNG().toString('base64');
    }
    const data = await captureNativeBrowserViaCdp(contents, { fullPage, scale, box }).catch(
      (err) => {
        console.error(`cdp capture failed, falling back to viewport: ${err.message}`);
        return undefined;
      },
    );
    if (data) return data;
    const rect = normalizeCaptureRect(entry, box);
    // A supplied box that normalizes away is an empty/out-of-bounds crop; fail
    // rather than silently returning the full viewport (unintended content).
    if (box && !rect) throw new Error('Requested capture region is empty or out of bounds.');
    const image = rect ? await contents.capturePage(rect) : await contents.capturePage();
    return image.isEmpty() ? undefined : image.toPNG().toString('base64');
  } finally {
    restoreNativeBrowserBackgroundThrottling(contents, entry);
    scheduleNativeBrowserIdleClose(entry);
  }
}

function restoreNativeBrowserBackgroundThrottling(contents, entry) {
  if (entry.attached && entry.visible) return;
  try {
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(true);
  } catch {
    // Cleanup is best-effort when the browser closes during an action.
  }
}

async function captureNativeBrowserViaCdp(contents, { fullPage, scale, box }) {
  return runWithWebContentsDebugger(contents, async (dbg) => {
    const params = { format: 'png', captureBeyondViewport: Boolean(fullPage) || Boolean(box) };
    const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
    const viewport = metrics.cssVisualViewport || metrics.visualViewport;
    const content = metrics.cssContentSize || metrics.contentSize;
    if (box) {
      // Selection boxes are viewport CSS coordinates; clips beyond the
      // viewport are in page coordinates, so offset by the current scroll.
      const x = (viewport.pageX || 0) + Math.max(0, box.x);
      const y = (viewport.pageY || 0) + Math.max(0, box.y);
      const width = Math.min(box.width, content.width - x);
      const height = Math.min(box.height, content.height - y);
      if (width <= 0 || height <= 0)
        throw new Error('Requested capture region is empty or out of bounds.');
      params.clip = { x, y, width, height, scale };
    } else if (fullPage) {
      if (content.width > 0 && content.height > 0) {
        params.clip = { x: 0, y: 0, width: content.width, height: content.height, scale };
      }
    } else if (viewport.clientWidth > 0 && viewport.clientHeight > 0) {
      params.clip = {
        x: 0,
        y: 0,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scale,
      };
    }
    const result = await dbg.sendCommand('Page.captureScreenshot', params);
    return result?.data || undefined;
  });
}

const DESIGN_CAPTURE_PADDING = 32;

// Capture the prompt's selection region with surrounding context while the
// in-page annotations are still visible.
async function captureDesignSelection(senderContents, selection) {
  const box = selection?.anchor?.box;
  if (!box || !(box.width > 0) || !(box.height > 0)) return undefined;
  const entry = findNativeBrowserEntryForWebContents(senderContents);
  const contents = safeWebContents(entry?.view);
  if (!contents) return undefined;
  const padded = {
    x: Math.max(0, box.x - DESIGN_CAPTURE_PADDING),
    y: Math.max(0, box.y - DESIGN_CAPTURE_PADDING),
    width: box.width + DESIGN_CAPTURE_PADDING * 2,
    height: box.height + DESIGN_CAPTURE_PADDING * 2,
  };
  // Crop the on-screen composited frame (annotations are visible DOM overlays)
  // instead of a CDP captureBeyondViewport screenshot, which re-rasters the
  // page off-screen and flickers the pane on every send.
  const rect = normalizeCaptureRect(entry, padded);
  if (rect) {
    const image = await contents.capturePage(rect).catch(() => undefined);
    if (image && !image.isEmpty()) return { base64: image.toPNG().toString('base64'), box: padded };
  }
  const base64 = await captureNativeBrowserViaCdp(contents, { scale: 2, box: padded }).catch(
    () => undefined,
  );
  return base64 ? { base64, box: padded } : undefined;
}

function findNativeBrowserEntryForWebContents(contents) {
  for (const entry of nativeBrowsers.values()) {
    if (safeWebContents(entry.view) === contents) return entry;
  }
  return undefined;
}

function recordNativeBrowserNetworkEvent(details) {
  const entry = [...nativeBrowsers.values()].find(
    (candidate) => safeWebContents(candidate.view)?.id === details.webContentsId,
  );
  if (!entry) return;
  entry.networkEvents.push({
    timestamp: Date.now(),
    method: String(details.method || 'GET').slice(0, 16),
    url: redactBrowserDiagnosticUrl(details.url),
    resourceType: details.resourceType ? String(details.resourceType) : undefined,
    status: Number.isFinite(details.statusCode) ? details.statusCode : undefined,
    error: details.error ? String(details.error).slice(0, 200) : undefined,
  });
  if (entry.networkEvents.length > 100) {
    entry.networkEvents.splice(0, entry.networkEvents.length - 100);
  }
}

function normalizeCaptureRect(entry, box) {
  if (!box) return undefined;
  const bounds = entry.view?.getBounds?.() ?? { width: 0, height: 0 };
  const maxWidth = bounds.width || Number.MAX_SAFE_INTEGER;
  const maxHeight = bounds.height || Number.MAX_SAFE_INTEGER;
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const width = Math.min(Math.round(box.width), maxWidth - x);
  const height = Math.min(Math.round(box.height), maxHeight - y);
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function applyNativeBrowserDesignState(entry) {
  const contents = safeWebContents(entry?.view);
  if (!contents) return undefined;
  return contents
    .executeJavaScript(
      `window.__DROIDMAXX_APPLY_DESIGN_STATE?.(${JSON.stringify(entry.state)});`,
      true,
    )
    .catch((err) => console.error(`failed to apply browser design state: ${err.message}`));
}

function emitNativeBrowserLoaded(entry, url) {
  if (!isWindowUsable(mainWindow)) return;
  const history = safeWebContents(entry.view)?.navigationHistory;
  mainWindow.webContents.send('native-browser-loaded', {
    browserSessionId: entry.browserSessionId,
    url,
    canGoBack: history?.canGoBack() ?? false,
    canGoForward: history?.canGoForward() ?? false,
  });
}

function emitNativeBrowserLoadFailed(entry, url, error) {
  if (!isWindowUsable(mainWindow)) return;
  mainWindow.webContents.send('native-browser-load-failed', {
    browserSessionId: entry.browserSessionId,
    url,
    error,
  });
}

// Bare hosts are normalized to https by the renderer; local dev servers are
// usually plain http. Retry once over http for private/loopback hosts instead
// of stranding the pane on a blank error page. Only fall back on
// ERR_CONNECTION_REFUSED: that unambiguously means nothing is listening on
// https, so there is no secure connection to downgrade. Certificate or TLS
// handshake failures mean a real HTTPS server is present, so retrying those
// over plain http would silently weaken a secure connection.
function httpFallbackUrl(url, errorCode) {
  const retryableCodes = new Set([
    -102, // ERR_CONNECTION_REFUSED  (no server listening on https)
  ]);
  if (!retryableCodes.has(errorCode)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
    if (!isPrivateHost(parsed.hostname)) return undefined;
    parsed.protocol = 'http:';
    return parsed.href;
  } catch {
    return undefined;
  }
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (isLoopbackHost(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.test') || host.endsWith('.localhost')) return true;
  if (!host.includes('.')) return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

async function loadNativeBrowserUrl(entry, url, options = {}) {
  url = normalizeNativeBrowserUrl(entry, url);
  const contents = safeWebContents(entry.view);
  if (!contents) return;
  if (url === 'about:blank' && contents.getURL() === 'about:blank') return;
  if (!options.force && contents.getURL() === url) return;
  if (entry.loadingUrl === url && entry.loadingPromise) return entry.loadingPromise;
  entry.targetUrl = url;
  const load = contents
    .loadURL(url)
    .catch((err) => {
      if (entry.targetUrl === url) entry.targetUrl = null;
      if (!contents.isDestroyed() && !isLoadAbortError(err))
        console.error(`failed to load native browser URL: ${err.message}`);
    })
    .finally(() => {
      if (entry.loadingPromise === load) {
        entry.loadingPromise = null;
        entry.loadingUrl = null;
      }
    });
  entry.loadingUrl = url;
  entry.loadingPromise = load;
  return load;
}

async function restoreNativeBrowserForAction(browserSessionId) {
  const entry = ensureNativeBrowserView(browserSessionId);
  if (!entry.attached) {
    setHiddenNativeBrowserBounds(entry, entry.viewport);
    addHiddenNativeBrowserViewToWindow(entry);
  }
  if (entry.targetUrl) await loadNativeBrowserUrl(entry, entry.targetUrl);
  return entry;
}

function attachNativeBrowserViewToMainWindow(entry) {
  if (!entry.view || !isWindowUsable(mainWindow)) return;
  const previousHost = entry.hostWindow;
  const moved = attachChildView(entry, mainWindow);
  entry.view.setVisible(entry.visible);
  safeWebContents(entry.view)?.setBackgroundThrottling(!entry.visible);
  if (moved && previousHost === hiddenNativeBrowserWindow) {
    closeHiddenNativeBrowserWindowIfUnused();
    resizeHiddenNativeBrowserWindow();
  }
}

function addHiddenNativeBrowserViewToWindow(entry) {
  if (!entry.view) return;
  const host = ensureHiddenNativeBrowserWindow();
  attachChildView(entry, host);
  entry.view.setVisible(true);
  resizeHiddenNativeBrowserWindow();
}

function removeNativeBrowserViewFromWindow(entry, view) {
  const host = entry.hostWindow ?? mainWindow;
  detachChildView(entry, view);
  if (host === hiddenNativeBrowserWindow) {
    closeHiddenNativeBrowserWindowIfUnused();
    resizeHiddenNativeBrowserWindow();
  }
}

function resizeHiddenNativeBrowserWindow() {
  if (!isWindowUsable(hiddenNativeBrowserWindow)) return;
  let width = 1;
  let height = 1;
  for (const entry of nativeBrowsers.values()) {
    if (!entry.windowAttached || entry.hostWindow !== hiddenNativeBrowserWindow) continue;
    const bounds = entry.view?.getBounds();
    width = Math.max(width, bounds?.width ?? 1);
    height = Math.max(height, bounds?.height ?? 1);
  }
  hiddenNativeBrowserWindow.setContentSize(width, height);
}

function setHiddenNativeBrowserBounds(entry, viewport) {
  if (!isBrowserViewUsable(entry.view)) return;
  const width = Math.max(1, Math.round(Number(viewport?.width) || 1200));
  const height = Math.max(1, Math.round(Number(viewport?.height) || 800));
  entry.view.setBounds({ x: 0, y: 0, width, height });
  if (entry.hostWindow === hiddenNativeBrowserWindow && isWindowUsable(hiddenNativeBrowserWindow)) {
    resizeHiddenNativeBrowserWindow();
  }
}

function normalizeBrowserViewport(viewport) {
  return {
    width: Math.max(1, Math.round(Number(viewport?.width) || 1200)),
    height: Math.max(1, Math.round(Number(viewport?.height) || 800)),
    deviceScaleFactor: Math.max(0.1, Number(viewport?.deviceScaleFactor) || 2),
  };
}

function scheduleNativeBrowserIdleClose(entry) {
  if (!entry || entry.attached || HIDDEN_BROWSER_IDLE_MS <= 0) return;
  clearNativeBrowserIdleTimer(entry);
  entry.idleTimer = setTimeout(() => {
    if (!entry.attached) closeNativeBrowserEntry(entry, false);
  }, HIDDEN_BROWSER_IDLE_MS);
}

function clearNativeBrowserIdleTimer(entry) {
  if (!entry?.idleTimer) return;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
}

function closeNativeBrowserEntry(entry, forget) {
  clearNativeBrowserIdleTimer(entry);
  if (attachedBrowserSessionId === entry.browserSessionId) attachedBrowserSessionId = null;
  const view = entry.view;
  entry.view = null;
  entry.attached = false;
  removeNativeBrowserViewFromWindow(entry, view);
  const contents = safeWebContents(view);
  if (contents) {
    try {
      contents.close({ waitForBeforeUnload: false });
    } catch {
      // Already destroyed by Electron window teardown.
    }
  }
  if (forget) nativeBrowsers.delete(entry.browserSessionId);
}

function recoverNativeBrowserRenderer(entry, view, details) {
  const reason = String(details?.reason || 'unknown');
  const targetUrl = restorableUrlForEntry(entry, entry.targetUrl);
  const wasAttached = entry.attached;
  const bounds = view.getBounds();
  const contents = safeWebContents(view);
  removeNativeBrowserViewFromWindow(entry, view);
  entry.view = null;
  entry.attached = false;
  entry.loadingUrl = null;
  entry.loadingPromise = null;
  if (attachedBrowserSessionId === entry.browserSessionId) attachedBrowserSessionId = null;
  contents?.close();
  if (reason === 'clean-exit') return;

  const now = Date.now();
  entry.rendererCrashes = entry.rendererCrashes.filter((timestamp) => now - timestamp < 30_000);
  entry.rendererCrashes.push(now);
  console.error(
    `Native browser renderer exited: browserSession=${entry.browserSessionId} reason=${reason} exitCode=${details?.exitCode}`,
  );
  emitNativeBrowserLoadFailed(
    entry,
    targetUrl ?? 'about:blank',
    `Browser renderer exited (${reason}).`,
  );
  if (entry.rendererCrashes.length >= 3) return;

  setTimeout(() => {
    if (!nativeBrowsers.has(entry.browserSessionId) || entry.view || !isWindowUsable(mainWindow))
      return;
    try {
      ensureNativeBrowserView(entry.browserSessionId);
      if (wasAttached) {
        attachNativeBrowserViewToMainWindow(entry);
        entry.attached = true;
        attachedBrowserSessionId = entry.browserSessionId;
        entry.view.setBounds(bounds);
      } else {
        setHiddenNativeBrowserBounds(entry, entry.viewport);
        addHiddenNativeBrowserViewToWindow(entry);
      }
      if (targetUrl) void loadNativeBrowserUrl(entry, targetUrl, { force: true });
    } catch (err) {
      console.error(`failed to recover native browser renderer: ${err.message}`);
    }
  }, 250);
}

function closeAllNativeBrowsers() {
  for (const entry of [...nativeBrowsers.values()]) {
    closeNativeBrowserEntry(entry, true);
  }
  nativeBrowsers.clear();
  attachedBrowserSessionId = null;
  closeHiddenNativeBrowserWindow();
}

function ensureHiddenNativeBrowserWindow() {
  if (isWindowUsable(hiddenNativeBrowserWindow)) return hiddenNativeBrowserWindow;
  hiddenNativeBrowserWindow = new BrowserWindow({
    show: true,
    x: -10000,
    y: -10000,
    width: 1200,
    height: 800,
    frame: false,
    backgroundColor: '#ffffff',
    opacity: 0,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  hiddenNativeBrowserWindow.setIgnoreMouseEvents(true);
  hiddenNativeBrowserWindow.on('closed', () => {
    hiddenNativeBrowserWindow = null;
  });
  return hiddenNativeBrowserWindow;
}

function closeHiddenNativeBrowserWindow() {
  const window = hiddenNativeBrowserWindow;
  hiddenNativeBrowserWindow = null;
  if (!isWindowUsable(window)) return;
  try {
    window.close();
  } catch {
    // The app may already be tearing down.
  }
}

function closeHiddenNativeBrowserWindowIfUnused() {
  if (!hiddenNativeBrowserWindow) return;
  const inUse = [...nativeBrowsers.values()].some(
    (entry) => entry.windowAttached && entry.hostWindow === hiddenNativeBrowserWindow,
  );
  if (!inUse) closeHiddenNativeBrowserWindow();
}

function normalizeNativeBrowserSessionId(browserSessionId) {
  const value = String(browserSessionId || '').trim();
  if (!value) throw new Error(`${APP_NAME} browser session id is required.`);
  return value;
}

function restorableUrlForEntry(entry, url) {
  if (!url) return undefined;
  const value = normalizeNativeBrowserUrl(entry, url);
  return value === 'about:blank' || isChromeErrorUrl(value) ? undefined : value;
}

function nativeBrowserSessionIdForWebContents(contents) {
  return findNativeBrowserEntryForWebContents(contents)?.browserSessionId;
}

function withNativeBrowserSession(event, payload) {
  return { ...payload, browserSessionId: nativeBrowserSessionIdForWebContents(event.sender) };
}

function isWindowUsable(window) {
  return Boolean(window && !window.isDestroyed());
}

function safeWebContents(view) {
  try {
    if (!view) return null;
    const contents = view.webContents;
    if (!contents || contents.isDestroyed()) return null;
    return contents;
  } catch {
    return null;
  }
}

function isBrowserViewUsable(view) {
  return Boolean(view && safeWebContents(view));
}

function normalizeNativeBrowserUrl(entry, url) {
  const value = String(url || 'about:blank');
  if (isHostAppUrl(value)) return 'about:blank';
  if (!isChromeErrorUrl(value)) return value;
  return entry?.targetUrl && !isChromeErrorUrl(entry.targetUrl) ? entry.targetUrl : 'about:blank';
}

function rejectHostAppUrl(url) {
  if (isHostAppUrl(url)) {
    throw new Error(
      `Cannot open the ${APP_NAME} shell inside its own browser pane. Use a different local app port.`,
    );
  }
}

function isChromeErrorUrl(url) {
  return String(url || '').startsWith('chrome-error://');
}

function isLoadAbortError(err) {
  return (
    String(err?.code || '').includes('ERR_ABORTED') ||
    String(err?.message || '').includes('ERR_ABORTED')
  );
}

function isHostAppUrl(url) {
  const host = localAppEndpoint(process.env.ELECTRON_START_URL || mainWindow?.webContents.getURL());
  const target = localAppEndpoint(url);
  if (!host || !target) return false;
  if (host.port !== target.port) return false;
  return host.local && target.local;
}

function localAppEndpoint(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return {
      local: isLoopbackHost(parsed.hostname),
      port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
    };
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

function validateUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:', 'file:', 'about:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported browser URL scheme: ${parsed.protocol.replace(':', '')}`);
  }
}

function normalizeBounds(bounds) {
  return {
    x: Math.round(bounds?.x ?? 0),
    y: Math.round(bounds?.y ?? 0),
    width: Math.max(1, Math.round(bounds?.width ?? 1)),
    height: Math.max(1, Math.round(bounds?.height ?? 1)),
  };
}

async function getApiKey() {
  try {
    const encrypted = await fsp.readFile(apiKeyPath());
    return safeStorage.decryptString(encrypted);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function setApiKey(key) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Electron safeStorage encryption is not available on this system.');
  }
  await fsp.mkdir(path.dirname(apiKeyPath()), { recursive: true });
  await fsp.writeFile(apiKeyPath(), safeStorage.encryptString(key));
}

async function clearApiKey() {
  await fsp.rm(apiKeyPath(), { force: true });
}

function apiKeyPath() {
  return path.join(app.getPath('userData'), 'factory-api-key.bin');
}

// ── Onboarding state ────────────────────────────────────────────────
// Kept in userData (not localStorage) so the first-run tour survives a cache
// clear and only ever shows once.
const ONBOARDING_VERSION = 1;

function onboardingPath() {
  return path.join(app.getPath('userData'), 'onboarding.json');
}

async function getOnboarding() {
  try {
    const raw = await fsp.readFile(onboardingPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { completed: false, version: ONBOARDING_VERSION, ...parsed };
  } catch {
    return { completed: false, version: ONBOARDING_VERSION };
  }
}

// Serialize read-modify-write so rapid fire-and-forget patches (e.g. two quick
// Settings toggles) can't both read the same old state and clobber each other.
let onboardingWriteQueue = Promise.resolve();

function setOnboarding(patch) {
  const run = onboardingWriteQueue.then(async () => {
    const current = await getOnboarding();
    const next = { ...current, ...(patch || {}), version: ONBOARDING_VERSION };
    await fsp.mkdir(path.dirname(onboardingPath()), { recursive: true });
    await fsp.writeFile(onboardingPath(), JSON.stringify(next, null, 2));
    return next;
  });
  // Keep the queue chained even if this write rejects.
  onboardingWriteQueue = run.catch(() => {});
  return run;
}

function relaunchApp() {
  app.relaunch();
  app.exit(0);
}

function openExternal(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('Refusing to open non-http(s) URL.');
  }
  return shell.openExternal(url);
}

async function listFiles(dir) {
  const root = expandHome(dir);
  const rootStat = await fsp.stat(root);
  if (!rootStat.isDirectory()) throw new Error('not a directory');
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'target',
    '.next',
    '.cache',
    'out',
  ]);
  const out = [];
  const stack = [root];
  while (stack.length && out.length < 6000) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !skip.has(entry.name)) stack.push(fullPath);
      } else if (entry.isFile()) {
        out.push(path.relative(root, fullPath).split(path.sep).join('/'));
        if (out.length >= 6000) break;
      }
    }
  }
  return out.sort();
}

function readFile(filePath) {
  return fsp.readFile(expandHome(filePath), 'utf8');
}

async function repoStatus(dir) {
  const root = expandHome(String(dir || ''));
  if (!root) return null;
  try {
    const rootStat = await fsp.stat(root);
    if (!rootStat.isDirectory()) return null;
    const [repoRoot, status] = await Promise.all([
      git(root, ['rev-parse', '--show-toplevel']),
      git(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all']),
    ]);
    return { repoRoot: repoRoot.trim() || null, ...parseGitStatus(status) };
  } catch {
    return null;
  }
}

async function openProject(dir, editor, target) {
  const root = await projectRoot(dir);
  const pathToOpen = target === 'diff' ? await writeDiffFile(root) : root;
  await launchProjectTarget(editor, pathToOpen, root, target);
}

async function projectRoot(dir) {
  const root = expandHome(String(dir || ''));
  if (!root) throw new Error('No project folder selected.');
  const rootStat = await fsp.stat(root);
  if (!rootStat.isDirectory()) throw new Error('Project path is not a directory.');
  try {
    return (await git(root, ['rev-parse', '--show-toplevel'])).trim() || root;
  } catch {
    return root;
  }
}

async function writeDiffFile(root) {
  let diff;
  try {
    diff = await currentGitDiff(root);
  } catch (err) {
    diff = `Unable to read git diff: ${err.message}\n`;
  }
  const dir = path.join(app.getPath('temp'), 'droidex-diffs');
  await fsp.mkdir(dir, { recursive: true });
  const name = (path.basename(root) || 'repo').replace(/[^\w.-]+/g, '-');
  const filePath = path.join(dir, `${name}-${Date.now()}.diff`);
  await fsp.writeFile(filePath, diff || 'No changes.\n', 'utf8');
  return filePath;
}

async function currentGitDiff(root) {
  const parts = [await git(root, ['diff', 'HEAD', '--'])];
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard']))
    .split(/\r?\n/)
    .filter(Boolean);
  for (const file of untracked) {
    const diff = await gitDiff(root, ['diff', '--no-index', '--', os.devNull, file]);
    if (diff) parts.push(diff);
  }
  return parts.filter(Boolean).join('\n');
}

async function launchProjectTarget(editor, pathToOpen, root, target) {
  const id = normalizeEditor(editor);
  if (id === 'finder') {
    if (target === 'diff') shell.showItemInFolder(pathToOpen);
    else await openPathOrThrow(pathToOpen);
    return;
  }
  if (id === 'terminal') {
    if (target === 'diff') {
      await openPathOrThrow(pathToOpen);
      return;
    }
    await openTerminal(root);
    return;
  }
  if (id === 'vscode') return openApp('Visual Studio Code', 'code', pathToOpen);
  if (id === 'cursor') return openApp('Cursor', 'cursor', pathToOpen);
  if (id === 'xcode') return openApp('Xcode', 'xed', pathToOpen);
}

async function openPathOrThrow(targetPath) {
  const error = await shell.openPath(targetPath);
  if (error) throw new Error(error);
}

function normalizeEditor(value) {
  return ['vscode', 'cursor', 'finder', 'terminal', 'xcode'].includes(value) ? value : 'vscode';
}

// Report which launch targets are actually installed on this machine so the UI
// only offers editors the user can really open.
function listEditors() {
  if (process.platform === 'darwin') {
    const editors = [];
    if (appBundleExists(['Visual Studio Code.app', 'VSCodium.app'])) editors.push('vscode');
    if (appBundleExists(['Cursor.app'])) editors.push('cursor');
    editors.push('finder', 'terminal');
    if (appBundleExists(['Xcode.app'])) editors.push('xcode');
    return editors;
  }
  const editors = [];
  if (commandOnPath('code')) editors.push('vscode');
  if (commandOnPath('cursor')) editors.push('cursor');
  editors.push('finder', 'terminal');
  return editors;
}

function appBundleExists(bundleNames) {
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
  return bundleNames.some((name) => dirs.some((dir) => fs.existsSync(path.join(dir, name))));
}

function commandOnPath(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    require('node:child_process').execFileSync(probe, [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function openApp(macAppName, command, targetPath) {
  if (process.platform === 'darwin') return spawnDetached('open', ['-a', macAppName, targetPath]);
  return spawnDetached(command, [targetPath]);
}

function openTerminal(root) {
  if (process.platform === 'darwin') return spawnDetached('open', ['-a', 'Terminal', root]);
  if (process.platform === 'win32') return spawnDetached('cmd.exe', ['/k'], { cwd: root });
  return spawnDetached('x-terminal-emulator', ['--working-directory', root]);
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', cwd: options.cwd });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      },
    );
  });
}

function gitDiff(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && err.code !== 1) reject(err);
        else resolve(String(stdout));
      },
    );
  });
}

function parseGitStatus(stdout) {
  let branch = null;
  let changed = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      branch = parseGitBranch(line.slice(3));
      continue;
    }
    const x = line[0];
    const y = line[1];
    if (x === '!' && y === '!') continue;
    changed++;
    if (x === '?' && y === '?') {
      untracked++;
      continue;
    }
    if (x !== ' ' && x !== '?') staged++;
    if (y !== ' ' && y !== '?') unstaged++;
  }
  return { branch, changed, staged, unstaged, untracked };
}

function parseGitBranch(value) {
  const text = String(value || '').trim();
  if (text.startsWith('No commits yet on '))
    return text.slice('No commits yet on '.length).trim() || null;
  const branch = text.split('...')[0].trim();
  if (!branch || branch === 'HEAD' || branch.startsWith('HEAD ')) return null;
  return branch;
}

function expandHome(value) {
  if (!value.startsWith('~/')) return value;
  return path.join(app.getPath('home'), value.slice(2));
}
