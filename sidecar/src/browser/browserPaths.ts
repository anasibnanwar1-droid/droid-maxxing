import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const MAC_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function resolveChromePath(path = MAC_CHROME_PATH): string {
  if (!existsSync(path)) {
    throw new Error(`Google Chrome was not found at ${path}. Install Google Chrome for macOS, then reopen Browser Mode.`);
  }
  return path;
}

export function browserDataRoot(baseDir = defaultBrowserDataRoot()): string {
  return baseDir;
}

export function browserProfileDir(sessionId: string, baseDir?: string): string {
  return join(browserDataRoot(baseDir), 'browser-profiles', sanitizeSegment(sessionId));
}

export function browserScreenshotDir(sessionId: string, baseDir?: string): string {
  return join(browserDataRoot(baseDir), 'browser-screenshots', sanitizeSegment(sessionId));
}

export function browserDesignReferenceDir(missionId: string, baseDir?: string): string {
  return join(browserDataRoot(baseDir), 'design-references', sanitizeSegment(missionId));
}

export function isBrowserAssetPath(filePath: string, baseDir?: string): boolean {
  const root = resolve(browserDataRoot(baseDir));
  const target = resolve(filePath);
  return target === root || target.startsWith(`${root}${sep}`);
}

function defaultBrowserDataRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'Droid Control');
}

function sanitizeSegment(value: string): string {
  const segment = value.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  return segment || 'default';
}
