import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanRepoForDna } from './dnaScan.js';
import { parseMotionTokens } from './motionTokens.js';
import { scanComponentRegistry } from './registryScan.js';

function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droidex-design-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

test('scanRepoForDna extracts tailwind colors, css props and fonts', (t) => {
  const cwd = makeRepo({
    'tailwind.config.js': `module.exports = { theme: { colors: { 'brand': '#e0653a', surface: '#141416' } } };`,
    'src/index.css': [
      ':root { --ink: #f2f2f2; }',
      'body { font-family: Inter, sans-serif; font-size: 14px; }',
      'code { font-family: JetBrains Mono, monospace; }',
      '.card { border-radius: 10px; padding: 16px; }',
    ].join('\n'),
    'node_modules/pkg/skip.css': ':root { --evil: #ff0000; }',
  });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const draft = scanRepoForDna(cwd);
  assert.equal(draft.cwd, cwd);
  assert.equal(draft.tokens.colors.brand, '#e0653a');
  assert.equal(draft.tokens.colors.ink, '#f2f2f2');
  assert.ok(!Object.values(draft.tokens.colors).includes('#ff0000'));
  assert.ok(draft.tokens.fonts.sans?.includes('Inter'));
  assert.ok(draft.tokens.fonts.mono?.includes('Mono'));
  assert.ok(draft.tokens.typeScale.includes(14));
  assert.ok(draft.tokens.radii.includes(10));
  assert.ok(draft.sources.includes('tailwind.config.js'));
  assert.ok(draft.content.includes('```design-tokens'));
  assert.ok(draft.content.includes('## Palette'));
  assert.deepEqual(parseMotionTokens(draft.motion)?.durations.micro, [120, 160]);
});

test('scanRepoForDna produces a usable draft for an empty project', (t) => {
  const cwd = makeRepo({ 'README.md': '# empty' });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const draft = scanRepoForDna(cwd);
  assert.deepEqual(draft.tokens.colors, {});
  assert.ok(draft.content.includes('No colors found'));
});

test('scanComponentRegistry finds exported components with file and line', (t) => {
  const cwd = makeRepo({
    'src/Button.tsx': [
      'export default function Button({ label }: { label: string }) {',
      '  return <button>{label}</button>;',
      '}',
    ].join('\n'),
    'src/cards/StatCard.tsx': [
      'import React from "react";',
      '',
      'export function StatCard({ value }: { value: number }) {',
      '  return <div>{value}</div>;',
      '}',
      '',
      'export const MiniStat = ({ value }: { value: number }) => <span>{value}</span>;',
    ].join('\n'),
    'src/Button.test.tsx': 'export function NotAComponentTest() { return null; }',
    'src/util.ts': 'export function helper() { return 1; }',
  });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const entries = scanComponentRegistry(cwd);
  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names, ['Button', 'MiniStat', 'StatCard']);

  const button = entries.find((entry) => entry.name === 'Button');
  assert.equal(button?.file, path.join('src', 'Button.tsx'));
  assert.equal(button?.line, 1);
  assert.equal(button?.exportKind, 'default');
  assert.ok(button?.props?.includes('label'));

  const statCard = entries.find((entry) => entry.name === 'StatCard');
  assert.equal(statCard?.exportKind, 'named');
  assert.equal(statCard?.line, 3);
});

test('scanComponentRegistry skips lowercase exports and dedupes per file', (t) => {
  const cwd = makeRepo({
    'src/dupe.tsx': [
      'export function Widget() { return null; }',
      'export const Widget2 = () => null;',
      'export function widgetHelper() { return null; }',
    ].join('\n'),
  });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const names = scanComponentRegistry(cwd).map((entry) => entry.name);
  assert.deepEqual(names, ['Widget', 'Widget2']);
});
