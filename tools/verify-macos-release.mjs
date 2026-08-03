import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { extractFile, listPackage } from '@electron/asar';

const releaseDirectory = resolve(process.argv[2] || 'release');
const requireSignedArtifacts = process.argv.includes('--signed');
const writeChecksums = process.argv.includes('--write-checksums');
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const appName = 'DROIDEX.app';

const architectures = [
  { name: 'x64', appPath: join(releaseDirectory, 'mac', appName), executableArch: 'x86_64' },
  {
    name: 'arm64',
    appPath: join(releaseDirectory, 'mac-arm64', appName),
    executableArch: 'arm64',
  },
];

const releaseAssetNames = [
  'droidex-x64.dmg',
  'droidex-x64.dmg.blockmap',
  'droidex-x64.zip',
  'droidex-x64.zip.blockmap',
  'droidex-arm64.dmg',
  'droidex-arm64.dmg.blockmap',
  'droidex-arm64.zip',
  'droidex-arm64.zip.blockmap',
  'latest-mac.yml',
];

function fail(message) {
  throw new Error(`Release verification failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function runWithDiagnostics(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return `${result.stdout}${result.stderr}`;
}

function listFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

function assertNoPrivateBuildFiles(paths, label) {
  const forbidden = paths.filter((path) =>
    /(^|\/)(\.env(?:\.|$)|\.git(?:\/|$))|\.(?:map|pem|p8|p12)$/i.test(path),
  );
  assert(forbidden.length === 0, `${label} contains private build files: ${forbidden.join(', ')}`);
}

for (const assetName of releaseAssetNames) {
  const assetPath = join(releaseDirectory, assetName);
  assert(statSync(assetPath).isFile(), `missing ${assetName}`);
}

const metadata = readFileSync(join(releaseDirectory, 'latest-mac.yml'), 'utf8');
assert(metadata.includes(`version: ${packageJson.version}`), 'latest-mac.yml version is stale');
for (const architecture of architectures) {
  assert(metadata.includes(`droidex-${architecture.name}.zip`), `update metadata omits ${architecture.name} ZIP`);
  assert(metadata.includes(`droidex-${architecture.name}.dmg`), `update metadata omits ${architecture.name} DMG`);
}

assertNoPrivateBuildFiles(releaseAssetNames, 'release assets');

for (const architecture of architectures) {
  const { appPath, executableArch, name } = architecture;
  assert(statSync(appPath).isDirectory(), `missing ${name} app bundle`);

  const resourcesPath = join(appPath, 'Contents', 'Resources');
  const asarPath = join(resourcesPath, 'app.asar');
  const executablePath = join(appPath, 'Contents', 'MacOS', 'DROIDEX');
  const updateConfiguration = readFileSync(join(resourcesPath, 'app-update.yml'), 'utf8');
  assert(updateConfiguration.includes('owner: anasibnanwar1-droid'), `${name} updater owner is wrong`);
  assert(updateConfiguration.includes('repo: droidex-releases'), `${name} updater repo is wrong`);
  assert(updateConfiguration.includes('updaterCacheDirName: droidex-updater'), `${name} updater cache identity is stale`);
  assert(
    statSync(join(resourcesPath, 'sidecar', 'dist', 'sidecar.mjs')).isFile(),
    `${name} sidecar bundle is missing`,
  );

  const asarEntries = listPackage(asarPath);
  assertNoPrivateBuildFiles(asarEntries, `${name} app.asar`);
  const packagedMetadata = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
  assert(packagedMetadata.name === 'droidex', `${name} package identity is stale`);
  assert(packagedMetadata.version === packageJson.version, `${name} package version is stale`);

  const executableDescription = run('/usr/bin/file', [executablePath]);
  assert(executableDescription.includes(executableArch), `${name} app has the wrong executable architecture`);

  const sqliteResult = run(executablePath, [
    '-e',
    "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); console.log(db.prepare('select 1 as value').get().value); db.close();",
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim();
  assert(sqliteResult === '1', `${name} bundled node:sqlite smoke failed`);

  const infoPlist = join(appPath, 'Contents', 'Info.plist');
  for (const key of [
    'NSDesktopFolderUsageDescription',
    'NSDocumentsFolderUsageDescription',
    'NSDownloadsFolderUsageDescription',
  ]) {
    assert(run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, infoPlist]).includes('choose'), `${name} is missing ${key}`);
  }

  if (requireSignedArtifacts) {
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
    run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);

    const expectedTeamId = process.env.APPLE_TEAM_ID;
    assert(expectedTeamId, 'APPLE_TEAM_ID is required for signed verification');
    const signature = runWithDiagnostics('/usr/bin/codesign', ['-dvv', appPath]);
    assert(signature.includes(`TeamIdentifier=${expectedTeamId}`), `${name} signature uses the wrong Apple team`);
  }
}

for (const architecture of architectures) {
  const dmgPath = join(releaseDirectory, `droidex-${architecture.name}.dmg`);
  run('/usr/bin/hdiutil', ['verify', dmgPath]);
  if (requireSignedArtifacts) run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath]);
}

if (writeChecksums) {
  const lines = releaseAssetNames.map((assetName) => {
    const digest = createHash('sha256')
      .update(readFileSync(join(releaseDirectory, assetName)))
      .digest('hex');
    return `${digest}  ${assetName}`;
  });
  writeFileSync(join(releaseDirectory, 'SHA256SUMS'), `${lines.join('\n')}\n`, { mode: 0o644 });
}

const appFiles = architectures.flatMap(({ appPath }) =>
  listFiles(appPath).map((path) => relative(releaseDirectory, path)),
);
assertNoPrivateBuildFiles(appFiles, 'app bundles');

console.log(
  `Verified DROIDEX ${packageJson.version} macOS release (${requireSignedArtifacts ? 'signed' : 'local'}).`,
);
