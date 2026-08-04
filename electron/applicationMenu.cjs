const HELP_URL = 'https://github.com/anasibnanwar1-droid/droidex-releases#readme';
const LATEST_RELEASE_URL =
  'https://github.com/anasibnanwar1-droid/droidex-releases/releases/latest';
const PRIVACY_SECURITY_PANE = '/System/Library/PreferencePanes/Security.prefPane';

function createApplicationMenuTemplate(options) {
  const isMac = options.platform === 'darwin';
  const reloadItem = () => ({
    label: `Reload ${options.appName}`,
    accelerator: 'CmdOrCtrl+R',
    click: () => options.reload(false),
  });
  const forceReloadItem = () => ({
    label: `Force Reload ${options.appName}`,
    accelerator: 'CmdOrCtrl+Alt+R',
    click: () => options.reload(true),
  });
  const viewItems = [
    reloadItem(),
    forceReloadItem(),
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  if (!options.isPackaged) {
    viewItems.push({ type: 'separator' }, { role: 'toggleDevTools' });
  }

  return [
    ...(isMac
      ? [
          {
            label: options.appName,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Check for Updates…',
                click: () => options.checkForUpdates(),
              },
              {
                label: 'Privacy & Security Settings…',
                click: () => options.openPath(PRIVACY_SECURITY_PANE),
              },
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
        ...(isMac ? [{ role: 'pasteAndMatchStyle' }] : []),
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: viewItems },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      role: 'help',
      submenu: [
        {
          label: `${options.appName} Help`,
          click: () => options.openExternal(HELP_URL),
        },
        {
          label: 'View Latest Release',
          click: () => options.openExternal(LATEST_RELEASE_URL),
        },
      ],
    },
  ];
}

function installApplicationMenu(options) {
  const template = createApplicationMenuTemplate({
    appName: options.appName,
    platform: options.platform || process.platform,
    isPackaged: options.app.isPackaged,
    reload: options.reload,
    checkForUpdates: () =>
      void options.appUpdater
        .check({
          interactive: true,
          automaticChecks: true,
          configureAutomaticChecks: false,
        })
        .catch((error) => options.logError(error.message)),
    openPath: (target) =>
      void options.shell
        .openPath(target)
        .then((error) => {
          if (error) options.logError(`Could not open ${target}: ${error}`);
        })
        .catch((error) => options.logError(error.message)),
    openExternal: (url) =>
      void options.shell.openExternal(url).catch((error) => options.logError(error.message)),
  });
  options.Menu.setApplicationMenu(options.Menu.buildFromTemplate(template));
}

module.exports = {
  HELP_URL,
  LATEST_RELEASE_URL,
  PRIVACY_SECURITY_PANE,
  createApplicationMenuTemplate,
  installApplicationMenu,
};
