import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_LINES = 3500;
const MAX_BYTES = 250_000;
const MAX_LINES_BY_PATH = new Map([
  // PR 2 only lengthens identifiers in the characterized manager. PR 3's
  // SessionService/SessionRegistry extraction must remove this override.
  ['sidecar/src/SessionManager.ts', 3600],
]);
const INCLUDED_EXTENSIONS = new Set(['.cjs', '.css', '.html', '.js', '.json', '.mjs', '.ts', '.tsx', '.yml', '.yaml']);
const EXCLUDED_PATHS = [/^package-lock\.json$/, /^sidecar\/package-lock\.json$/, /^dist\//, /^sidecar\/dist\//];

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((file) => INCLUDED_EXTENSIONS.has(file.slice(file.lastIndexOf('.'))))
  .filter((file) => !EXCLUDED_PATHS.some((pattern) => pattern.test(file)));

const violations = files.flatMap((file) => {
  const contents = readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(contents);
  const lines = contents.split('\n').length;
  const maxLines = MAX_LINES_BY_PATH.get(file) ?? MAX_LINES;
  const fileViolations = [];

  if (lines > maxLines) {
    fileViolations.push(`${file}: ${lines} lines exceeds ${maxLines}`);
  }

  if (bytes > MAX_BYTES) {
    fileViolations.push(`${file}: ${bytes} bytes exceeds ${MAX_BYTES}`);
  }

  return fileViolations;
});

if (violations.length > 0) {
  console.error('Large file guard failed:\n' + violations.join('\n'));
  process.exit(1);
}

console.log(
  `Checked ${files.length} tracked source/config files against default limits of ${MAX_LINES} lines and ${MAX_BYTES} bytes.`,
);
