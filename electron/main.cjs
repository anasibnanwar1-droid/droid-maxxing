const { app, BrowserView, BrowserWindow, Menu, Notification, dialog, ipcMain, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const APP_NAME = 'Droid Control';
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 8765);
const bridge = { port: BRIDGE_PORT, token: crypto.randomBytes(16).toString('hex') };

let mainWindow = null;
let sidecar = null;
let browserView = null;
let browserTargetUrl = null;
let browserState = { designMode: false, sketchMode: false };

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
    resetNativeBrowser();
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

  ipcMain.handle('native-browser-open', (_event, { url, bounds }) => openNativeBrowser(url, bounds));
  ipcMain.handle('native-browser-set-bounds', (_event, { bounds }) => setNativeBrowserBounds(bounds));
  ipcMain.handle('native-browser-close', closeNativeBrowser);
  ipcMain.handle('native-browser-reload', reloadNativeBrowser);
  ipcMain.handle('native-browser-set-design-mode', (_event, { active }) => setNativeBrowserDesignMode(active));
  ipcMain.handle('native-browser-set-sketch-mode', (_event, { active }) => setNativeBrowserSketchMode(active));
  ipcMain.handle('native-browser-agent-action', (_event, { request }) => runNativeBrowserAgentAction(request));

  ipcMain.on('native-browser-selection', (_event, selection) => {
    mainWindow?.webContents.send('native-browser-selection', selection);
  });
  ipcMain.on('native-browser-design-prompt', (_event, payload) => {
    mainWindow?.webContents.send('native-browser-design-prompt', payload);
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
  closeNativeBrowser();
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

function ensureNativeBrowserView() {
  if (isBrowserViewUsable(browserView)) return browserView;
  resetNativeBrowser();
  if (!isWindowUsable(mainWindow)) throw new Error('Droid Control window is not available.');
  browserView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'nativeBrowserPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const view = browserView;
  const contents = view.webContents;
  contents.setWindowOpenHandler(({ url: nextUrl }) => {
    if (browserView === view) loadNativeBrowserUrl(view, nextUrl);
    return { action: 'deny' };
  });
  contents.on('did-finish-load', () => {
    const current = safeWebContents(view);
    if (browserView !== view || !current) return;
    const loadedUrl = current.getURL();
    if (isChromeErrorUrl(loadedUrl)) {
      if (browserTargetUrl && !isChromeErrorUrl(browserTargetUrl)) emitNativeBrowserLoaded(browserTargetUrl);
      return;
    }
    browserTargetUrl = loadedUrl;
    emitNativeBrowserLoaded(loadedUrl);
    applyNativeBrowserDesignState();
  });
  contents.on('destroyed', () => {
    if (browserView === view) resetNativeBrowser();
  });
  contents.on('did-navigate-in-page', (_event, nextUrl) => {
    if (browserView === view) emitNativeBrowserLoaded(nextUrl);
  });
  mainWindow.setBrowserView(view);
  return view;
}

function openNativeBrowser(url, bounds) {
  url = normalizeNativeBrowserUrl(url);
  validateUrl(url);
  const view = ensureNativeBrowserView();
  view.setBounds(normalizeBounds(bounds));
  loadNativeBrowserUrl(view, url);
}

function setNativeBrowserBounds(bounds) {
  if (!isBrowserViewUsable(browserView)) return;
  browserView.setBounds(normalizeBounds(bounds));
}

function closeNativeBrowser() {
  browserState = { designMode: false, sketchMode: false };
  browserTargetUrl = null;
  const view = browserView;
  browserView = null;
  if (!view) return;
  if (isWindowUsable(mainWindow)) {
    try {
      mainWindow.removeBrowserView(view);
    } catch {
      // The window may already be tearing down; Electron destroys attached views with it.
    }
  }
  const contents = safeWebContents(view);
  if (!contents) return;
  try {
    contents.close({ waitForBeforeUnload: false });
  } catch {
    // Already destroyed by Electron window teardown.
  }
}

function reloadNativeBrowser() {
  const contents = safeWebContents(browserView);
  if (!contents) throw new Error('Droid Control browser is not open.');
  browserTargetUrl = contents.getURL();
  contents.reload();
}

function setNativeBrowserDesignMode(active) {
  browserState.designMode = Boolean(active);
  if (!browserState.designMode) browserState.sketchMode = false;
  return applyNativeBrowserDesignState();
}

function setNativeBrowserSketchMode(active) {
  browserState.sketchMode = browserState.designMode && Boolean(active);
  return applyNativeBrowserDesignState();
}

function runNativeBrowserAgentAction(request) {
  const contents = safeWebContents(browserView);
  if (!contents) throw new Error('Droid Control browser is not open.');
  return contents.executeJavaScript(
    `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify(request)});`,
    true,
  );
}

function applyNativeBrowserDesignState() {
  const contents = safeWebContents(browserView);
  if (!contents) return undefined;
  return contents.executeJavaScript(
    `window.__DROIDMAXX_APPLY_DESIGN_STATE?.(${JSON.stringify(browserState)});`,
    true,
  ).catch((err) => console.error(`failed to apply browser design state: ${err.message}`));
}

function emitNativeBrowserLoaded(url) {
  if (!isWindowUsable(mainWindow)) return;
  mainWindow.webContents.send('native-browser-loaded', { url });
}

function loadNativeBrowserUrl(view, url) {
  url = normalizeNativeBrowserUrl(url);
  const contents = safeWebContents(view);
  if (!contents) return;
  if (contents.getURL() === url || browserTargetUrl === url) return;
  browserTargetUrl = url;
  contents.loadURL(url).catch((err) => {
    if (browserTargetUrl === url) browserTargetUrl = null;
    if (!contents.isDestroyed()) console.error(`failed to load native browser URL: ${err.message}`);
  });
}

function resetNativeBrowser() {
  browserView = null;
  browserTargetUrl = null;
  browserState = { designMode: false, sketchMode: false };
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

function normalizeNativeBrowserUrl(url) {
  const value = String(url || 'about:blank');
  if (isHostAppUrl(value)) return 'about:blank';
  if (!isChromeErrorUrl(value)) return value;
  return browserTargetUrl && !isChromeErrorUrl(browserTargetUrl) ? browserTargetUrl : 'about:blank';
}

function isChromeErrorUrl(url) {
  return String(url || '').startsWith('chrome-error://');
}

function isHostAppUrl(url) {
  const hostOrigin = originOf(process.env.ELECTRON_START_URL || mainWindow?.webContents.getURL());
  const targetOrigin = originOf(url);
  return Boolean(hostOrigin && targetOrigin && hostOrigin === targetOrigin);
}

function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
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

function expandHome(value) {
  if (!value.startsWith('~/')) return value;
  return path.join(app.getPath('home'), value.slice(2));
}
