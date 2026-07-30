import { createCanvas } from '@napi-rs/canvas';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createModelReferenceDerivative,
  MODEL_REFERENCE_MAX_SOURCE_EDGE_PX,
  MODEL_REFERENCE_MAX_SOURCE_PIXELS,
} from './modelReferenceImage.js';

test('inspects supported image dimensions before preparing derivatives', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-image-headers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const canvas = createCanvas(32, 24);
  const images = [
    { extension: 'png', mimeType: 'image/png', bytes: canvas.encodeSync('png') },
    { extension: 'jpg', mimeType: 'image/jpeg', bytes: canvas.encodeSync('jpeg', 80) },
    { extension: 'webp', mimeType: 'image/webp', bytes: canvas.encodeSync('webp', 80) },
    { extension: 'gif', mimeType: 'image/gif', bytes: canvas.encodeSync('gif', 80) },
  ];

  for (const image of images) {
    const path = join(dir, `source.${image.extension}`);
    writeFileSync(path, image.bytes);
    const derivative = await createModelReferenceDerivative({ path });

    assert.equal(derivative.source.mimeType, image.mimeType);
    assert.equal(derivative.source.width, 32);
    assert.equal(derivative.source.height, 24);
  }
});

test('rejects unsafe source dimensions before native decoding', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-image-dimensions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = createCanvas(1, 1).encodeSync('png');
  const cases = [
    {
      name: 'edge',
      width: MODEL_REFERENCE_MAX_SOURCE_EDGE_PX + 1,
      height: 1,
    },
    {
      name: 'pixels',
      width: 10_000,
      height: Math.floor(MODEL_REFERENCE_MAX_SOURCE_PIXELS / 10_000) + 1,
    },
  ];

  for (const input of cases) {
    const bytes = Buffer.from(original);
    bytes.writeUInt32BE(input.width, 16);
    bytes.writeUInt32BE(input.height, 20);
    const path = join(dir, `${input.name}.png`);
    writeFileSync(path, bytes);

    await assert.rejects(
      createModelReferenceDerivative({ path }),
      /dimensions .* exceed .* preparation limit/,
    );
  }
});
