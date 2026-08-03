import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

const sourceRepository = 'anasibnanwar1-droid/droid-maxxing';
const releaseRepository = 'anasibnanwar1-droid/droidex-releases';
const releaseEnvironment = 'macos-release';
const requiredSecrets = [
  'APPLE_API_ISSUER',
  'APPLE_API_KEY_ID',
  'APPLE_API_KEY_P8_BASE64',
  'APPLE_TEAM_ID',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
  'DROIDEX_RELEASE_TOKEN',
  'SENTRY_DSN',
];

const checks = [];

function command(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readJson(file, args) {
  return JSON.parse(command(file, args));
}

function check(name, run) {
  try {
    const detail = run();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    checks.push({ name, ok: false, detail });
  }
}

check('source repository is private', () => {
  const repository = readJson('gh', [
    'repo',
    'view',
    sourceRepository,
    '--json',
    'visibility',
  ]);
  if (repository.visibility !== 'PRIVATE') throw new Error(`found ${repository.visibility}`);
  return sourceRepository;
});

check('release repository is public and issue-free', () => {
  const repository = readJson('gh', [
    'repo',
    'view',
    releaseRepository,
    '--json',
    'visibility,hasIssuesEnabled',
  ]);
  if (repository.visibility !== 'PUBLIC') throw new Error(`found ${repository.visibility}`);
  if (repository.hasIssuesEnabled) throw new Error('public issue intake is enabled');
  return releaseRepository;
});

check('release repository contains public docs only', () => {
  const entries = readJson('gh', ['api', `repos/${releaseRepository}/contents`]);
  const names = entries.map(({ name }) => name).sort();
  const expected = ['README.md', 'SECURITY.md'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`unexpected default-branch files: ${names.join(', ')}`);
  }
  return names.join(', ');
});

check('immutable releases are enabled', () => {
  const setting = readJson('gh', [
    'api',
    '-H',
    'X-GitHub-Api-Version: 2026-03-10',
    `repos/${releaseRepository}/immutable-releases`,
  ]);
  if (setting.enabled !== true) throw new Error('disabled');
  return setting.enforced_by_owner ? 'owner-enforced' : 'repository-enforced';
});

check('macos-release environment has every required secret', () => {
  const configured = readJson('gh', [
    'secret',
    'list',
    '--repo',
    sourceRepository,
    '--env',
    releaseEnvironment,
    '--json',
    'name',
  ]);
  const names = new Set(configured.map(({ name }) => name));
  const missing = requiredSecrets.filter((name) => !names.has(name));
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  return `${requiredSecrets.length} required secrets configured`;
});

check('local keychain has a Developer ID Application identity', () => {
  const identities = command('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!identities.includes('Developer ID Application:')) {
    throw new Error('Apple Development identities cannot sign a website release');
  }
  return 'Developer ID Application identity found';
});

check('release workflow passes actionlint', () => {
  command('actionlint', ['.github/workflows/release-macos.yml']);
  return '.github/workflows/release-macos.yml';
});

check('release branch is clean', () => {
  const status = command('git', ['status', '--porcelain']);
  if (status) throw new Error('working tree has uncommitted changes');
  return command('git', ['branch', '--show-current']);
});

check('local release artifacts exist', () => {
  const expected = [
    'release/droidex-arm64.dmg',
    'release/droidex-x64.dmg',
    'release/droidex-arm64.zip',
    'release/droidex-x64.zip',
    'release/latest-mac.yml',
    'release/SHA256SUMS',
  ];
  const missing = expected.filter((path) => !existsSync(path));
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  return `${expected.length} local artifacts present (not publication-authorized)`;
});

for (const result of checks) {
  const marker = result.ok ? 'PASS' : 'FAIL';
  process.stdout.write(`${marker}  ${result.name}: ${result.detail}\n`);
}

const failures = checks.filter(({ ok }) => !ok);
if (failures.length) {
  process.stderr.write(`\nRelease preflight failed: ${failures.length} requirement(s) unresolved.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nRelease environment is ready for the signed v0.1.0 workflow.\n');
}
