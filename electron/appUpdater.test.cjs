const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppUpdater, compareSemverParts } = require('./appUpdater.cjs');

function harness({
  current = '1.2.3',
  latest = '1.3.0',
  packaged = true,
  installMode = 'automatic',
} = {}) {
  const calls = [];
  let install;
  const autoUpdater = {
    checkForUpdates: async () => {
      calls.push('check');
      return { updateInfo: { version: latest } };
    },
    downloadUpdate: async () => calls.push('download'),
    quitAndInstall: () => calls.push('install'),
  };
  const updater = createAppUpdater({
    autoUpdater,
    app: { getVersion: () => current, isPackaged: packaged },
    platform: 'darwin',
    arch: 'arm64',
    installMode,
    fetchLatestVersion: async () => {
      calls.push('manual-check');
      return latest;
    },
    openReleasePage: async () => calls.push('open-release-page'),
    prepareToInstall: async () => calls.push('prepare'),
    scheduleInstall: (callback) => {
      install = callback;
    },
  });
  return { updater, autoUpdater, calls, runInstall: () => install?.() };
}

test('update checks report the release selected by electron-updater', async () => {
  const { updater, autoUpdater, calls } = harness();
  const result = await updater.check();

  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(result.current, '1.2.3');
  assert.equal(result.latest, '1.3.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.installMode, 'automatic');
  assert.deepEqual(calls, ['check']);
});

test('unsigned builds check and open the manual release page without invoking autoUpdater', async () => {
  const { updater, calls } = harness({ installMode: 'manual' });

  const result = await updater.check();
  assert.equal(result.updateAvailable, true);
  assert.equal(result.installMode, 'manual');
  assert.deepEqual(calls, ['manual-check']);

  assert.deepEqual(await updater.downloadAndInstall(), { status: 'opened' });
  assert.deepEqual(calls, ['manual-check', 'open-release-page']);
});

test('install waits for sidecar shutdown before handing control to the updater', async () => {
  const { updater, calls, runInstall } = harness();

  assert.deepEqual(await updater.downloadAndInstall(), { status: 'downloaded' });
  assert.deepEqual(calls, ['download', 'prepare']);

  runInstall();
  assert.deepEqual(calls, ['download', 'prepare', 'install']);
});

test('development builds never contact the production update feed', async () => {
  const { updater, calls } = harness({ packaged: false });
  const result = await updater.check();

  assert.equal(result.updateAvailable, false);
  assert.deepEqual(calls, []);
});

test('version comparison is numeric', () => {
  assert.equal(compareSemverParts('1.10.0', '1.9.9') > 0, true);
  assert.equal(compareSemverParts('v2.0', '2.0.0'), 0);
});
