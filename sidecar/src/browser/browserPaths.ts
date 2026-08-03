import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

export function browserDataRoot(baseDir = defaultBrowserDataRoot()): string {
  return baseDir;
}

export function browserDesignReferenceDir(appSessionId: string, baseDir?: string): string {
  return join(browserDataRoot(baseDir), 'design-references', sanitizeSegment(appSessionId));
}

export function isBrowserAssetPath(filePath: string, baseDir?: string): boolean {
  const root = resolve(browserDataRoot(baseDir));
  const target = resolve(filePath);
  return target === root || target.startsWith(`${root}${sep}`);
}

export async function resolveBrowserAssetPath(
  filePath: string,
  baseDir?: string,
): Promise<string | null> {
  const [root, target] = await Promise.all([
    realpath(browserDataRoot(baseDir)),
    realpath(filePath),
  ]);
  return target === root || target.startsWith(`${root}${sep}`) ? target : null;
}

function defaultBrowserDataRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'Droid Control');
}

function sanitizeSegment(value: string): string {
  const segment = value.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  return segment || 'default';
}
