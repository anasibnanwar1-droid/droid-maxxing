// electron-builder config for DROIDEX.
//
// Produces the per-arch DMGs the site and the in-app updater already expect
// (droidex-arm64.dmg / droidex-x64.dmg). Signing is env-gated: with no
// APPLE_SIGNING_IDENTITY the build is unsigned (local use); set the signing
// env vars (see .env.example) and the same command signs and notarizes.

const process = require('node:process');

const identity = process.env.APPLE_SIGNING_IDENTITY || null;
const canNotarize = Boolean(
  identity &&
  process.env.APPLE_ID &&
  process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  process.env.APPLE_TEAM_ID,
);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.droidex',
  productName: 'DROIDEX',
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
    identity,
    hardenedRuntime: Boolean(identity),
    entitlements: 'assets/brand/entitlements.mac.plist',
    entitlementsInherit: 'assets/brand/entitlements.mac.plist',
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
    notarize: canNotarize,
  },
  dmg: {
    icon: 'electron/assets/icon.icns',
    background: 'assets/brand/dmg-background.png',
    window: { width: 600, height: 400 },
    iconSize: 96,
    contents: [
      { x: 132, y: 150, type: 'file' },
      { x: 372, y: 150, type: 'link', path: '/Applications' },
    ],
    artifactName: `droidex-\${arch}.\${ext}`,
  },
  publish: null,
};
