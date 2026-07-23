const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  WebContentsView,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
} = require('electron');
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const gitVcs = require('./git.cjs');
const githubVcs = require('./github.cjs');
const { createTerminalManager } = require('./terminal.cjs');
const files = require('./files.cjs');

const APP_NAME = 'Droid Control';
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 8765);
const bridge = { port: BRIDGE_PORT, token: crypto.randomBytes(16).toString('hex') };
const terminalManager = createTerminalManager();
const terminalSubscriptions = new Map();

let mainWindow = null;
let hiddenNativeBrowserWindow = null;
let sidecar = null;
let attachedBrowserSessionId = null;
const nativeBrowsers = new Map();
const HIDDEN_BROWSER_IDLE_MS = Number(process.env.DROID_NATIVE_BROWSER_IDLE_MS ?? 300_000);
// A single persistent partition keeps cookies, localStorage, and registered
// passkeys alive across reloads, dev-server restarts, and app restarts so the
// user does not have to sign in again every time.
const BROWSER_PARTITION = 'persist:droid-control-browser';
let browserSessionConfigured = false;

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));

app.whenReady().then(() => {
  installApplicationMenu();
  registerIpc();
  createMainWindow();
  ensureSidecar();
});

app.on('window-all-closed', () => {
  stopSidecar();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopSidecar();
  terminalManager.closeAll();
  clearTerminalSubscriptions();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});

