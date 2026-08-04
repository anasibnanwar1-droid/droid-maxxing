const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HELP_URL,
  LATEST_RELEASE_URL,
  PRIVACY_SECURITY_PANE,
  createApplicationMenuTemplate,
  installApplicationMenu,
} = require('./applicationMenu.cjs');

function menuOptions(overrides = {}) {
  return {
    appName: 'DROIDEX',
    platform: 'darwin',
    isPackaged: true,
    reload() {},
    checkForUpdates() {},
    openPath() {},
    openExternal() {},
    ...overrides,
  };
}

function submenu(template, label) {
  return template.find((item) => item.label === label)?.submenu;
}

test('macOS menu exposes supported editing, reload, window, update, and help actions', () => {
  const template = createApplicationMenuTemplate(menuOptions());

  assert.deepEqual(
    template.map((item) => item.label || item.role),
    ['DROIDEX', 'File', 'Edit', 'View', 'Window', 'help'],
  );
  assert.deepEqual(
    submenu(template, 'Edit')
      .filter(({ role }) => role)
      .map(({ role }) => role),
    ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'],
  );
  assert.deepEqual(
    submenu(template, 'Window')
      .filter(({ role }) => role)
      .map(({ role }) => role),
    ['minimize', 'zoom', 'front'],
  );
  assert.equal(
    submenu(template, 'View').some(({ role }) => role === 'toggleDevTools'),
    false,
  );
});

test('menu actions target the updater, security pane, help, and release page', () => {
  const actions = [];
  const template = createApplicationMenuTemplate(
    menuOptions({
      checkForUpdates: () => actions.push(['update']),
      openPath: (path) => actions.push(['path', path]),
      openExternal: (url) => actions.push(['url', url]),
    }),
  );

  submenu(template, 'DROIDEX')
    .find(({ label }) => label === 'Check for Updates…')
    .click();
  submenu(template, 'DROIDEX')
    .find(({ label }) => label === 'Privacy & Security Settings…')
    .click();
  template.find(({ role }) => role === 'help').submenu.forEach(({ click }) => click());

  assert.deepEqual(actions, [
    ['update'],
    ['path', PRIVACY_SECURITY_PANE],
    ['url', HELP_URL],
    ['url', LATEST_RELEASE_URL],
  ]);
});

test('reload actions preserve safe shell reload behavior and accelerators', () => {
  const reloads = [];
  const template = createApplicationMenuTemplate(
    menuOptions({ reload: (ignoreCache) => reloads.push(ignoreCache) }),
  );
  const view = submenu(template, 'View');

  assert.equal(view[0].accelerator, 'CmdOrCtrl+R');
  assert.equal(view[1].accelerator, 'CmdOrCtrl+Alt+R');
  view[0].click();
  view[1].click();
  assert.deepEqual(reloads, [false, true]);
});

test('developer tools stay available only in development builds', () => {
  const template = createApplicationMenuTemplate(menuOptions({ isPackaged: false }));
  assert.equal(
    submenu(template, 'View').some(({ role }) => role === 'toggleDevTools'),
    true,
  );
});

test('installer wires native dependencies and logs failed system actions', async () => {
  const calls = [];
  let installedMenu;
  installApplicationMenu({
    appName: 'DROIDEX',
    platform: 'darwin',
    app: { isPackaged: true },
    appUpdater: {
      async check(options) {
        calls.push(['update', options]);
      },
    },
    reload() {},
    shell: {
      async openPath(target) {
        calls.push(['path', target]);
        return 'denied';
      },
      async openExternal(url) {
        calls.push(['url', url]);
      },
    },
    logError(message) {
      calls.push(['error', message]);
    },
    Menu: {
      buildFromTemplate(template) {
        return template;
      },
      setApplicationMenu(menu) {
        installedMenu = menu;
      },
    },
  });

  submenu(installedMenu, 'DROIDEX')
    .find(({ label }) => label === 'Check for Updates…')
    .click();
  submenu(installedMenu, 'DROIDEX')
    .find(({ label }) => label === 'Privacy & Security Settings…')
    .click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    ['update', { interactive: true, automaticChecks: true }],
    ['path', PRIVACY_SECURITY_PANE],
    ['error', `Could not open ${PRIVACY_SECURITY_PANE}: denied`],
  ]);
});
