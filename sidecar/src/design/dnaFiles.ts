import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getActiveDnaId } from './savedDna.js';
import { parseMotionTokens } from './motionTokens.js';
import { parseTokens } from './tokens.js';
import type { DnaFileState, DnaState } from './types.js';

const DESIGN_FILE = 'DESIGN.md';
const MOTION_FILE = 'MOTION.md';

export const MAX_DNA_BYTES = 256 * 1024;
const DNA_TRANSACTION_FILE = '.droidex-dna-transaction.json';
const STAGED_DNA_FILE = /^\.(DESIGN|MOTION)\.md\.[0-9a-f-]{36}\.tmp$/;

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
  const filePath = safeDnaFilePath(cwd, kind);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
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
  const filePath = safeDnaFilePath(cwd, kind);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_DNA_BYTES) throw dnaSizeError(filePath, bytes);
  atomicWrite(filePath, content);
  return { path: filePath, exists: true, content };
}

export function writeDnaFiles(cwd: string, content: { design: string; motion: string }): DnaState {
  const paths = {
    design: safeDnaFilePath(cwd, 'design'),
    motion: safeDnaFilePath(cwd, 'motion'),
  };
  for (const kind of ['design', 'motion'] as const) {
    const bytes = Buffer.byteLength(content[kind], 'utf8');
    if (bytes > MAX_DNA_BYTES) throw dnaSizeError(paths[kind], bytes);
  }

  const originals = {
    design: readDnaFile(cwd, 'design'),
    motion: readDnaFile(cwd, 'motion'),
  };
  let stagedDesign: string | undefined;
  let stagedMotion: string | undefined;
  try {
    stagedDesign = stageWrite(paths.design, content.design);
    stagedMotion = stageWrite(paths.motion, content.motion);
  } catch (error) {
    if (stagedDesign) fs.rmSync(stagedDesign, { force: true });
    throw error;
  }
  const staged = { design: stagedDesign, motion: stagedMotion };
  const transactionPath = path.join(path.dirname(paths.design), DNA_TRANSACTION_FILE);
  const committed: DnaFileKind[] = [];
  try {
    atomicWrite(
      transactionPath,
      JSON.stringify({
        version: 1,
        design: path.basename(staged.design),
        motion: path.basename(staged.motion),
      }),
    );
    for (const kind of ['design', 'motion'] as const) {
      fs.renameSync(staged[kind], paths[kind]);
      committed.push(kind);
    }
    fsyncDirectory(path.dirname(paths.design));
    fs.rmSync(transactionPath, { force: true });
    fsyncDirectory(path.dirname(paths.design));
  } catch (error) {
    for (const kind of committed.reverse()) {
      const original = originals[kind];
      if (original.exists) atomicWrite(paths[kind], original.content);
      else fs.rmSync(paths[kind], { force: true });
    }
    fs.rmSync(transactionPath, { force: true });
    throw error;
  } finally {
    fs.rmSync(staged.design, { force: true });
    fs.rmSync(staged.motion, { force: true });
  }
  return readDnaState(cwd);
}

function safeDnaFilePath(cwd: string, kind: DnaFileKind): string {
  let root: string;
  try {
    root = fs.realpathSync(cwd);
  } catch {
    throw new Error(`Workspace directory not found: ${cwd}`);
  }
  if (!fs.statSync(root).isDirectory()) throw new Error(`Workspace directory not found: ${cwd}`);
  recoverDnaTransaction(root);
  const filePath = dnaFilePath(root, kind);
  try {
    const info = fs.lstatSync(filePath);
    if (info.isSymbolicLink()) {
      throw new Error(`Design DNA files must not be symbolic links: ${filePath}`);
    }
    if (!info.isFile()) throw new Error(`Design DNA path is not a file: ${filePath}`);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return filePath;
}

function recoverDnaTransaction(root: string): void {
  const transactionPath = path.join(root, DNA_TRANSACTION_FILE);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(transactionPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  try {
    const journal = fs.readFileSync(descriptor, 'utf8');
    fs.closeSync(descriptor);
    descriptor = undefined;
    const raw: unknown = JSON.parse(journal);
    if (!isDnaTransaction(raw)) {
      throw new Error(`Invalid Design DNA transaction journal: ${transactionPath}`);
    }
    for (const kind of ['design', 'motion'] as const) {
      const stagedPath = path.join(root, raw[kind]);
      if (!fs.existsSync(stagedPath)) continue;
      const info = fs.lstatSync(stagedPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Invalid staged Design DNA file: ${stagedPath}`);
      }
      fs.renameSync(stagedPath, dnaFilePath(root, kind));
    }
    fsyncDirectory(root);
    fs.rmSync(transactionPath, { force: true });
    fsyncDirectory(root);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isDnaTransaction(value: unknown): value is { version: 1; design: string; motion: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.design === 'string' &&
    typeof candidate.motion === 'string' &&
    STAGED_DNA_FILE.test(candidate.design) &&
    STAGED_DNA_FILE.test(candidate.motion) &&
    candidate.design.startsWith('.DESIGN.md.') &&
    candidate.motion.startsWith('.MOTION.md.')
  );
}

function atomicWrite(filePath: string, content: string): void {
  const staged = stageWrite(filePath, content);
  try {
    fs.renameSync(staged, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

function stageWrite(filePath: string, content: string): string {
  const staged = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      staged,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    return staged;
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) return;
    throw error;
  }
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EISDIR' || error.code === 'EINVAL' || error.code === 'EPERM')
  );
}

function dnaSizeError(filePath: string, bytes: number): Error {
  return new Error(
    `${filePath} is ${String(bytes)} bytes; Design DNA files must not exceed ${String(MAX_DNA_BYTES)} bytes.`,
  );
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
