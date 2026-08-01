import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveDesignProjectIdentity } from './projectIdentity.js';

export function designDataRoot(baseDir = defaultDataRoot()): string {
  return join(baseDir, 'design');
}

export function projectDesignDir(cwd: string, baseDir?: string): string {
  return join(designDataRoot(baseDir), resolveDesignProjectIdentity(cwd).id);
}

export function referenceLibraryFile(cwd: string, baseDir?: string): string {
  return join(projectDesignDir(cwd, baseDir), 'library.json');
}

export function savedDnaFile(cwd: string, baseDir?: string): string {
  return join(projectDesignDir(cwd, baseDir), 'saved-dna.json');
}

export function activeDnaFile(cwd: string, baseDir?: string): string {
  return join(projectDesignDir(cwd, baseDir), 'active-dna.json');
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
