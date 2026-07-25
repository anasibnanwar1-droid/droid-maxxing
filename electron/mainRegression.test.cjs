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

test('force reload does not reuse the Review accelerator', () => {
  assert.match(mainSource, /accelerator: 'CmdOrCtrl\+Alt\+R'/);
  assert.doesNotMatch(mainSource, /accelerator: 'CmdOrCtrl\+Shift\+R'/);
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
