import fs from 'node:fs';
import path from 'node:path';
import { getActiveDnaId } from './savedDna.js';
import { parseMotionTokens } from './motionTokens.js';
import { parseTokens } from './tokens.js';
import type { DnaFileState, DnaState } from './types.js';

const DESIGN_FILE = 'DESIGN.md';
const MOTION_FILE = 'MOTION.md';

export const MAX_DNA_BYTES = 256 * 1024;

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
    motionTokens: motion.exists ? parseMotionTokens(motion.content) : undefined,
    activeSavedId: getActiveDnaId(cwd),
  };
}

export function readDnaFile(cwd: string, kind: DnaFileKind): DnaFileState {
  const filePath = dnaFilePath(cwd, kind);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const info = fs.fstatSync(descriptor);
    if (info.size > MAX_DNA_BYTES) throw dnaSizeError(filePath, info.size);
    const content = fs.readFileSync(descriptor, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_DNA_BYTES) throw dnaSizeError(filePath, bytes);
    return { path: filePath, exists: true, content };
  } catch (error) {
    if (isMissingFile(error)) return { path: filePath, exists: false, content: '' };
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function writeDnaFile(cwd: string, kind: DnaFileKind, content: string): DnaFileState {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Workspace directory not found: ${cwd}`);
  }
  const filePath = dnaFilePath(cwd, kind);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_DNA_BYTES) throw dnaSizeError(filePath, bytes);
  fs.writeFileSync(filePath, content, 'utf8');
  return { path: filePath, exists: true, content };
}

function dnaSizeError(filePath: string, bytes: number): Error {
  return new Error(
    `${filePath} is ${String(bytes)} bytes; Design DNA files must not exceed ${String(MAX_DNA_BYTES)} bytes.`,
  );
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
