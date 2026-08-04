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
    sparkleUpdater: () => ({
      checkForUpdates: (interactive, automaticChecks) =>
        calls.push(['sparkle-check', interactive, automaticChecks]),
    }),
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

test('unsigned builds delegate verified update checks and installation to Sparkle', async () => {
  const { updater, calls } = harness({ installMode: 'sparkle' });

  const result = await updater.check({ interactive: false, automaticChecks: true });
  assert.equal(result.updateAvailable, false);
  assert.equal(result.installMode, 'sparkle');
  assert.deepEqual(calls, [['sparkle-check', false, true]]);

  assert.deepEqual(await updater.downloadAndInstall(), { status: 'presented' });
  assert.deepEqual(calls, [
    ['sparkle-check', false, true],
    ['sparkle-check', true, true],
  ]);
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
