import fs from 'node:fs';
import path from 'node:path';
import type { ComponentRegistryEntry } from './types.js';

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.next',
  'vendor',
]);
const MAX_FILES = 400;
const MAX_ENTRIES = 300;

const PATTERNS: { regex: RegExp; exportKind: ComponentRegistryEntry['exportKind'] }[] = [
  {
    regex: /export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)\s*(\([^)\n]*)?/g,
    exportKind: 'default',
  },
  { regex: /export\s+function\s+([A-Z][A-Za-z0-9_]*)\s*(\([^)\n]*)?/g, exportKind: 'named' },
  {
    regex:
      /export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*(?:React\.)?(?:memo|forwardRef)?\s*[(<]/g,
    exportKind: 'named',
  },
];

export function scanComponentRegistry(cwd: string): ComponentRegistryEntry[] {
  const entries: ComponentRegistryEntry[] = [];
  for (const file of collectComponentFiles(cwd)) {
    if (entries.length >= MAX_ENTRIES) break;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const relative = path.relative(cwd, file);
    for (const { regex, exportKind } of PATTERNS) {
      regex.lastIndex = 0;
      for (const match of text.matchAll(regex)) {
        if (entries.length >= MAX_ENTRIES) break;
        const name = match[1];
        if (entries.some((entry) => entry.name === name && entry.file === relative)) continue;
        entries.push({
          name,
          file: relative,
          line: lineOf(text, match.index ?? 0),
          exportKind,
          props: match[2]?.slice(0, 160),
        });
      }
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function collectComponentFiles(cwd: string): string[] {
  const out: string[] = [];
  const queue = [cwd];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const dir = queue.shift();
    if (!dir) break;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name) && !item.name.startsWith('.')) {
          queue.push(path.join(dir, item.name));
        }
        continue;
      }
      if (!item.isFile()) continue;
      if (/\.(tsx|jsx)$/.test(item.name) && !/\.(test|spec|stories)\./.test(item.name)) {
        out.push(path.join(dir, item.name));
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let at = 0; at < index && at < text.length; at += 1) {
    if (text[at] === '\n') line += 1;
  }
  return line;
}