function createMainWindow() {
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

  const startUrl = process.env.ELECTRON_START_URL;
  if (startUrl) mainWindow.loadURL(startUrl);
  else mainWindow.loadFile(path.join(appRoot(), 'dist/index.html'));

  mainWindow.on('closed', () => {
    closeAllNativeBrowsers();
    terminalManager.closeAll();
    clearTerminalSubscriptions();
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('bridge-info', () => {
    ensureSidecar();
    return bridge;
  });
  ipcMain.handle('pick-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('notify', (_event, { title, body }) => {
    new Notification({ title, body }).show();
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
  ipcMain.handle('git-mark-turn-start', (_event, { dir, sessionId }) =>
    gitVcs.markTurnStart(dir, sessionId),
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

  ipcMain.handle('github-available', () => githubVcs.available());
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
  ipcMain.handle('app-check-update', checkAppUpdate);
  ipcMain.handle('app-download-update', (_e, dmgUrl) => downloadAppUpdate(dmgUrl));
  ipcMain.handle('app-relaunch', () => relaunchApp());
  ipcMain.handle('open-external', (_event, { url }) => openExternal(url));

  ipcMain.handle('terminal-create', (event, args) => {
    assertMainRenderer(event);
    return terminalManager.create({
      missionId: args?.missionId,
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
    unsubscribeTerminal(event.sender, id);
    terminalManager.kill(id);
  });
  ipcMain.handle('terminal-list', (event, filter) => {
    assertMainRenderer(event);
    return terminalManager.list({ missionId: filter?.missionId });
  });
  ipcMain.handle('terminal-subscribe', (event, { id }) => {
    assertMainRenderer(event);
    subscribeTerminal(event.sender, id);
  });
  ipcMain.handle('terminal-unsubscribe', (event, { id }) => {
    assertMainRenderer(event);
    unsubscribeTerminal(event.sender, id);
  });
  ipcMain.handle('files-list', (event, { root, relative }) => {
    assertMainRenderer(event);
    return files.listDirectory(root, relative);
  });
  ipcMain.handle('files-preview', (event, { root, relative }) => {
    assertMainRenderer(event);
    return files.readPreview(root, relative);
  });
  ipcMain.handle('files-open', (event, { root, relative }) => {
    assertMainRenderer(event);
    return files.openDefault(root, relative, shell);
  });
  ipcMain.handle('files-reveal', (event, { root, relative }) => {
    assertMainRenderer(event);
    return files.revealInFolder(root, relative, shell);
  });

  ipcMain.handle('native-browser-open', (_event, { sessionId, url, bounds, viewport }) =>
    openNativeBrowser(sessionId, url, bounds, viewport),
  );
  ipcMain.handle('native-browser-attach', (_event, { sessionId, bounds, url }) =>
    attachNativeBrowser(sessionId, bounds, { restoreUrl: url }),
  );
  ipcMain.handle('native-browser-detach', (_event, { sessionId }) =>
    detachNativeBrowser(sessionId),
  );
  ipcMain.handle('native-browser-set-bounds', (_event, { sessionId, bounds }) =>
    setNativeBrowserBounds(sessionId, bounds),
  );
  ipcMain.handle('native-browser-visible', (_event, { sessionId, visible }) =>
    setNativeBrowserVisible(sessionId, visible),
  );
  ipcMain.handle('native-browser-close', (_event, { sessionId }) => closeNativeBrowser(sessionId));
  ipcMain.handle('native-browser-reload', (_event, { sessionId }) =>
    reloadNativeBrowser(sessionId),
  );
  ipcMain.handle('native-browser-go-back', (_event, { sessionId }) =>
    navigateNativeBrowserHistory(sessionId, 'back'),
  );
  ipcMain.handle('native-browser-go-forward', (_event, { sessionId }) =>
    navigateNativeBrowserHistory(sessionId, 'forward'),
  );
  ipcMain.handle('native-browser-set-design-mode', (_event, { sessionId, active }) =>
    setNativeBrowserDesignMode(sessionId, active),
  );
  ipcMain.handle('native-browser-set-pencil-mode', (_event, { sessionId, active }) =>
    setNativeBrowserPencilMode(sessionId, active),
  );
  ipcMain.handle('native-browser-agent-action', (_event, { request }) =>
    runNativeBrowserAgentAction(request),
  );
  ipcMain.handle('native-browser-capture', (_event, { sessionId, box, options }) =>
    captureNativeBrowser(sessionId, box, options),
  );

  ipcMain.on('native-browser-selection', (event, selection) => {
    mainWindow?.webContents.send(
      'native-browser-selection',
      withNativeBrowserSession(event, selection),
    );
  });
  ipcMain.on('native-browser-design-prompt', async (event, payload) => {
    const sessionId = nativeBrowserSessionIdForWebContents(event.sender);
    let selection = { ...payload.selection, sessionId };
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
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Desktop request rejected for unknown renderer.');
  }
}

function subscribeTerminal(sender, terminalId) {
  unsubscribeTerminal(sender, terminalId);
  let subscriptions = terminalSubscriptions.get(sender.id);
  if (!subscriptions) {
    subscriptions = new Map();
    terminalSubscriptions.set(sender.id, subscriptions);
    sender.once('destroyed', () => clearTerminalSubscriptions(sender.id));
  }
  const unsubscribe = terminalManager.subscribe(terminalId, (payload) => {
    if (!sender.isDestroyed()) {
      sender.send('terminal-event', { terminalId, ...payload });
    }
  });
  subscriptions.set(terminalId, unsubscribe);
}

function unsubscribeTerminal(sender, terminalId) {
  const subscriptions = terminalSubscriptions.get(sender.id);
  const unsubscribe = subscriptions?.get(terminalId);
  if (unsubscribe) unsubscribe();
  subscriptions?.delete(terminalId);
  if (subscriptions?.size === 0) terminalSubscriptions.delete(sender.id);
}

function clearTerminalSubscriptions(senderId) {
  const entries =
    senderId === undefined
      ? [...terminalSubscriptions.entries()]
      : [[senderId, terminalSubscriptions.get(senderId)]];
  for (const [id, subscriptions] of entries) {
    if (!subscriptions) continue;
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    terminalSubscriptions.delete(id);
  }
}

function installApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const reloadItem = () => ({
    label: 'Reload Droid Control',
    accelerator: 'CmdOrCtrl+R',
    click: () => reloadShell(false),
  });
  const forceReloadItem = () => ({
    label: 'Force Reload Droid Control',
    accelerator: 'CmdOrCtrl+Shift+R',
    click: () => reloadShell(true),
  });
  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              reloadItem(),
              forceReloadItem(),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [reloadItem(), forceReloadItem(), { type: 'separator' }, { role: 'toggleDevTools' }],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function reloadShell(ignoreCache) {
  detachNativeBrowser();
  if (!isWindowUsable(mainWindow)) return;
  if (ignoreCache) mainWindow.webContents.reloadIgnoringCache();
  else mainWindow.webContents.reload();
}

function appRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
}

function sidecarEntry() {
  return process.env.SIDECAR_ENTRY || path.join(appRoot(), 'sidecar/dist/sidecar.mjs');
}

function nodeBin() {
  if (process.env.NODE_BIN) return process.env.NODE_BIN;
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'node';
}

function ensureSidecar() {
  if (sidecar && sidecar.exitCode === null && sidecar.signalCode === null) return;
  sidecar = spawn(nodeBin(), [sidecarEntry()], {
    cwd: appRoot(),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      BRIDGE_PORT: String(bridge.port),
      BRIDGE_TOKEN: bridge.token,
      BRIDGE_EXIT_ON_STDIN_CLOSE: '0',
      BRIDGE_ALLOW_LOCAL_NO_TOKEN: app.isPackaged ? '0' : '1',
    },
  });
  sidecar.on('exit', (code, signal) => {
    if (code || signal) console.error(`sidecar exited: ${code ?? signal}`);
  });
}

function stopSidecar() {
  if (!sidecar || sidecar.killed) return;
  sidecar.kill();
  sidecar = null;
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
        title: 'Save logins in Droid Control?',
        message: 'Let Droid Control securely save logins for its browser?',
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
      detail:
        'Droid Control stores it encrypted with your OS keychain. The agent can use it to sign in but can never read it.',
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

function ensureNativeBrowserEntry(sessionId) {
  sessionId = normalizeNativeBrowserSessionId(sessionId);
  let entry = nativeBrowsers.get(sessionId);
  if (!entry) {
    entry = createNativeBrowserEntry(sessionId);
    nativeBrowsers.set(sessionId, entry);
  }
  clearNativeBrowserIdleTimer(entry);
  return entry;
}

function createNativeBrowserEntry(sessionId) {
  return {
    sessionId,
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
  };
}

function ensureNativeBrowserView(sessionId) {
  const entry = ensureNativeBrowserEntry(sessionId);
  if (isBrowserViewUsable(entry.view)) return entry;
  if (!isWindowUsable(mainWindow)) throw new Error('Droid Control window is not available.');
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
    applyNativeBrowserDesignState(entry);
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
    if (entry.view === view) applyNativeBrowserDesignState(entry);
  });
  contents.on('destroyed', () => {
    if (entry.view === view) {
      entry.view = null;
      entry.attached = false;
      entry.windowAttached = false;
      entry.hostWindow = null;
      if (attachedBrowserSessionId === entry.sessionId) attachedBrowserSessionId = null;
    }
  });
  contents.on('did-navigate-in-page', (_event, nextUrl) => {
    if (entry.view !== view) return;
    entry.targetUrl = nextUrl;
    emitNativeBrowserLoaded(entry, nextUrl);
    applyNativeBrowserDesignState(entry);
  });
  return entry;
}

async function openNativeBrowser(sessionId, url, bounds, viewport) {
  const entry = ensureNativeBrowserView(sessionId);
  rejectHostAppUrl(url);
  url = normalizeNativeBrowserUrl(entry, url);
  validateUrl(url);
  if (bounds) await attachNativeBrowser(entry.sessionId, bounds, { restore: false });
  else {
    setHiddenNativeBrowserBounds(entry, viewport);
    addHiddenNativeBrowserViewToWindow(entry);
  }
  await loadNativeBrowserUrl(entry, url, { force: true });
  scheduleNativeBrowserIdleClose(entry);
}

async function attachNativeBrowser(sessionId, bounds, options = {}) {
  const entry = ensureNativeBrowserView(sessionId);
  if (!isWindowUsable(mainWindow)) throw new Error('Droid Control window is not available.');
  if (attachedBrowserSessionId && attachedBrowserSessionId !== entry.sessionId) {
    detachNativeBrowser(attachedBrowserSessionId);
  }
  const view = entry.view;
  if (!view) throw new Error('Droid Control browser is not open.');
  attachNativeBrowserViewToMainWindow(entry);
  attachedBrowserSessionId = entry.sessionId;
  entry.attached = true;
  view.setBounds(normalizeBounds(bounds));
  clearNativeBrowserIdleTimer(entry);
  applyNativeBrowserDesignState(entry);
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

function detachNativeBrowser(sessionId) {
  const targetSessionId = sessionId ?? attachedBrowserSessionId;
  if (!targetSessionId) return;
  const entry = nativeBrowsers.get(targetSessionId);
  if (!entry) return;
  if (attachedBrowserSessionId === targetSessionId) attachedBrowserSessionId = null;
  entry.attached = false;
  safeWebContents(entry.view)?.setBackgroundThrottling(true);
  setHiddenNativeBrowserBounds(entry);
  removeNativeBrowserViewFromWindow(entry, entry.view);
  scheduleNativeBrowserIdleClose(entry);
}

function setNativeBrowserBounds(sessionId, bounds) {
  const entry = nativeBrowsers.get(normalizeNativeBrowserSessionId(sessionId));
  if (!entry || !isBrowserViewUsable(entry.view)) return;
  entry.view.setBounds(normalizeBounds(bounds));
}

function setNativeBrowserVisible(sessionId, visible) {
  const entry = ensureNativeBrowserEntry(sessionId);
  entry.visible = Boolean(visible);
  if (!isBrowserViewUsable(entry.view) || !entry.attached) return;
  entry.view.setVisible(entry.visible);
  safeWebContents(entry.view)?.setBackgroundThrottling(!entry.visible);
}

function closeNativeBrowser(sessionId) {
  const entry = nativeBrowsers.get(normalizeNativeBrowserSessionId(sessionId));
  if (entry) closeNativeBrowserEntry(entry, true);
}

function reloadNativeBrowser(sessionId) {
  const entry = nativeBrowsers.get(normalizeNativeBrowserSessionId(sessionId));
  const contents = safeWebContents(entry?.view);
  if (!contents) throw new Error('Droid Control browser is not open.');
  entry.targetUrl = contents.getURL();
  contents.reload();
}

function navigateNativeBrowserHistory(sessionId, direction) {
  const entry = nativeBrowsers.get(normalizeNativeBrowserSessionId(sessionId));
  const contents = safeWebContents(entry?.view);
  if (!contents) throw new Error('Droid Control browser is not open.');
  const history = contents.navigationHistory;
  if (direction === 'back') {
    if (!history.canGoBack()) return false;
    history.goBack();
  } else {
    if (!history.canGoForward()) return false;
    history.goForward();
  }
  return true;
}

function setNativeBrowserDesignMode(sessionId, active) {
  const entry = ensureNativeBrowserEntry(sessionId);
  const next = Boolean(active);
  if (entry.state.designMode === next) return;
  entry.state.designMode = next;
  if (!entry.state.designMode) entry.state.pencilMode = false;
  return applyNativeBrowserDesignState(entry);
}

function setNativeBrowserPencilMode(sessionId, active) {
  const entry = ensureNativeBrowserEntry(sessionId);
  const next = entry.state.designMode && Boolean(active);
  if (entry.state.pencilMode === next) return;
  entry.state.pencilMode = next;
  return applyNativeBrowserDesignState(entry);
}

async function runNativeBrowserAgentAction(request) {
  const entry = await restoreNativeBrowserForAction(request.sessionId);
  const contents = safeWebContents(entry.view);
  if (!contents) throw new Error('Droid Control browser is not open.');
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
      if (!navigation.started() || !isNavigationExecutionError(outcome.error)) throw outcome.error;
      await navigation.wait();
      return await snapshotNativeBrowserAfterNavigation(contents, request);
    }
    return withNativeBrowserHistory(contents, outcome.result);
  } finally {
    navigation.dispose();
    if (!entry.attached) contents.setBackgroundThrottling(true);
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
  const history = contents.navigationHistory;
  if (!result.snapshot) return result;
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
      error:
        'Saved logins are turned off for the Droid Control browser. Ask the user to sign in once; they will be prompted to enable and save the login first.',
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

async function captureNativeBrowser(sessionId, box, options = {}) {
  const entry = await restoreNativeBrowserForAction(sessionId);
  const contents = safeWebContents(entry.view);
  if (!contents) throw new Error('Droid Control browser is not open.');
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
    if (!entry.attached) contents.setBackgroundThrottling(true);
    scheduleNativeBrowserIdleClose(entry);
  }
}

async function captureNativeBrowserViaCdp(contents, { fullPage, scale, box }) {
  const dbg = contents.debugger;
  if (!dbg) return undefined;
  let attached = false;
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      attached = true;
    }
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
  } finally {
    if (attached) {
      try {
        dbg.detach();
      } catch {
        /* already detached */
      }
    }
  }
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
    sessionId: entry.sessionId,
    url,
    canGoBack: history?.canGoBack() ?? false,
    canGoForward: history?.canGoForward() ?? false,
  });
}

