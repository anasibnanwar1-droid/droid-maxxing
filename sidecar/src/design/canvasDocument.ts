import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  canvasContentSchema,
  canvasDocumentSchema,
  canvasEntityIdSchema,
  formatCanvasSchemaIssues,
  type CanvasDocument,
  type CanvasDocumentContent,
} from './canvasDocumentSchema.js';
import { designDataRoot } from './designPaths.js';
import { resolveDesignProjectIdentity } from './projectIdentity.js';

export const MAX_CANVAS_DOCUMENT_BYTES = 2 * 1024 * 1024;
export type {
  CanvasAnnotationRecord,
  CanvasDocument,
  CanvasDocumentContent,
  CanvasFrameRecord,
  CanvasFrameSource,
  CanvasImagePlacement,
} from './canvasDocumentSchema.js';

export class CanvasDocumentValidationError extends Error {
  override name = 'CanvasDocumentValidationError';
}

export class CanvasDocumentCorruptError extends Error {
  override name = 'CanvasDocumentCorruptError';
}

export class CanvasDocumentRevisionConflictError extends Error {
  override name = 'CanvasDocumentRevisionConflictError';

  constructor(
    readonly threadId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Canvas revision conflict for thread ${threadId}: expected ${String(expectedRevision)}, found ${String(actualRevision)}. Reload the canvas and retry.`,
    );
  }
}

export function canvasDocumentPath(input: {
  cwd: string;
  threadId: string;
  baseDir?: string;
}): string {
  return resolveCanvasLocation(input).file;
}

export function readCanvasDocument(input: {
  cwd: string;
  threadId: string;
  baseDir?: string;
}): CanvasDocument | null {
  return readCanvasDocumentAt(resolveCanvasLocation(input));
}

function readCanvasDocumentAt(location: CanvasLocation): CanvasDocument | null {
  const { file, projectId, threadId } = location;
  let raw: string;
  try {
    const info = statSync(file);
    if (info.size > MAX_CANVAS_DOCUMENT_BYTES) {
      throw corrupt(file, `file exceeds ${String(MAX_CANVAS_DOCUMENT_BYTES)} bytes`);
    }
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    if (error instanceof CanvasDocumentCorruptError) throw error;
    throw new Error(`Could not read canvas document ${file}: ${messageOf(error)}`, {
      cause: error,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw corrupt(file, `invalid JSON (${messageOf(error)})`, error);
  }
  const parsed = canvasDocumentSchema.safeParse(value);
  if (!parsed.success) throw corrupt(file, formatCanvasSchemaIssues(parsed.error));
  if (parsed.data.projectId !== projectId || parsed.data.threadId !== threadId) {
    throw corrupt(file, 'stored project or thread identity does not match its path');
  }
  return parsed.data;
}

export function writeCanvasDocument(input: {
  cwd: string;
  threadId: string;
  expectedRevision: number;
  content: CanvasDocumentContent;
  baseDir?: string;
  now?: () => Date;
}): CanvasDocument {
  const location = resolveCanvasLocation(input);
  const { projectId, threadId } = location;
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new CanvasDocumentValidationError(
      'Expected canvas revision must be a non-negative integer.',
    );
  }
  const content = canvasContentSchema.safeParse(input.content);
  if (!content.success) {
    throw new CanvasDocumentValidationError(
      `Canvas document is invalid: ${formatCanvasSchemaIssues(content.error)}`,
    );
  }

  const current = readCanvasDocumentAt(location);
  const actualRevision = current?.revision ?? 0;
  if (actualRevision !== input.expectedRevision) {
    throw new CanvasDocumentRevisionConflictError(threadId, input.expectedRevision, actualRevision);
  }
  const document: CanvasDocument = {
    schemaVersion: 1,
    projectId,
    threadId,
    revision: actualRevision + 1,
    updatedAt: (input.now?.() ?? new Date()).toISOString(),
    ...content.data,
  };
  const validated = canvasDocumentSchema.safeParse(document);
  if (!validated.success) {
    throw new CanvasDocumentValidationError(
      `Canvas document is invalid: ${formatCanvasSchemaIssues(validated.error)}`,
    );
  }
  const serialized = `${JSON.stringify(validated.data, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CANVAS_DOCUMENT_BYTES) {
    throw new CanvasDocumentValidationError(
      `Canvas document exceeds ${String(MAX_CANVAS_DOCUMENT_BYTES)} bytes.`,
    );
  }
  atomicWrite(location.file, serialized);
  return validated.data;
}

function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(
    dirname(file),
    `.${basename(file)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw new Error(`Could not save canvas document ${file}: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

function parseThreadId(threadId: string): string {
  const parsed = canvasEntityIdSchema.safeParse(threadId);
  if (!parsed.success) {
    throw new CanvasDocumentValidationError(
      `Canvas thread id is invalid: ${formatCanvasSchemaIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

interface CanvasLocation {
  projectId: string;
  threadId: string;
  file: string;
}

function resolveCanvasLocation(input: {
  cwd: string;
  threadId: string;
  baseDir?: string;
}): CanvasLocation {
  const threadId = parseThreadId(input.threadId);
  const projectId = resolveDesignProjectIdentity(input.cwd).id;
  const fileName = createHash('sha256').update(threadId).digest('hex').slice(0, 32);
  const file = join(
    designDataRoot(input.baseDir),
    'projects',
    projectId,
    'canvases',
    `${fileName}.json`,
  );
  return { projectId, threadId, file };
}

function corrupt(file: string, detail: string, cause?: unknown): CanvasDocumentCorruptError {
  return new CanvasDocumentCorruptError(
    `Canvas document ${file} is corrupt: ${detail}. Delete that file to reset this thread canvas.`,
    cause === undefined ? undefined : { cause },
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
