import fs from 'node:fs';
import path from 'node:path';
import { getActiveDnaId } from './savedDna.js';
import { parseTokens } from './tokens.js';
import type { DnaFileState, DnaState } from './types.js';

export const DESIGN_FILE = 'DESIGN.md';
export const MOTION_FILE = 'MOTION.md';

const MAX_DNA_BYTES = 256 * 1024;

export type DnaFileKind = 'design' | 'motion';

export function dnaFilePath(cwd: string, kind: DnaFileKind): string {
  return path.join(cwd, kind === 'design' ? DESIGN_FILE : MOTION_FILE);
}

export function readDnaState(cwd: string): DnaState {
  const design = readDnaFile(cwd, 'design');
  const motion = readDnaFile(cwd, 'motion');
  return {
    cwd,
    design,
    motion,
    tokens: design.exists ? parseTokens(design.content) : undefined,
    activeSavedId: getActiveDnaId(cwd),
  };
}

export function readDnaFile(cwd: string, kind: DnaFileKind): DnaFileState {
  const filePath = dnaFilePath(cwd, kind);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { path: filePath, exists: true, content: content.slice(0, MAX_DNA_BYTES) };
  } catch {
    return { path: filePath, exists: false, content: '' };
  }
}

export function writeDnaFile(cwd: string, kind: DnaFileKind, content: string): DnaFileState {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Workspace directory not found: ${cwd}`);
  }
  const filePath = dnaFilePath(cwd, kind);
  fs.writeFileSync(filePath, content.slice(0, MAX_DNA_BYTES), 'utf8');
  return { path: filePath, exists: true, content };
}
