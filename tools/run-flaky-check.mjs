import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , reportPath, separator, command, ...args] = process.argv;

if (!reportPath || separator !== '--' || !command) {
  console.error('Usage: node tools/run-flaky-check.mjs <report-path> -- <command> [...args]');
  process.exit(2);
}

const attempts = [];

for (let attempt = 1; attempt <= 2; attempt += 1) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  attempts.push({
    attempt,
    exitCode: result.status ?? 1,
    startedAt,
    completedAt: new Date().toISOString(),
  });

  if (result.status !== 0) break;
}

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      command: [command, ...args],
      attempts,
      passed: attempts.length === 2 && attempts.every((attempt) => attempt.exitCode === 0),
    },
    null,
    2
  )}\n`
);

if (attempts.length !== 2 || attempts.some((attempt) => attempt.exitCode !== 0)) {
  console.error('Flaky check failed before two consecutive successful test runs.');
  process.exit(1);
}
