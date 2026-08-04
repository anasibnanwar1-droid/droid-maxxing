import fs from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DesignReference } from '../browser/types.js';
import { referenceImageDir, referenceLibraryFile } from './designPaths.js';
import type { DesignLibraryItem } from './types.js';

const MAX_ITEMS = 200;
const MAX_IMPORTED_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMPORTED_IMAGE_BASE64_LENGTH = 4 * Math.ceil(MAX_IMPORTED_IMAGE_BYTES / 3);
const IMPORTED_IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
} as const;

type ImportedImageMimeType = keyof typeof IMPORTED_IMAGE_TYPES;

export function listLibraryItems(cwd: string, baseDir?: string): DesignLibraryItem[] {
  try {
    const raw = fs.readFileSync(referenceLibraryFile(cwd, baseDir), 'utf8');
    const parsed = JSON.parse(raw) as { items?: DesignLibraryItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

export interface SaveReferenceInput {
  cwd: string;
  reference: DesignReference;
  name?: string;
  note?: string;
  baseDir?: string;
}

export function saveReference(input: SaveReferenceInput): DesignLibraryItem[] {
  const { cwd, reference, baseDir } = input;
  const id = `lib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const name = [input.name?.trim(), reference.anchor.label, reference.anchor.tag].find(Boolean);
  const note = input.note?.trim();
  const item: DesignLibraryItem = {
    id,
    name: name ?? 'Reference',
    note: note === '' ? undefined : note,
    url: reference.url,
    createdAt: new Date().toISOString(),
    screenshotPath: persistScreenshot(cwd, id, reference, baseDir),
    selector: reference.detail?.selector,
    source: reference.anchor.source
      ? {
          component: reference.anchor.source.component,
          file: reference.anchor.source.file,
          line: reference.anchor.source.line,
        }
      : undefined,
    styles: reference.detail?.styles,
    html: reference.detail?.html?.slice(0, 20_000),
  };
  const items = retainNewestItems(cwd, [item, ...listLibraryItems(cwd, baseDir)], baseDir);
  writeItems(cwd, items, baseDir);
  return items;
}

export function importReferenceImage(input: {
  cwd: string;
  id: string;
  name: string;
  category: 'moodboard' | 'inspiration' | 'reference';
  dataUrl: string;
  baseDir?: string;
}): DesignLibraryItem[] {
  if (!/^canvas-[a-z0-9-]{1,80}$/.test(input.id)) {
    throw new Error('Canvas image id is invalid.');
  }
  const items = listLibraryItems(input.cwd, input.baseDir);
  if (items.some((item) => item.id === input.id)) {
    throw new Error(`Canvas image ${input.id} already exists.`);
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    input.dataUrl,
  );
  if (!match || match[2].length % 4 !== 0) {
    throw new Error('Canvas images must be PNG, JPEG, WebP, or GIF data URLs.');
  }
  const mimeType = match[1] as ImportedImageMimeType;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMPORTED_IMAGE_BYTES) {
    throw new Error('Canvas images must be between 1 byte and 20 MB.');
  }

  const dir = referenceImageDir(input.cwd, input.baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const screenshotPath = path.join(dir, `${input.id}${IMPORTED_IMAGE_TYPES[mimeType]}`);
  fs.writeFileSync(screenshotPath, bytes);

  const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Canvas image';
  const item: DesignLibraryItem = {
    id: input.id,
    name,
    url: `droidex://canvas/${input.id}`,
    createdAt: new Date().toISOString(),
    screenshotPath,
    mimeType,
    category: input.category,
  };
  const next = retainNewestItems(input.cwd, [item, ...items], input.baseDir);
  writeItems(input.cwd, next, input.baseDir);
  return next;
}

export function deleteLibraryItem(cwd: string, id: string, baseDir?: string): DesignLibraryItem[] {
  const items = listLibraryItems(cwd, baseDir);
  const target = items.find((item) => item.id === id);
  const rest = items.filter((item) => item.id !== id);
  writeItems(cwd, rest, baseDir);
  if (target?.screenshotPath) {
    removeStoredImage(cwd, target.screenshotPath, baseDir);
  }
  return rest;
}

export function getLibraryItem(
  cwd: string,
  id: string,
  baseDir?: string,
): DesignLibraryItem | undefined {
  return listLibraryItems(cwd, baseDir).find((item) => item.id === id);
}

export async function resolveReferenceImagePath(
  cwd: string,
  screenshotPath: string,
  baseDir?: string,
): Promise<string | undefined> {
  try {
    const [root, candidate] = await Promise.all([
      realpath(referenceImageDir(cwd, baseDir)),
      realpath(screenshotPath),
    ]);
    const info = await stat(candidate);
    if (!info.isFile() || !isWithin(root, candidate)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

function writeItems(cwd: string, items: DesignLibraryItem[], baseDir?: string): void {
  const file = referenceLibraryFile(cwd, baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ items }, null, 2), 'utf8');
}

function retainNewestItems(
  cwd: string,
  items: DesignLibraryItem[],
  baseDir?: string,
): DesignLibraryItem[] {
  const retained = items.slice(0, MAX_ITEMS);
  const retainedImages = new Set(retained.flatMap((item) => item.screenshotPath ?? []));
  for (const item of items.slice(MAX_ITEMS)) {
    if (item.screenshotPath && !retainedImages.has(item.screenshotPath)) {
      removeStoredImage(cwd, item.screenshotPath, baseDir);
    }
  }
  return retained;
}

function removeStoredImage(cwd: string, imagePath: string, baseDir?: string): void {
  const imageRoot = path.resolve(referenceImageDir(cwd, baseDir));
  const candidate = path.resolve(imagePath);
  if (candidate.startsWith(`${imageRoot}${path.sep}`)) fs.rmSync(candidate, { force: true });
}

function persistScreenshot(
  cwd: string,
  id: string,
  reference: DesignReference,
  baseDir?: string,
): string | undefined {
  const base64 = reference.screenshot?.base64;
  if (base64) {
    try {
      if (
        base64.length > MAX_IMPORTED_IMAGE_BASE64_LENGTH ||
        base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
      ) {
        return undefined;
      }
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0 || bytes.length > MAX_IMPORTED_IMAGE_BYTES) return undefined;
      const dir = referenceImageDir(cwd, baseDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.png`);
      fs.writeFileSync(file, bytes);
      return file;
    } catch {
      return undefined;
    }
  }
  if (reference.anchor.screenshotPath) {
    try {
      const bytes = readBoundedImage(reference.anchor.screenshotPath);
      if (!bytes) return undefined;
      const dir = referenceImageDir(cwd, baseDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(
        dir,
        `${id}${path.extname(reference.anchor.screenshotPath) || '.png'}`,
      );
      fs.writeFileSync(file, bytes);
      return file;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readBoundedImage(file: string): Buffer | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size === 0 || info.size > MAX_IMPORTED_IMAGE_BYTES) return undefined;
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) return undefined;
      offset += read;
    }
    return bytes;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
