const test = require('node:test');
const assert = require('node:assert/strict');

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
  'SENTRY_DSN',
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

test('unsigned mac builds never attempt notarization', () => {
  const config = loadConfig({
    APPLE_ID: 'developer@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'password',
    APPLE_TEAM_ID: 'TEAMID',
  });

  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.notarize, false);
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
    APPLE_API_KEY: 'base64-api-key',
    APPLE_API_KEY_ID: 'KEYID',
    APPLE_API_ISSUER: 'ISSUER',
    SENTRY_DSN: 'https://public@example.invalid/1',
  });

  assert.equal(config.forceCodeSigning, true);
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

test('CI certificate and API key credentials enable notarization', () => {
  const config = loadConfig({
    CSC_LINK: 'base64-certificate',
    APPLE_API_KEY: 'base64-api-key',
    APPLE_API_KEY_ID: 'KEYID',
    APPLE_API_ISSUER: 'ISSUER',
  });

  assert.equal(config.mac.identity, undefined);
  assert.equal(config.mac.notarize, true);
});

test('macOS protected project folders have truthful permission descriptions', () => {
  const config = loadConfig({});

  assert.match(config.extendInfo.NSDesktopFolderUsageDescription, /choose them/);
  assert.match(config.extendInfo.NSDocumentsFolderUsageDescription, /choose them/);
  assert.match(config.extendInfo.NSDownloadsFolderUsageDescription, /choose them/);
  assert.equal(config.extendInfo.NSCameraUsageDescription, undefined);
  assert.equal(config.extendInfo.NSMicrophoneUsageDescription, undefined);
});
