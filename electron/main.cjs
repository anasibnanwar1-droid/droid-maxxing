const { app, BrowserView, BrowserWindow, Menu, Notification, dialog, ipcMain, safeStorage, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'Droid Control';
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 8765);
const bridge = { port: BRIDGE_PORT, token: crypto.randomBytes(16).toString('hex') };

let mainWindow = null;
let hiddenNativeBrowserWindow = null;
let sidecar = null;
let attachedBrowserSessionId = null;
const nativeBrowsers = new Map();
const HIDDEN_BROWSER_IDLE_MS = Number(process.env.DROID_NATIVE_BROWSER_IDLE_MS ?? 300_000);

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
    return result.canceled ? null : result.filePaths[0] ?? null;
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
  ipcMain.handle('open-project', (_event, { dir, editor, target }) => openProject(dir, editor, target));

  ipcMain.handle('native-browser-open', (_event, { sessionId, url, bounds, viewport }) => openNativeBrowser(sessionId, url, bounds, viewport));
  ipcMain.handle('native-browser-attach', (_event, { sessionId, bounds, url }) => attachNativeBrowser(sessionId, bounds, { restoreUrl: url }));
  ipcMain.handle('native-browser-detach', (_event, { sessionId }) => detachNativeBrowser(sessionId));
  ipcMain.handle('native-browser-set-bounds', (_event, { sessionId, bounds }) => setNativeBrowserBounds(sessionId, bounds));
  ipcMain.handle('native-browser-close', (_event, { sessionId }) => closeNativeBrowser(sessionId));
  ipcMain.handle('native-browser-reload', (_event, { sessionId }) => reloadNativeBrowser(sessionId));
  ipcMain.handle('native-browser-set-design-mode', (_event, { sessionId, active }) => setNativeBrowserDesignMode(sessionId, active));
  ipcMain.handle('native-browser-set-sketch-mode', (_event, { sessionId, active }) => setNativeBrowserSketchMode(sessionId, active));
  ipcMain.handle('native-browser-agent-action', (_event, { request }) => runNativeBrowserAgentAction(request));

  ipcMain.on('native-browser-selection', (event, selection) => {
    mainWindow?.webContents.send('native-browser-selection', withNativeBrowserSession(event, selection));
  });
  ipcMain.on('native-browser-design-prompt', (event, payload) => {
    const sessionId = nativeBrowserSessionIdForWebContents(event.sender);
    mainWindow?.webContents.send('native-browser-design-prompt', {
      ...payload,
      selection: { ...payload.selection, sessionId },
    });
  });
  ipcMain.on('native-browser-agent-result', (_event, result) => {
    mainWindow?.webContents.send('native-browser-agent-result', result);
  });
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
      ? [{
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
        }]
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
      submenu: [
        reloadItem(),
        forceReloadItem(),
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
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
    state: { designMode: false, sketchMode: false },
    attached: false,
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
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'nativeBrowserPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
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
      if (entry.targetUrl && !isChromeErrorUrl(entry.targetUrl)) emitNativeBrowserLoaded(entry, entry.targetUrl);
      return;
    }
    entry.targetUrl = loadedUrl;
    emitNativeBrowserLoaded(entry, loadedUrl);
    applyNativeBrowserDesignState(entry);
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
    const targetUrl = restorableUrlForEntry(entry, entry.targetUrl) ?? restorableUrlForEntry(entry, options.restoreUrl);
    const currentUrl = safeWebContents(view)?.getURL() ?? '';
    if (targetUrl && (!currentUrl || currentUrl === 'about:blank' || isChromeErrorUrl(currentUrl))) {
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
  setHiddenNativeBrowserBounds(entry);
  removeNativeBrowserViewFromWindow(entry, entry.view);
  scheduleNativeBrowserIdleClose(entry);
}

