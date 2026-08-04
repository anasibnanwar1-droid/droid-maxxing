const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAppUpdater,
  compareSemverParts,
  parseSparkleVersion,
  readBoundedText,
} = require('./appUpdater.cjs');

function harness({
  current = '1.2.3',
  latest = '1.3.0',
  packaged = true,
  installMode = 'automatic',
  appcastVersion = latest,
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
    sparkleFeedUrl: 'https://updates.example/appcast.xml',
    fetchText: async (url) => {
      calls.push(['fetch-appcast', url]);
      return `<sparkle:shortVersionString>\n  ${appcastVersion}\n</sparkle:shortVersionString>`;
    },
    sparkleUpdater: () => ({
      checkForUpdates: (interactive, automaticChecks, configureAutomaticChecks) =>
        calls.push(['sparkle-check', interactive, automaticChecks, configureAutomaticChecks]),
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
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latest, '1.3.0');
  assert.equal(result.installMode, 'sparkle');
  assert.deepEqual(calls, [['fetch-appcast', 'https://updates.example/appcast.xml']]);

  assert.deepEqual(await updater.downloadAndInstall(), { status: 'presented' });
  assert.deepEqual(calls, [
    ['fetch-appcast', 'https://updates.example/appcast.xml'],
    ['sparkle-check', true, true, false],
  ]);
});

test('manual menu checks do not change the background-check preference', async () => {
  const { updater, calls } = harness({ installMode: 'sparkle' });

  await updater.check({
    interactive: true,
    automaticChecks: true,
    configureAutomaticChecks: false,
  });

  assert.deepEqual(calls, [
    ['sparkle-check', true, true, false],
    ['fetch-appcast', 'https://updates.example/appcast.xml'],
  ]);
});

test('Sparkle checks report no update when the appcast version matches', async () => {
  const { updater } = harness({ installMode: 'sparkle', appcastVersion: '1.2.3' });
  const result = await updater.check({ interactive: false });

  assert.equal(result.latest, '1.2.3');
  assert.equal(result.updateAvailable, false);
});

test('Sparkle checks report no update for an older appcast', async () => {
  const { updater } = harness({ installMode: 'sparkle', appcastVersion: '1.2.2' });
  const result = await updater.check({ interactive: false });

  assert.equal(result.latest, '1.2.2');
  assert.equal(result.updateAvailable, false);
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

test('Sparkle appcast versions are parsed explicitly', () => {
  assert.equal(
    parseSparkleVersion(
      '<item><sparkle:shortVersionString>\n  1.0.1\n</sparkle:shortVersionString></item>',
    ),
    '1.0.1',
  );
  assert.throws(() => parseSparkleVersion('<rss />'), /no valid release version/);
  assert.throws(
    () =>
      parseSparkleVersion('<sparkle:shortVersionString>1.0.1-beta.1</sparkle:shortVersionString>'),
    /no valid release version/,
  );
});

test('Sparkle appcast reads are size bounded', async () => {
  const response = new Response('x'.repeat(9));
  await assert.rejects(() => readBoundedText(response, 8), /size limit/);
});
