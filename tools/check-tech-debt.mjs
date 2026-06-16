import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TRACKED_TEXT_EXTENSIONS = new Set(['.cjs', '.css', '.html', '.js', '.json', '.mjs', '.ts', '.tsx', '.yml', '.yaml']);
const EXCLUDED_PATHS = [
  /^package-lock\.json$/,
  /^sidecar\/package-lock\.json$/,
  /^dist\//,
  /^sidecar\/dist\//,
  /^tools\/check-tech-debt\.mjs$/,
];
const MARKER_PATTERN = /\b(TODO|FIXME|HACK)\b(?!\([A-Z]+-\d+\)|\s*https?:\/\/)/;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((file) => TRACKED_TEXT_EXTENSIONS.has(file.slice(file.lastIndexOf('.'))))
  .filter((file) => !EXCLUDED_PATHS.some((pattern) => pattern.test(file)));

const violations = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, index) => {
    if (MARKER_PATTERN.test(line)) {
      violations.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error('Untracked technical debt markers found. Use TODO(PROJ-123) or link to an issue:\n' + violations.join('\n'));
  process.exit(1);
}

console.log(`Checked ${files.length} tracked source/config files for linked TODO/FIXME/HACK markers.`);