function setNativeBrowserBounds(sessionId, bounds) {
  const entry = nativeBrowsers.get(normalizeNativeBrowserSessionId(sessionId));
  if (!entry || !isBrowserViewUsable(entry.view)) return;
  entry.view.setBounds(normalizeBounds(bounds));
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

function setNativeBrowserDesignMode(sessionId, active) {
  const entry = ensureNativeBrowserEntry(sessionId);
  entry.state.designMode = Boolean(active);
  if (!entry.state.designMode) entry.state.sketchMode = false;
  return applyNativeBrowserDesignState(entry);
}

function setNativeBrowserSketchMode(sessionId, active) {
  const entry = ensureNativeBrowserEntry(sessionId);
  entry.state.sketchMode = entry.state.designMode && Boolean(active);
  return applyNativeBrowserDesignState(entry);
}

async function runNativeBrowserAgentAction(request) {
  const entry = await restoreNativeBrowserForAction(request.sessionId);
  const contents = safeWebContents(entry.view);
  if (!contents) throw new Error('Droid Control browser is not open.');
  try {
    return await contents.executeJavaScript(
      `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify(request)});`,
      true,
    );
  } finally {
    scheduleNativeBrowserIdleClose(entry);
  }
}

function applyNativeBrowserDesignState(entry) {
  const contents = safeWebContents(entry?.view);
  if (!contents) return undefined;
  return contents.executeJavaScript(
    `window.__DROIDMAXX_APPLY_DESIGN_STATE?.(${JSON.stringify(entry.state)});`,
    true,
  ).catch((err) => console.error(`failed to apply browser design state: ${err.message}`));
}

function emitNativeBrowserLoaded(entry, url) {
  if (!isWindowUsable(mainWindow)) return;
  mainWindow.webContents.send('native-browser-loaded', { sessionId: entry.sessionId, url });
}

async function loadNativeBrowserUrl(entry, url, options = {}) {
  url = normalizeNativeBrowserUrl(entry, url);
  const contents = safeWebContents(entry.view);
  if (!contents) return;
  if (url === 'about:blank' && contents.getURL() === 'about:blank') return;
  if (!options.force && contents.getURL() === url) return;
  if (entry.loadingUrl === url && entry.loadingPromise) return entry.loadingPromise;
  entry.targetUrl = url;
  const load = contents.loadURL(url).catch((err) => {
    if (entry.targetUrl === url) entry.targetUrl = null;
    if (!contents.isDestroyed() && !isLoadAbortError(err)) console.error(`failed to load native browser URL: ${err.message}`);
  }).finally(() => {
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
  if (entry.windowAttached) removeNativeBrowserViewFromWindow(entry, entry.view);
  mainWindow.setBrowserView(entry.view);
  entry.windowAttached = true;
  entry.hostWindow = mainWindow;
  if (typeof mainWindow.setTopBrowserView === 'function') {
    mainWindow.setTopBrowserView(entry.view);
  }
}

function addHiddenNativeBrowserViewToWindow(entry) {
  if (!entry.view) return;
  const host = ensureHiddenNativeBrowserWindow();
  if (entry.windowAttached && entry.hostWindow !== host) removeNativeBrowserViewFromWindow(entry, entry.view);
  if (entry.windowAttached) return;
  const bounds = entry.view.getBounds();
  host.setContentSize(Math.max(1, bounds.width), Math.max(1, bounds.height));
  host.addBrowserView(entry.view);
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
    host.removeBrowserView(view);
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
  const inUse = [...nativeBrowsers.values()].some((entry) => entry.windowAttached && entry.hostWindow === hiddenNativeBrowserWindow);
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
  for (const entry of nativeBrowsers.values()) {
    if (safeWebContents(entry.view) === contents) return entry.sessionId;
  }
  return undefined;
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
    throw new Error('Cannot open the Droid Control shell inside its own browser pane. Use a different local app port.');
  }
}

function isChromeErrorUrl(url) {
  return String(url || '').startsWith('chrome-error://');
}

function isLoadAbortError(err) {
  return String(err?.code || '').includes('ERR_ABORTED') || String(err?.message || '').includes('ERR_ABORTED');
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

async function listFiles(dir) {
  const root = expandHome(dir);
  const rootStat = await fsp.stat(root);
  if (!rootStat.isDirectory()) throw new Error('not a directory');
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.cache', 'out']);
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
    execFile('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

function gitDiff(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && err.code !== 1) reject(err);
      else resolve(String(stdout));
    });
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
  if (text.startsWith('No commits yet on ')) return text.slice('No commits yet on '.length).trim() || null;
  const branch = text.split('...')[0].trim();
  if (!branch || branch === 'HEAD' || branch.startsWith('HEAD ')) return null;
  return branch;
}

function expandHome(value) {
  if (!value.startsWith('~/')) return value;
  return path.join(app.getPath('home'), value.slice(2));
}
