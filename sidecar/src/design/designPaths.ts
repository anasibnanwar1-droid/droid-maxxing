import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export function designDataRoot(baseDir = defaultDataRoot()): string {
  return join(baseDir, 'design');
}

// Per-project storage keyed by a stable hash of the workspace path, so
// renames of the folder name alone do not orphan saved references.
export function projectDesignDir(cwd: string, baseDir?: string): string {
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 12);
  return join(designDataRoot(baseDir), `${sanitizeSegment(basename(cwd))}-${hash}`);
}

export function referenceLibraryFile(cwd: string, baseDir?: string): string {
  return join(projectDesignDir(cwd, baseDir), 'library.json');
}

export function referenceImageDir(cwd: string, baseDir?: string): string {
  return join(projectDesignDir(cwd, baseDir), 'images');
}

// Prototypes live inside the repo so agents can write them with plain
// file tools and users can commit the ones worth keeping.
export function prototypesDir(cwd: string): string {
  return join(cwd, '.droidex', 'prototypes');
}

export function validatorConfigFile(cwd: string): string {
  return join(cwd, '.droidex', 'validator.json');
}

function defaultDataRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'Droid Control');
}

function sanitizeSegment(value: string): string {
  const segment = value.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  return segment || 'project';
}
