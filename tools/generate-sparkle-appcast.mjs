import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const releaseDirectory = resolve(process.argv[2] || 'release');
const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const releaseTag = `v${packageVersion}`;
const account = 'droidex';
const tool = resolve('vendor/sparkle/distribution/bin/generate_appcast');
const privateKey = process.env.SPARKLE_PRIVATE_KEY_FILE
  ? readFileSync(process.env.SPARKLE_PRIVATE_KEY_FILE, 'utf8').trim()
  : process.env.SPARKLE_PRIVATE_KEY;

rmSync(join(releaseDirectory, 'appcast.xml'), { force: true });

for (const architecture of ['arm64', 'x64']) {
  const stagingDirectory = mkdtempSync(join(tmpdir(), `droidex-sparkle-${architecture}-`));
  const appcastPath = join(stagingDirectory, `appcast-${architecture}.xml`);
  try {
    const archiveName = `droidex-${architecture}.zip`;
    copyFileSync(join(releaseDirectory, archiveName), join(stagingDirectory, archiveName));

    const keyArguments = privateKey ? ['--ed-key-file', '-'] : ['--account', account];
    const result = spawnSync(
      tool,
      [
        ...keyArguments,
        '--download-url-prefix',
        `https://github.com/droidex-anas/droidex-releases/releases/download/${releaseTag}/`,
        '--maximum-deltas',
        '0',
        '--link',
        'https://github.com/droidex-anas/droidex-releases/releases/latest',
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
      throw new Error(
        `Sparkle ${architecture} appcast generation failed (status=${String(result.status)}, signal=${String(result.signal)}): ${`${result.stdout}\n${result.stderr}`.trim()}`,
      );
    }
    copyFileSync(appcastPath, join(releaseDirectory, `appcast-${architecture}.xml`));
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

process.stdout.write(`Generated EdDSA-signed Sparkle appcasts for ${releaseTag}.\n`);
