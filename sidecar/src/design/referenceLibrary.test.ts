import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importReferenceImage, listLibraryItems } from './referenceLibrary.js';

test('importReferenceImage preserves original bytes and canvas metadata', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'droidex-canvas-image-'));
  const cwd = join(baseDir, 'product');
  mkdirSync(cwd);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01, 0x02, 0x03]);
  const items = importReferenceImage({
    cwd,
    id: 'canvas-reference-1',
    name: '  Warm editorial direction  ',
    category: 'moodboard',
    dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
    baseDir,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Warm editorial direction');
  assert.equal(items[0].category, 'moodboard');
  assert.equal(items[0].mimeType, 'image/jpeg');
  assert.match(items[0].screenshotPath ?? '', /canvas-reference-1\.jpg$/);
  assert.deepEqual(readFileSync(items[0].screenshotPath ?? ''), bytes);
  assert.deepEqual(listLibraryItems(cwd, baseDir), items);
});

test('reference eviction removes the evicted durable image file', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'droidex-canvas-image-eviction-'));
  const cwd = join(baseDir, 'product');
  mkdirSync(cwd);
  let oldestPath = '';
  for (let index = 0; index <= 200; index += 1) {
    const items = importReferenceImage({
      cwd,
      id: `canvas-reference-${String(index)}`,
      name: `Reference ${String(index)}`,
      category: 'reference',
      dataUrl: 'data:image/png;base64,YQ==',
      baseDir,
    });
    if (index === 0) oldestPath = items[0]?.screenshotPath ?? '';
  }

  assert.equal(listLibraryItems(cwd, baseDir).length, 200);
  assert.equal(existsSync(oldestPath), false);
});

test('importReferenceImage rejects untrusted ids and image formats', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'droidex-canvas-image-invalid-'));
  const input = {
    cwd: '/workspace/product',
    name: 'Reference',
    category: 'inspiration' as const,
    baseDir,
  };

  assert.throws(
    () =>
      importReferenceImage({
        ...input,
        id: '../escape',
        dataUrl: 'data:image/png;base64,YWJj',
      }),
    /id is invalid/,
  );
  assert.throws(
    () =>
      importReferenceImage({
        ...input,
        id: 'canvas-reference-2',
        dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
      }),
    /PNG, JPEG, WebP, or GIF/,
  );
});
