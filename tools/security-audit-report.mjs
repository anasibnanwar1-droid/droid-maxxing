import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const reportsDir = join(root, 'reports', 'security');
const targets = [
  { name: 'root app', cwd: root, output: 'root-npm-audit.json' },
  { name: 'sidecar', cwd: join(root, 'sidecar'), output: 'sidecar-npm-audit.json' },
];

mkdirSync(reportsDir, { recursive: true });

const results = targets.map((target) => {
  const audit = spawnSync('npm', ['audit', '--json', '--omit=dev'], {
    cwd: target.cwd,
    encoding: 'utf8',
  });
  const raw = audit.stdout || audit.stderr || '{}';
  writeFileSync(join(reportsDir, target.output), raw);

  try {
    const parsed = JSON.parse(raw);
    return { ...target, audit, parsed };
  } catch (error) {
    return { ...target, audit, parsed: null, error };
  }
});

const lines = [
  '# Security Audit Summary',
  '',
  `Generated at ${new Date().toISOString()}.`,
  '',
  '| Package set | Critical | High | Moderate | Low | Info | Total |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
];

for (const result of results) {
  const vulnerabilities = result.parsed?.metadata?.vulnerabilities ?? {};
  const critical = vulnerabilities.critical ?? 0;
  const high = vulnerabilities.high ?? 0;
  const moderate = vulnerabilities.moderate ?? 0;
  const low = vulnerabilities.low ?? 0;
  const info = vulnerabilities.info ?? 0;
  const total = vulnerabilities.total ?? critical + high + moderate + low + info;

  lines.push(
    `| ${result.name} | ${critical} | ${high} | ${moderate} | ${low} | ${info} | ${total} |`,
  );
}

lines.push('', 'Raw npm audit JSON reports are stored next to this summary.');
writeFileSync(join(reportsDir, 'npm-audit-summary.md'), `${lines.join('\n')}\n`);

const malformed = results.filter((result) => !result.parsed);
if (malformed.length > 0) {
  console.error(`Could not parse npm audit output for: ${malformed.map((r) => r.name).join(', ')}`);
  process.exitCode = 1;
}
