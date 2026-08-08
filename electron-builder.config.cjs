// electron-builder config for DROIDEX.
//
// Produces website DMGs plus the ZIP/update metadata consumed by electron-updater.
// Free builds use an ad-hoc signature; production Developer ID releases fail
// closed unless signing and notarization credentials are present.

const process = require('node:process');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const isReleaseBuild = process.env.DROIDEX_RELEASE_BUILD === '1';
const isUnsignedReleaseBuild = process.env.DROIDEX_UNSIGNED_RELEASE_BUILD === '1';
const sparklePublicKey = 'czgsBI/YO7amJbwhZidZSO0j7LU5A4NsU0No9fDemWU=';
const sparkleFeedUrl =
  process.env.SPARKLE_FEED_URL ||
  'https://github.com/droidex-anas/droidex-releases/releases/latest/download/appcast.xml';
const sentryDsn = process.env.SENTRY_DSN_FILE
  ? fs.readFileSync(process.env.SENTRY_DSN_FILE, 'utf8').trim()
  : process.env.SENTRY_DSN || '';
const hasSigningCredentials = Boolean(process.env.CSC_LINK || process.env.APPLE_SIGNING_IDENTITY);
const identity = process.env.APPLE_SIGNING_IDENTITY || (process.env.CSC_LINK ? undefined : '-');
const hasApiKeyCredentials = Boolean(
  process.env.APPLE_API_KEY &&
  path.isAbsolute(process.env.APPLE_API_KEY) &&
  path.extname(process.env.APPLE_API_KEY) === '.p8' &&
  process.env.APPLE_API_KEY_ID &&
  process.env.APPLE_API_ISSUER,
);
const canNotarize = Boolean(
  hasSigningCredentials &&
  ((process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ||
    hasApiKeyCredentials),
);
if (isReleaseBuild && !canNotarize) {
  throw new Error(
    'DROIDEX release builds require Developer ID signing and Apple notarization credentials (APPLE_API_KEY must be an absolute .p8 path).',
  );
}
if ((isReleaseBuild || isUnsignedReleaseBuild) && !sentryDsn) {
  throw new Error('DROIDEX release builds require SENTRY_DSN for crash and bug reporting.');
}
if (isReleaseBuild || isUnsignedReleaseBuild) {
  let isCanonicalSentryProject = false;
  try {
    const parsedSentryDsn = new URL(sentryDsn);
    isCanonicalSentryProject =
      parsedSentryDsn.protocol === 'https:' &&
      parsedSentryDsn.hostname === 'o4511166732304384.ingest.de.sentry.io' &&
      parsedSentryDsn.pathname === '/4511850999185488';
  } catch {
    // The closed release validation below owns the user-facing error.
  }
  if (!isCanonicalSentryProject) {
    throw new Error('DROIDEX release builds require the canonical Sentry project destination.');
  }
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.droidex',
  productName: 'DROIDEX',
  forceCodeSigning: isReleaseBuild,
  extraMetadata: {
    sentryDsn,
    sparkleFeedUrl,
    updateInstallMode: isReleaseBuild ? 'automatic' : 'sparkle',
  },
  directories: {
    output: 'release',
    buildResources: 'assets/brand',
  },
  files: ['package.json', 'dist/**', 'electron/**', '!**/*.test.cjs', '!**/*.test.ts', '!**/*.map'],
  asarUnpack: ['node_modules/node-pty/**', 'node_modules/@droidex/sparkle-updater/**'],
  extraFiles: [
    {
      from: 'vendor/sparkle/distribution/Sparkle.framework',
      to: 'Frameworks/Sparkle.framework',
    },
  ],
  extraResources: [
    // The Electron host spawns the sidecar as resources/sidecar/dist/sidecar.mjs
    // (see sidecarEntry in electron/main.cjs). The bundle is self-contained.
    { from: 'sidecar/dist', to: 'sidecar/dist', filter: ['**/*'] },
  ],
  npmRebuild: true,
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'electron/assets/icon.icns',
    extendInfo: {
      NSDesktopFolderUsageDescription:
        'DROIDEX accesses Desktop projects only when you choose them for an agent session.',
      NSDocumentsFolderUsageDescription:
        'DROIDEX accesses Documents projects only when you choose them for an agent session.',
      NSDownloadsFolderUsageDescription:
        'DROIDEX accesses downloaded project files only when you choose them for an agent session.',
      SUFeedURL: sparkleFeedUrl,
      SUPublicEDKey: sparklePublicKey,
      SUEnableAutomaticChecks: true,
      SUAllowsAutomaticUpdates: false,
      SUAutomaticallyUpdate: false,
      SUEnableSystemProfiling: false,
      SUVerifyUpdateBeforeExtraction: true,
      SURequireSignedFeed: true,
      SUSignedFeedFailureExpirationInterval: 0,
    },
    identity,
    hardenedRuntime: hasSigningCredentials,
    entitlements: 'assets/brand/entitlements.mac.plist',
    entitlementsInherit: 'assets/brand/entitlements.mac.plist',
    target: [{ target: 'dmg' }, { target: 'zip' }],
    artifactName: `droidex-\${arch}.\${ext}`,
    notarize: canNotarize,
  },
  dmg: {
    icon: 'electron/assets/icon.icns',
    background: 'assets/brand/dmg-background.png',
    window: { width: 760, height: 330 },
    iconSize: 96,
    contents: [
      { x: 180, y: 165, type: 'file' },
      { x: 420, y: 165, type: 'link', path: '/Applications' },
      {
        x: 650,
        y: 165,
        type: 'link',
        name: 'Open Privacy & Security',
        path: '/System/Library/PreferencePanes/Security.prefPane',
      },
    ],
    artifactName: `droidex-\${arch}.\${ext}`,
  },
  publish: {
    provider: 'github',
    owner: 'droidex-anas',
    repo: 'droidex-releases',
    releaseType: 'release',
  },
};
