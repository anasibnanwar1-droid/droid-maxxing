import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const releaseDirectory = resolve(process.argv[2] || 'release');
const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const releaseTag = `v${packageVersion}`;
const account = 'droidex';
const tool = resolve('vendor/sparkle/distribution/bin/generate_appcast');
const stagingDirectory = mkdtempSync(join(tmpdir(), 'droidex-sparkle-appcast-'));
const appcastPath = join(stagingDirectory, 'appcast.xml');

try {
  for (const architecture of ['arm64', 'x64']) {
    const archiveName = `droidex-${architecture}.zip`;
    copyFileSync(join(releaseDirectory, archiveName), join(stagingDirectory, archiveName));
  }

  const privateKey = process.env.SPARKLE_PRIVATE_KEY;
  const keyArguments = privateKey ? ['--ed-key-file', '-'] : ['--account', account];
  const result = spawnSync(
    tool,
    [
      ...keyArguments,
      '--download-url-prefix',
      `https://github.com/anasibnanwar1-droid/droidex-releases/releases/download/${releaseTag}/`,
      '--link',
      'https://github.com/anasibnanwar1-droid/droidex-releases/releases/latest',
      '-o',
      appcastPath,
      stagingDirectory,
    ],
    {
      encoding: 'utf8',
      input: privateKey ? `${privateKey}\n` : undefined,
      stdio: privateKey ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error(`Sparkle appcast generation failed: ${result.stderr.trim()}`);
  }
  copyFileSync(appcastPath, join(releaseDirectory, 'appcast.xml'));
  process.stdout.write(`Generated EdDSA-signed Sparkle appcast for ${releaseTag}.\n`);
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}
