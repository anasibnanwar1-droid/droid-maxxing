import fs from 'node:fs';
import path from 'node:path';
import { prototypesDir } from './designPaths.js';
import type { PrototypeInfo } from './types.js';

const MAX_PROTOTYPES = 24;
const MAX_HTML_BYTES = 400 * 1024;

export function listPrototypes(cwd: string): PrototypeInfo[] {
  const dir = prototypesDir(cwd);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const prototypes: PrototypeInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_HTML_BYTES) continue;
      prototypes.push({
        id: entry.name.replace(/\.html$/, ''),
        name: humanize(entry.name.replace(/\.html$/, '')),
        path: file,
        updatedAt: stat.mtime.toISOString(),
        html: fs.readFileSync(file, 'utf8'),
      });
    } catch {
      continue;
    }
  }
  return prototypes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_PROTOTYPES);
}

export function prototypePromptGuidance(cwd: string): string {
  const dir = prototypesDir(cwd);
  return [
    'When asked for design variations, write each one as a self-contained HTML',
    `file (inline CSS, no build step) under ${dir}. Use kebab-case file names`,
    'that describe the variant, one variant per file.',
  ].join(' ');
}

function humanize(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}