function emitNativeBrowserLoadFailed(entry, url, error) {
  if (!isWindowUsable(mainWindow)) return;
  mainWindow.webContents.send('native-browser-load-failed', {
    sessionId: entry.sessionId,
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

async function restoreNativeBrowserForAction(sessionId) {
  const entry = ensureNativeBrowserView(sessionId);
  if (!entry.attached) {
    setHiddenNativeBrowserBounds(entry);
    addHiddenNativeBrowserViewToWindow(entry);
  }
  if (entry.targetUrl) await loadNativeBrowserUrl(entry, entry.targetUrl);
  return entry;
}

function attachNativeBrowserViewToMainWindow(entry) {
  if (!entry.view || !isWindowUsable(mainWindow)) return;
  if (entry.windowAttached && entry.hostWindow !== mainWindow)
    removeNativeBrowserViewFromWindow(entry, entry.view);
  // addChildView is idempotent and raises the view to the top of the stack.
  mainWindow.contentView.addChildView(entry.view);
  entry.view.setVisible(entry.visible);
  safeWebContents(entry.view)?.setBackgroundThrottling(!entry.visible);
  entry.windowAttached = true;
  entry.hostWindow = mainWindow;
}

function addHiddenNativeBrowserViewToWindow(entry) {
  if (!entry.view) return;
  const host = ensureHiddenNativeBrowserWindow();
  if (entry.windowAttached && entry.hostWindow !== host)
    removeNativeBrowserViewFromWindow(entry, entry.view);
  if (entry.windowAttached) return;
  const bounds = entry.view.getBounds();
  host.setContentSize(Math.max(1, bounds.width), Math.max(1, bounds.height));
  host.contentView.addChildView(entry.view);
  entry.windowAttached = true;
  entry.hostWindow = host;
}

function removeNativeBrowserViewFromWindow(entry, view) {
  const host = entry.hostWindow ?? mainWindow;
  if (!view || !isWindowUsable(host)) {
    entry.windowAttached = false;
    entry.hostWindow = null;
    return;
  }
  try {
    host.contentView.removeChildView(view);
  } catch {
    // The window may already be tearing down; Electron destroys attached views with it.
  }
  entry.windowAttached = false;
  entry.hostWindow = null;
  if (host === hiddenNativeBrowserWindow) closeHiddenNativeBrowserWindowIfUnused();
}

function setHiddenNativeBrowserBounds(entry, viewport) {
  if (!isBrowserViewUsable(entry.view)) return;
  const width = Math.max(1, Math.round(Number(viewport?.width) || 1200));
  const height = Math.max(1, Math.round(Number(viewport?.height) || 800));
  entry.view.setBounds({ x: 0, y: 0, width, height });
  if (entry.hostWindow === hiddenNativeBrowserWindow && isWindowUsable(hiddenNativeBrowserWindow)) {
    hiddenNativeBrowserWindow.setContentSize(width, height);
  }
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
  if (attachedBrowserSessionId === entry.sessionId) attachedBrowserSessionId = null;
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
  if (forget) nativeBrowsers.delete(entry.sessionId);
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
    transparent: true,
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

function normalizeNativeBrowserSessionId(sessionId) {
  const value = String(sessionId || '').trim();
  if (!value) throw new Error('Droid Control browser session id is required.');
  return value;
}

function restorableUrlForEntry(entry, url) {
  if (!url) return undefined;
  const value = normalizeNativeBrowserUrl(entry, url);
  return value === 'about:blank' || isChromeErrorUrl(value) ? undefined : value;
}

function nativeBrowserSessionIdForWebContents(contents) {
  return findNativeBrowserEntryForWebContents(contents)?.sessionId;
}

function withNativeBrowserSession(event, payload) {
  return { ...payload, sessionId: nativeBrowserSessionIdForWebContents(event.sender) };
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
      'Cannot open the Droid Control shell inside its own browser pane. Use a different local app port.',
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

// ── App self-update ─────────────────────────────────────────────────
// Managed per-arch .dmg download against a configurable host; falls back to
// the Squirrel autoUpdater when an update feed is configured.
const DOWNLOAD_BASE = (process.env.DROID_DOWNLOAD_BASE || 'https://droidex.app').replace(/\/$/, '');
const UPDATE_FEED = process.env.DROID_UPDATE_FEED || '';

function macDmgName() {
  return process.arch === 'arm64' ? 'droidex-arm64.dmg' : 'droidex-x64.dmg';
}

async function checkAppUpdate() {
  const current = app.getVersion();
  try {
    const res = await fetch(`${DOWNLOAD_BASE}/downloads/latest.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const manifest = await res.json();
    const latest = String(manifest.version || '');
    const dmgUrl =
      process.platform === 'darwin'
        ? manifest.mac?.[process.arch] || `${DOWNLOAD_BASE}/downloads/${macDmgName()}`
        : undefined;
    return {
      current,
      latest,
      updateAvailable: latest ? compareSemverParts(latest, current) > 0 : false,
      arch: process.arch,
      platform: process.platform,
      dmgUrl,
      feedConfigured: Boolean(UPDATE_FEED),
    };
  } catch {
    return {
      current,
      latest: '',
      updateAvailable: false,
      arch: process.arch,
      platform: process.platform,
      feedConfigured: Boolean(UPDATE_FEED),
    };
  }
}

async function downloadAppUpdate(dmgUrl) {
  if (UPDATE_FEED && process.platform === 'darwin') {
    try {
      // Await the actual feed outcome so the renderer only reports success once
      // the build is downloaded (or up to date), not right after kicking off
      // the check.
      return await runAutoUpdater();
    } catch (err) {
      console.warn(
        '[update] autoUpdater failed, falling back to managed download:',
        err?.message || err,
      );
      /* fall through to managed download */
    }
  }
  if (process.platform !== 'darwin') {
    await openExternal(`${DOWNLOAD_BASE}/download`);
    return { mode: 'external' };
  }
  return managedMacDownload(dmgUrl);
}

// Resolves when the feed reports a downloaded update (then relaunches) or that
// we're up to date; rejects on feed/network errors so the caller can fall back.
function runAutoUpdater() {
  return new Promise((resolve, reject) => {
    const { autoUpdater } = require('electron');
    autoUpdater.setFeedURL({ url: UPDATE_FEED });
    autoUpdater.removeAllListeners('error');
    autoUpdater.removeAllListeners('update-downloaded');
    autoUpdater.removeAllListeners('update-not-available');
    autoUpdater.once('update-downloaded', () => {
      resolve({ mode: 'autoUpdater', status: 'downloaded' });
      autoUpdater.quitAndInstall();
    });
    autoUpdater.once('update-not-available', () =>
      resolve({ mode: 'autoUpdater', status: 'up-to-date' }),
    );
    autoUpdater.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
    autoUpdater.checkForUpdates();
  });
}

// The renderer relays the manifest-selected URL, so it cannot be trusted on its
// own. Only allow HTTPS downloads from the update host(s) we control: the
// download base, an optional autoUpdater feed, and any explicitly configured
// CDN hosts. Anything else is rejected so a compromised renderer can't make the
// main process fetch and launch an arbitrary payload.
function trustedUpdateHosts() {
  const hosts = new Set();
  const add = (base) => {
    try {
      hosts.add(new URL(base).host);
    } catch {
      /* ignore */
    }
  };
  add(DOWNLOAD_BASE);
  if (UPDATE_FEED) add(UPDATE_FEED);
  for (const host of (process.env.DROID_UPDATE_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    hosts.add(host);
  }
  return hosts;
}

function assertTrustedDmgUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('refusing malformed update URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('refusing non-HTTPS update URL');
  if (!trustedUpdateHosts().has(parsed.host))
    throw new Error(`refusing update from untrusted host: ${parsed.host}`);
  return parsed;
}

async function managedMacDownload(dmgUrl) {
  // Honor the manifest-selected artifact (versioned/CDN/arch-specific) so we
  // never advertise one update then fetch a different default file.
  const parsed = assertTrustedDmgUrl(dmgUrl || `${DOWNLOAD_BASE}/downloads/${macDmgName()}`);
  const url = parsed.toString();
  const fileName = path.basename(parsed.pathname) || macDmgName();
  const dest = path.join(app.getPath('downloads'), fileName);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buffer);
  shell.showItemInFolder(dest);
  // openPath resolves with a non-empty error string (it doesn't reject) when
  // the OS can't launch the file, so treat that as a failure.
  const openError = await shell.openPath(dest);
  if (openError) throw new Error(`could not open downloaded update: ${openError}`);
  return { mode: 'download', path: dest };
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

// Compare two dotted versions: positive when a > b.
function compareSemverParts(a, b) {
  const pa = String(a).match(/\d+/g)?.map(Number) ?? [];
  const pb = String(b).match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
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
  const dir = path.join(app.getPath('temp'), 'droid-control-diffs');
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
