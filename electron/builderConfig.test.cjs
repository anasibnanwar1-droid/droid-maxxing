const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const sparkleBridgeSource = require('node:fs').readFileSync(
  join(__dirname, '..', 'native', 'sparkle-updater', 'src', 'sparkle_updater.mm'),
  'utf8',
);
const releaseWorkflowSource = require('node:fs').readFileSync(
  join(__dirname, '..', '.github', 'workflows', 'release-macos.yml'),
  'utf8',
);
const unsignedPreflightSource = require('node:fs').readFileSync(
  join(__dirname, '..', 'tools', 'check-unsigned-release.mjs'),
  'utf8',
);
const canonicalSentryDsn = 'https://public@o4511166732304384.ingest.de.sentry.io/4511850999185488';

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
  assert.equal(config.extraMetadata.sparkleFeedUrl, config.mac.extendInfo.SUFeedURL);
  assert.equal(config.mac.extendInfo.SUPublicEDKey, 'czgsBI/YO7amJbwhZidZSO0j7LU5A4NsU0No9fDemWU=');
  assert.match(config.mac.extendInfo.SUFeedURL, /droidex-releases\/releases\/latest/);
  assert.equal(config.mac.extendInfo.SURequireSignedFeed, true);
  assert.equal(config.mac.extendInfo.SUVerifyUpdateBeforeExtraction, true);
  assert.equal(config.mac.extendInfo.SUEnableAutomaticChecks, true);
  assert.equal(config.mac.extendInfo.SUAllowsAutomaticUpdates, false);
  assert.equal(config.mac.extendInfo.SUAutomaticallyUpdate, false);
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
      'https://github.com/droidex-anas/droidex-releases/releases/latest/download/appcast-arm64.xml',
  });

  assert.match(config.mac.extendInfo.SUFeedURL, /appcast-arm64\.xml$/);
  assert.equal(config.extraMetadata.sparkleFeedUrl, config.mac.extendInfo.SUFeedURL);
});

test('existing mac installs keep the stable application and updater identity', () => {
  const config = loadConfig({});

  assert.equal(config.appId, 'app.droidex');
  assert.equal(config.productName, 'DROIDEX');
  assert.equal(config.mac.artifactName, 'droidex-${arch}.${ext}');
  assert.equal(config.dmg.artifactName, 'droidex-${arch}.${ext}');
  assert.deepEqual(
    config.mac.target.map((target) => target.target),
    ['dmg', 'zip'],
  );
  assert.match(config.mac.extendInfo.SUFeedURL, /droidex-releases\/releases\/latest/);
  assert.equal(config.mac.extendInfo.SUPublicEDKey, 'czgsBI/YO7amJbwhZidZSO0j7LU5A4NsU0No9fDemWU=');
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
    SENTRY_DSN: canonicalSentryDsn,
  });

  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.extraMetadata.updateInstallMode, 'automatic');
  assert.deepEqual(
    config.mac.target.map((target) => target.target),
    ['dmg', 'zip'],
  );
  assert.deepEqual(config.publish, {
    provider: 'github',
    owner: 'droidex-anas',
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

test('release builds reject a Sentry DSN for another host or project', () => {
  const releaseEnvironment = {
    DROIDEX_RELEASE_BUILD: '1',
    CSC_LINK: 'base64-certificate',
    APPLE_API_KEY: '/tmp/AuthKey.p8',
    APPLE_API_KEY_ID: 'KEYID',
    APPLE_API_ISSUER: 'ISSUER',
  };
  for (const dsn of [
    'https://public@example.invalid/4511850999185488',
    'https://public@o4511166732304384.ingest.de.sentry.io/999',
  ]) {
    assert.throws(
      () => loadConfig({ ...releaseEnvironment, SENTRY_DSN: dsn }),
      /canonical Sentry project/,
    );
  }
});

test('unsigned release builds load crash reporting configuration from a protected file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'droidex-builder-config-'));
  const dsnPath = join(directory, 'sentry-dsn');
  writeFileSync(dsnPath, `${canonicalSentryDsn}\n`, { mode: 0o600 });

  try {
    const config = loadConfig({
      DROIDEX_UNSIGNED_RELEASE_BUILD: '1',
      SENTRY_DSN_FILE: dsnPath,
    });
    assert.equal(config.extraMetadata.sentryDsn, canonicalSentryDsn);
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
        SENTRY_DSN: canonicalSentryDsn,
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

test('Sparkle checks in the background but never downloads updates automatically', () => {
  assert.match(sparkleBridgeSource, /setAutomaticallyChecksForUpdates:"\), enableBackgroundChecks/);
  assert.match(sparkleBridgeSource, /setAutomaticallyDownloadsUpdates:"\), NO/);
  assert.doesNotMatch(
    sparkleBridgeSource,
    /setAutomaticallyDownloadsUpdates:"\), enableBackgroundChecks/,
  );
});

test('release automation publishes only verified unsigned Sparkle assets', () => {
  assert.match(releaseWorkflowSource, /DROIDEX_UNSIGNED_RELEASE_BUILD: '1'/);
  assert.match(releaseWorkflowSource, /test -f "docs\/releases\/\$GITHUB_REF_NAME\.md"/);
  assert.match(releaseWorkflowSource, /--notes-file "docs\/releases\/\$GITHUB_REF_NAME\.md"/);
  assert.match(
    releaseWorkflowSource,
    /SPARKLE_PRIVATE_KEY: \$\{\{ secrets\.SPARKLE_PRIVATE_KEY \}\}/,
  );
  assert.match(releaseWorkflowSource, /release:preflight:unsigned/);
  assert.match(releaseWorkflowSource, /test "sha256:\$LOCAL_DIGEST" = "\$REMOTE_DIGEST"/);
  assert.match(releaseWorkflowSource, /for attempt in \{1\.\.13\}/);
  assert.match(releaseWorkflowSource, /Release attestation was not available after 60 seconds/);
  assert.doesNotMatch(releaseWorkflowSource, /release\/latest-mac\.yml/);
  assert.doesNotMatch(releaseWorkflowSource, /release\/.*\.blockmap/);
});

test('unsigned preflight accepts detached release tags only in CI', () => {
  assert.match(unsignedPreflightSource, /DROIDEX_RELEASE_GH_TOKEN/);
  assert.match(unsignedPreflightSource, /env: \{ \.\.\.process\.env, GH_TOKEN: token \}/);
  assert.match(
    releaseWorkflowSource,
    /DROIDEX_RELEASE_GH_TOKEN: \$\{\{ secrets\.DROIDEX_RELEASE_TOKEN \}\}/,
  );
  assert.match(unsignedPreflightSource, /!branch && process\.env\.CI === 'true'/);
  assert.match(unsignedPreflightSource, /merge-base', '--is-ancestor', head, 'origin\/main'/);
  assert.match(unsignedPreflightSource, /detached HEAD is allowed only in release CI/);
});
