import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sidecarPackage = JSON.parse(readFileSync(join(root, 'sidecar/package.json'), 'utf8'));

const requiredSections = [
  '# Agent Instructions',
  '## Fast start',
  '## Required validation',
  '## Project map',
  '## Environment variables',
];

const requiredCommands = [
  'npm install',
  'npm ci --prefix sidecar',
  'npm run dev',
  'npm run build',
  'npm run test',
  'npm --prefix sidecar run test',
  'npm run typecheck',
  'npm run sidecar:typecheck',
  'npm run electron:check',
  'npm run docs:check',
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

for (const section of requiredSections) {
  if (!agents.includes(section)) fail(`AGENTS.md is missing required section: ${section}`);
}

for (const command of requiredCommands) {
  if (!agents.includes(command)) fail(`AGENTS.md is missing required command: ${command}`);
}

const rootCommandPattern = /npm run ([a-zA-Z0-9:_-]+)/g;
for (const [, script] of agents.matchAll(rootCommandPattern)) {
  if (script.startsWith('sidecar:')) {
    if (!rootPackage.scripts[script]) fail(`AGENTS.md documents missing root script: ${script}`);
    continue;
  }
  if (!rootPackage.scripts[script]) fail(`AGENTS.md documents missing root script: ${script}`);
}

const sidecarCommandPattern = /npm --prefix sidecar run ([a-zA-Z0-9:_-]+)/g;
for (const [, script] of agents.matchAll(sidecarCommandPattern)) {
  if (!sidecarPackage.scripts[script]) fail(`AGENTS.md documents missing sidecar script: ${script}`);
}

if (!process.exitCode) console.log('AGENTS.md command references are current.');
