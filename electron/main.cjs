const { app, BrowserView, BrowserWindow, Notification, dialog, ipcMain, safeStorage } = require('electron');
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
let browserState = { designMode: false, sketchMode: false };

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));

app.whenReady().then(() => {
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
    trafficLightPosition: { x: 16, y: 18 },
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
    closeNativeBrowser();
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
  ipcMain.on('native-browser-agent-result', (_event, result) => {
    mainWindow?.webContents.send('native-browser-agent-result', result);
  });
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
  if (browserView) return browserView;
  browserView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'nativeBrowserPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const view = browserView;
  view.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    if (browserView === view) view.webContents.loadURL(nextUrl);
    return { action: 'deny' };
  });
  view.webContents.on('did-finish-load', () => {
    if (browserView !== view) return;
    emitNativeBrowserLoaded(view.webContents.getURL());
    applyNativeBrowserDesignState();
  });
  view.webContents.on('did-navigate-in-page', (_event, nextUrl) => {
    if (browserView === view) emitNativeBrowserLoaded(nextUrl);
  });
  mainWindow.setBrowserView(view);
  return view;
}

function openNativeBrowser(url, bounds) {
  validateUrl(url);
  const view = ensureNativeBrowserView();
  view.setBounds(normalizeBounds(bounds));
  if (view.webContents.getURL() !== url) view.webContents.loadURL(url);
  view.webContents.focus();
}

function setNativeBrowserBounds(bounds) {
  browserView?.setBounds(normalizeBounds(bounds));
}

function closeNativeBrowser() {
  browserState = { designMode: false, sketchMode: false };
  if (!browserView) return;
  mainWindow?.removeBrowserView(browserView);
  browserView.webContents.close({ waitForBeforeUnload: false });
  browserView = null;
}

function reloadNativeBrowser() {
  browserView?.webContents.reload();
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
  if (!browserView) throw new Error('Droid Control browser is not open.');
  return browserView.webContents.executeJavaScript(
    `window.__DROIDMAXX_AGENT_ACTION?.(${JSON.stringify(request)});`,
    true,
  );
}

function applyNativeBrowserDesignState() {
  if (!browserView) return undefined;
  return browserView.webContents.executeJavaScript(
    `window.__DROIDMAXX_APPLY_DESIGN_STATE?.(${JSON.stringify(browserState)});`,
    true,
  ).catch((err) => console.error(`failed to apply browser design state: ${err.message}`));
}

function emitNativeBrowserLoaded(url) {
  mainWindow?.webContents.send('native-browser-loaded', { url });
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
