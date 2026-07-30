import fs from 'node:fs';
import path from 'node:path';
import type { DesignReference } from '../browser/types.js';
import { referenceImageDir, referenceLibraryFile } from './designPaths.js';
import type { DesignLibraryItem } from './types.js';

const MAX_ITEMS = 200;
const MAX_IMPORTED_IMAGE_BYTES = 20 * 1024 * 1024;
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
  const item: DesignLibraryItem = {
    id,
    name: input.name?.trim() || reference.anchor.label || reference.anchor.tag || 'Reference',
    note: input.note?.trim() || undefined,
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
  const items = [item, ...listLibraryItems(cwd, baseDir)].slice(0, MAX_ITEMS);
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
  const next = [item, ...items].slice(0, MAX_ITEMS);
  writeItems(input.cwd, next, input.baseDir);
  return next;
}

export function deleteLibraryItem(cwd: string, id: string, baseDir?: string): DesignLibraryItem[] {
  const items = listLibraryItems(cwd, baseDir);
  const target = items.find((item) => item.id === id);
  const rest = items.filter((item) => item.id !== id);
  writeItems(cwd, rest, baseDir);
  if (target?.screenshotPath) {
    fs.rmSync(target.screenshotPath, { force: true });
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

function writeItems(cwd: string, items: DesignLibraryItem[], baseDir?: string): void {
  const file = referenceLibraryFile(cwd, baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ items }, null, 2), 'utf8');
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
      const dir = referenceImageDir(cwd, baseDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.png`);
      fs.writeFileSync(file, Buffer.from(base64, 'base64'));
      return file;
    } catch {
      return undefined;
    }
  }
  if (reference.anchor.screenshotPath && fs.existsSync(reference.anchor.screenshotPath)) {
    try {
      const dir = referenceImageDir(cwd, baseDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(
        dir,
        `${id}${path.extname(reference.anchor.screenshotPath) || '.png'}`,
      );
      fs.copyFileSync(reference.anchor.screenshotPath, file);
      return file;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
