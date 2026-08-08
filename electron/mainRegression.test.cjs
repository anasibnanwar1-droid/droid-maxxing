const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

test('native browser invoke handlers authorize the main renderer', () => {
  const channels = [
    'native-browser-open',
    'native-browser-attach',
    'native-browser-detach',
    'native-browser-set-bounds',
    'native-browser-visible',
    'native-browser-close',
    'native-browser-reload',
    'native-browser-go-back',
    'native-browser-go-forward',
    'native-browser-set-design-mode',
    'native-browser-set-pencil-mode',
    'native-browser-agent-action',
    'native-browser-capture',
  ];

  for (const channel of channels) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    assert.notEqual(start, -1, `missing ${channel} handler`);
    const nextHandle = mainSource.indexOf('\n  ipcMain.handle(', start + 1);
    const nextListener = mainSource.indexOf('\n  ipcMain.on(', start + 1);
    const end = Math.min(
      ...[nextHandle, nextListener, mainSource.length].filter((index) => index >= 0),
    );
    assert.match(
      mainSource.slice(start, end),
      /assertMainRenderer\(event\)/,
      `${channel} must authorize its sender`,
    );
  }
});

test('main renderer reload closes renderer-owned terminals before navigation', () => {
  const closeRendererOwnedTerminals =
    /function closeRendererOwnedTerminals\(\) \{\s*terminalSubscriptions\.clear\(\);\s*terminalManager\.closeAll\(\);\s*\}/;
  const willFrameNavigateCleanup =
    /contents\.on\('will-frame-navigate', \(_event, _url, isInPlace, isMainFrame\) => \{\s*if \(isMainFrame && !isInPlace\) cleanupForRendererReplacement\(\);\s*\}\);/;
  const didStartNavigationCleanup =
    /contents\.on\('did-start-navigation', \(_event, _url, isInPlace, isMainFrame\) => \{\s*if \(isMainFrame && !isInPlace\) cleanupForRendererReplacement\(\);\s*\}\);/;
  const explicitReloadCleanup =
    /function reloadShell\(ignoreCache\) \{\s*detachNativeBrowser\(\);\s*if \(!isWindowUsable\(mainWindow\)\) return;\s*closeRendererOwnedTerminals\(\);/;

  assert.match(mainSource, /installMainRendererLifecycle\(mainWindow\.webContents\)/);
  assert.match(mainSource, closeRendererOwnedTerminals);
  assert.match(mainSource, willFrameNavigateCleanup);
  assert.match(mainSource, didStartNavigationCleanup);
  assert.match(mainSource, /contents\.on\('render-process-gone', cleanupForRendererReplacement\)/);
  assert.match(mainSource, explicitReloadCleanup);
});

test('sidecar lifecycle is delegated to the packaged-runtime supervisor', () => {
  assert.match(mainSource, /createSidecarSupervisor\(\{/);
  assert.match(mainSource, /entryPath: sidecarEntry/);
  assert.match(mainSource, /sidecarSupervisor\.getBridgeInfo\(\)/);
  assert.doesNotMatch(mainSource, /NODE_BIN|function nodeBin/);
});

test('bridge credentials require the top-level trusted renderer', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('bridge-info'");
  const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
  const handler = mainSource.slice(handlerStart, handlerEnd);

  assert.notEqual(handlerStart, -1);
  assert.match(handler, /assertMainRenderer\(event\)/);
  assert.match(mainSource, /event\.senderFrame !== mainWindow\.webContents\.mainFrame/);
  assert.match(mainSource, /installRendererNavigationGuard\(mainWindow\.webContents/);
});

test('manual feedback reports require the trusted renderer', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('feedback-report'");
  const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
  const handler = mainSource.slice(handlerStart, handlerEnd);

  assert.notEqual(handlerStart, -1);
  assert.match(handler, /assertMainRenderer\(event\)/);
  assert.match(handler, /diagnostics\.reportFeedback\(report,/);
});

test('GitHub setup handlers require the trusted renderer and teardown their process', () => {
  for (const channel of [
    'github-available',
    'github-install',
    'github-authenticate',
    'github-cancel-setup',
  ]) {
    const handlerStart = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
    assert.notEqual(handlerStart, -1, `missing ${channel} handler`);
    assert.match(
      mainSource.slice(handlerStart, handlerEnd),
      /assertMainRenderer\(event\)/,
      `${channel} must authorize its sender`,
    );
  }

  const authenticateStart = mainSource.indexOf("ipcMain.handle('github-authenticate'");
  const authenticateEnd = mainSource.indexOf('\n  ipcMain.handle(', authenticateStart + 1);
  const authenticateHandler = mainSource.slice(authenticateStart, authenticateEnd);
  assert.match(authenticateHandler, /onDeviceCode/);
  assert.match(authenticateHandler, /event\.sender\.send\('github-auth-code', \{ code \}\)/);

  assert.match(mainSource, /app\.on\('before-quit',[\s\S]*?githubVcs\.cancelSetup\(\)/);
  assert.match(
    mainSource,
    /const cleanupForRendererReplacement = \(\) => \{[\s\S]*?githubVcs\.cancelSetup\(\)/,
  );
});

test('diagnostics initialize before app readiness and preferences require the trusted renderer', () => {
  const initializeAt = mainSource.indexOf(
    'const diagnosticsInitialization = diagnostics.initialize();',
  );
  const readyAt = mainSource.indexOf('app.whenReady().then(async () =>');
  assert.ok(initializeAt > 0 && initializeAt < readyAt);
  assert.match(mainSource, /await diagnosticsInitialization;\s*installApplicationMenu/);

  for (const channel of ['diagnostics-preference-get', 'diagnostics-preference-set']) {
    const handlerStart = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
    assert.notEqual(handlerStart, -1);
    assert.match(mainSource.slice(handlerStart, handlerEnd), /assertMainRenderer\(event\)/);
  }
  const preferenceHandlerStart = mainSource.indexOf("ipcMain.handle('diagnostics-preference-set'");
  const preferenceHandlerEnd = mainSource.indexOf(
    '\n  ipcMain.handle(',
    preferenceHandlerStart + 1,
  );
  const preferenceHandler = mainSource.slice(preferenceHandlerStart, preferenceHandlerEnd);
  assert.match(preferenceHandler, /return diagnostics\.setAutomaticDiagnosticsEnabled\(enabled\)/);
  assert.doesNotMatch(preferenceHandler, /relaunchApp/);
});

test('embedded websites cannot request unused system permissions', () => {
  assert.match(mainSource, /ses\.setDevicePermissionHandler\(\(\) => false\)/);
  assert.match(mainSource, /ses\.setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(
    mainSource,
    /ses\.setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/,
  );
});

test('app icon switching authorizes the renderer and accepts only committed icon modes', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('app-set-icon'");
  const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
  const handler = mainSource.slice(handlerStart, handlerEnd);

  assert.notEqual(handlerStart, -1);
  assert.match(handler, /assertMainRenderer\(event\)/);
  assert.match(handler, /setAppIcon\(payload\?\.mode\)/);
  assert.match(mainSource, /mode !== 'light' && mode !== 'dark' && mode !== 'system'/);
  assert.match(mainSource, /app\.dock\.setIcon\(iconPath\)/);
  assert.match(mainSource, /mainWindow\.setIcon\(iconPath\)/);
});

test('system app icon tracks the OS appearance and repaints on change', () => {
  assert.match(
    mainSource,
    /mode === 'dark' \|\| \(mode === 'system' && nativeTheme\.shouldUseDarkColors\)/,
  );
  assert.match(mainSource, /useDark \? 'icon-dark\.png' : 'icon\.png'/);
  assert.match(
    mainSource,
    /nativeTheme\.on\('updated', \(\) => \{\s*if \(appIconMode === 'system'\) applyAppIcon\(\);\s*\}\);/,
  );
});
