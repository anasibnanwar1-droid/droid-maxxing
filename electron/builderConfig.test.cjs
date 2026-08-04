const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const configPath = require.resolve('../electron-builder.config.cjs');
const appleEnvironmentKeys = [
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'CSC_LINK',
  'DROIDEX_RELEASE_BUILD',
  'DROIDEX_UNSIGNED_RELEASE_BUILD',
  'SENTRY_DSN',
  'SENTRY_DSN_FILE',
  'SPARKLE_FEED_URL',
];

function loadConfig(environment) {
  const previous = new Map(appleEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const key of appleEnvironmentKeys) delete process.env[key];
  Object.assign(process.env, environment);
  delete require.cache[configPath];
  try {
    return require(configPath);
  } finally {
    delete require.cache[configPath];
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('free mac builds use ad-hoc signing and never attempt notarization', () => {
  const config = loadConfig({
    APPLE_ID: 'developer@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'password',
    APPLE_TEAM_ID: 'TEAMID',
  });

  assert.equal(config.mac.identity, '-');
  assert.equal(config.mac.notarize, false);
  assert.equal(config.extraMetadata.updateInstallMode, 'sparkle');
  assert.equal(config.mac.extendInfo.SUPublicEDKey, 'czgsBI/YO7amJbwhZidZSO0j7LU5A4NsU0No9fDemWU=');
  assert.match(config.mac.extendInfo.SUFeedURL, /droidex-releases\/releases\/latest/);
  assert.equal(config.mac.extendInfo.SURequireSignedFeed, true);
  assert.equal(config.mac.extendInfo.SUVerifyUpdateBeforeExtraction, true);
  assert.equal(config.mac.extendInfo.SUEnableSystemProfiling, false);
  assert.deepEqual(config.extraFiles, [
    {
      from: 'vendor/sparkle/distribution/Sparkle.framework',
      to: 'Frameworks/Sparkle.framework',
    },
  ]);
});

test('unsigned architecture builds select their matching Sparkle feed', () => {
  const config = loadConfig({
    SPARKLE_FEED_URL:
      'https://github.com/anasibnanwar1-droid/droidex-releases/releases/latest/download/appcast-arm64.xml',
  });

  assert.match(config.mac.extendInfo.SUFeedURL, /appcast-arm64\.xml$/);
});

test('signed mac builds enable notarization when every credential is present', () => {
  const config = loadConfig({
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAMID)',
    APPLE_ID: 'developer@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'password',
    APPLE_TEAM_ID: 'TEAMID',
  });

  assert.equal(config.mac.notarize, true);
});

test('release builds require notarization credentials', () => {
  assert.throws(
    () => loadConfig({ DROIDEX_RELEASE_BUILD: '1' }),
    /require Developer ID signing and Apple notarization credentials/,
  );
});

test('release builds emit canonical update artifacts', () => {
  const config = loadConfig({
    DROIDEX_RELEASE_BUILD: '1',
    CSC_LINK: 'base64-certificate',
    APPLE_API_KEY: '/tmp/AuthKey.p8',
    APPLE_API_KEY_ID: 'KEYID',
    APPLE_API_ISSUER: 'ISSUER',
    SENTRY_DSN: 'https://public@example.invalid/1',
  });

  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.extraMetadata.updateInstallMode, 'automatic');
  assert.deepEqual(
    config.mac.target.map((target) => target.target),
    ['dmg', 'zip'],
  );
  assert.deepEqual(config.publish, {
    provider: 'github',
    owner: 'anasibnanwar1-droid',
    repo: 'droidex-releases',
    releaseType: 'release',
  });
});

test('release builds require crash reporting configuration', () => {
  assert.throws(
    () =>
      loadConfig({
        DROIDEX_RELEASE_BUILD: '1',
        CSC_LINK: 'base64-certificate',
        APPLE_API_KEY: '/tmp/AuthKey.p8',
        APPLE_API_KEY_ID: 'KEYID',
        APPLE_API_ISSUER: 'ISSUER',
      }),
    /require SENTRY_DSN/,
  );
});

test('unsigned release builds load crash reporting configuration from a protected file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'droidex-builder-config-'));
  const dsnPath = join(directory, 'sentry-dsn');
  writeFileSync(dsnPath, 'https://public@example.invalid/1\n', { mode: 0o600 });

  try {
    const config = loadConfig({
      DROIDEX_UNSIGNED_RELEASE_BUILD: '1',
      SENTRY_DSN_FILE: dsnPath,
    });
    assert.equal(config.extraMetadata.sentryDsn, 'https://public@example.invalid/1');
    assert.equal(config.extraMetadata.updateInstallMode, 'sparkle');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CI certificate and API key credentials enable notarization', () => {
  const config = loadConfig({
    CSC_LINK: 'base64-certificate',
    APPLE_API_KEY: '/tmp/AuthKey.p8',
    APPLE_API_KEY_ID: 'KEYID',
    APPLE_API_ISSUER: 'ISSUER',
  });

  assert.equal(config.mac.identity, undefined);
  assert.equal(config.mac.notarize, true);
});

test('notarization rejects API key data instead of an absolute key path', () => {
  assert.throws(
    () =>
      loadConfig({
        DROIDEX_RELEASE_BUILD: '1',
        CSC_LINK: 'base64-certificate',
        APPLE_API_KEY: 'base64-api-key',
        APPLE_API_KEY_ID: 'KEYID',
        APPLE_API_ISSUER: 'ISSUER',
        SENTRY_DSN: 'https://public@example.invalid/1',
      }),
    /APPLE_API_KEY must be an absolute .p8 path/,
  );
});

test('macOS protected project folders have truthful permission descriptions', () => {
  const config = loadConfig({});

  assert.match(config.mac.extendInfo.NSDesktopFolderUsageDescription, /choose them/);
  assert.match(config.mac.extendInfo.NSDocumentsFolderUsageDescription, /choose them/);
  assert.match(config.mac.extendInfo.NSDownloadsFolderUsageDescription, /choose them/);
  assert.equal(config.mac.extendInfo.NSCameraUsageDescription, undefined);
  assert.equal(config.mac.extendInfo.NSMicrophoneUsageDescription, undefined);
});

test('website DMG includes a direct Privacy & Security shortcut', () => {
  const config = loadConfig({});

  assert.deepEqual(config.dmg.window, { width: 760, height: 330 });
  assert.deepEqual(config.dmg.contents, [
    { x: 180, y: 165, type: 'file' },
    { x: 420, y: 165, type: 'link', path: '/Applications' },
    {
      x: 650,
      y: 165,
      type: 'link',
      name: 'Open Privacy & Security',
      path: '/System/Library/PreferencePanes/Security.prefPane',
    },
  ]);
});
