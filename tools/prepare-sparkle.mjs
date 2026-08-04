import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const version = '2.9.5';
const expectedSha256 = '015336b601493e05c237964954bff6191370003d94edefe663724c88840d73cc';
const archiveUrl = `https://github.com/sparkle-project/Sparkle/releases/download/${version}/Sparkle-${version}.tar.xz`;
const vendorRoot = resolve('vendor/sparkle');
const archivePath = join(vendorRoot, `Sparkle-${version}.tar.xz`);
const extractedRoot = join(vendorRoot, 'distribution');

mkdirSync(vendorRoot, { recursive: true, mode: 0o755 });

let archive;
try {
  archive = readFileSync(archivePath);
} catch {
  const response = await fetch(archiveUrl);
  if (!response.ok) throw new Error(`Sparkle download failed with HTTP ${response.status}.`);
  archive = Buffer.from(await response.arrayBuffer());
  writeFileSync(archivePath, archive, { mode: 0o644 });
}

const actualSha256 = createHash('sha256').update(archive).digest('hex');
if (actualSha256 !== expectedSha256) {
  throw new Error(`Sparkle archive checksum mismatch: ${actualSha256}`);
}

rmSync(extractedRoot, { recursive: true, force: true });
mkdirSync(extractedRoot, { recursive: true, mode: 0o755 });
execFileSync('/usr/bin/tar', ['-xJf', archivePath, '-C', extractedRoot], { stdio: 'inherit' });

process.stdout.write(`Prepared Sparkle ${version} (${actualSha256}).\n`);
