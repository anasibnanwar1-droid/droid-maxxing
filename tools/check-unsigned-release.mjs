import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { extractFile } from '@electron/asar';

const sourceRepository = 'anasibnanwar1-droid/droid-maxxing';
const releaseRepository = 'anasibnanwar1-droid/droidex-releases';
const releaseDirectory = 'release';
const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const releaseTag = `v${packageVersion}`;
const checks = [];

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    ...options,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readJson(file, args) {
  return JSON.parse(command(file, args));
}

function check(name, run) {
  try {
    checks.push({ name, ok: true, detail: run() });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    checks.push({ name, ok: false, detail });
  }
}

check('source repository is private', () => {
  const repository = readJson('gh', ['repo', 'view', sourceRepository, '--json', 'visibility']);
  if (repository.visibility !== 'PRIVATE') throw new Error(`found ${repository.visibility}`);
  return sourceRepository;
});

check('release repository is public and immutable', () => {
  const repository = readJson('gh', ['repo', 'view', releaseRepository, '--json', 'visibility']);
  if (repository.visibility !== 'PUBLIC') throw new Error(`found ${repository.visibility}`);
  const immutable = readJson('gh', [
    'api',
    '-H',
    'X-GitHub-Api-Version: 2026-03-10',
    `repos/${releaseRepository}/immutable-releases`,
  ]);
  if (immutable.enabled !== true) throw new Error('immutable releases are disabled');
  return releaseRepository;
});

check('public repository contains only release documentation', () => {
  const entries = readJson('gh', ['api', `repos/${releaseRepository}/contents`]);
  const names = entries.map(({ name }) => name).sort();
  if (JSON.stringify(names) !== JSON.stringify(['README.md', 'SECURITY.md'])) {
    throw new Error(`unexpected default-branch files: ${names.join(', ')}`);
  }
  const readme = readJson('gh', ['api', `repos/${releaseRepository}/contents/README.md`]);
  const readmeText = Buffer.from(readme.content, 'base64').toString('utf8');
  if (!readmeText.includes('ad-hoc signed') || !readmeText.includes('not notarized')) {
    throw new Error('public README does not disclose ad-hoc signing and missing notarization');
  }
  return names.join(', ');
});

check(`${releaseTag} does not already exist`, () => {
  try {
    command('gh', ['release', 'view', releaseTag, '--repo', releaseRepository]);
  } catch {
    return 'available';
  }
  throw new Error('immutable release tag already exists');
});

check('release source is clean and preserved on its private remote branch', () => {
  const status = command('git', ['status', '--porcelain']);
  if (status) throw new Error('working tree has uncommitted changes');
  const branch = command('git', ['branch', '--show-current']);
  const head = command('git', ['rev-parse', 'HEAD']);
  const remoteHead = command('git', ['rev-parse', `origin/${branch}`]);
  if (head !== remoteHead) throw new Error(`origin/${branch} does not match HEAD`);
  return `${branch}@${head}`;
});

check('artifacts pass unsigned package verification and checksums', () => {
  command(process.execPath, ['tools/verify-macos-release.mjs', releaseDirectory]);
  command('/usr/bin/shasum', ['--algorithm', '256', '--check', 'SHA256SUMS'], {
    cwd: releaseDirectory,
  });
  return `verified ${releaseTag}`;
});

check('packaged builds use Sparkle update installation', () => {
  for (const directory of ['mac', 'mac-arm64']) {
    const asarPath = `${releaseDirectory}/${directory}/DROIDEX.app/Contents/Resources/app.asar`;
    const metadata = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
    if (metadata.updateInstallMode !== 'sparkle') {
      throw new Error(`${directory} build is not marked for Sparkle updates`);
    }
  }
  return 'arm64 and x64';
});

for (const result of checks) {
  process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}: ${result.detail}\n`);
}

const failures = checks.filter(({ ok }) => !ok);
if (failures.length) {
  process.stderr.write(`\nUnsigned release preflight failed: ${failures.length} requirement(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nUnsigned ${releaseTag} is ready to stage as an immutable draft.\n`);
}
