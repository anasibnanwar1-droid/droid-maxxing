// electron-builder config for DROIDEX.
//
// Produces website DMGs plus the ZIP/update metadata consumed by electron-updater.
// Local builds remain unsigned; production release builds fail closed unless a
// Developer ID certificate and notarization credentials are present.

const process = require('node:process');
const path = require('node:path');

const isReleaseBuild = process.env.DROIDEX_RELEASE_BUILD === '1';
const sentryDsn = process.env.SENTRY_DSN || '';
const hasSigningCredentials = Boolean(process.env.CSC_LINK || process.env.APPLE_SIGNING_IDENTITY);
const identity = process.env.APPLE_SIGNING_IDENTITY || (process.env.CSC_LINK ? undefined : null);
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
if (isReleaseBuild && !sentryDsn) {
  throw new Error('DROIDEX release builds require SENTRY_DSN for crash and bug reporting.');
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.droidex',
  productName: 'DROIDEX',
  forceCodeSigning: isReleaseBuild,
  extraMetadata: { sentryDsn },
  directories: {
    output: 'release',
    buildResources: 'assets/brand',
  },
  files: ['package.json', 'dist/**', 'electron/**', '!**/*.test.cjs', '!**/*.test.ts', '!**/*.map'],
  asarUnpack: ['node_modules/node-pty/**'],
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
    window: { width: 600, height: 300 },
    iconSize: 96,
    contents: [
      { x: 132, y: 150, type: 'file' },
      { x: 372, y: 150, type: 'link', path: '/Applications' },
    ],
    artifactName: `droidex-\${arch}.\${ext}`,
  },
  publish: {
    provider: 'github',
    owner: 'anasibnanwar1-droid',
    repo: 'droidex-releases',
    releaseType: 'release',
  },
};
