import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampCropRect,
  dataUrlMime,
  displayedToNaturalRect,
  fitWithin,
  isFullImageRect,
  isPersistableMime,
  MIN_CROP_SIDE,
} from './images';

test('fitWithin returns the size unchanged when it already fits', () => {
  assert.deepEqual(fitWithin({ width: 800, height: 600 }, 2048), { width: 800, height: 600 });
});

test('fitWithin never upscales, even with a huge cap', () => {
  assert.deepEqual(fitWithin({ width: 100, height: 50 }, 99999), { width: 100, height: 50 });
});

test('fitWithin scales a landscape image by its width', () => {
  assert.deepEqual(fitWithin({ width: 4096, height: 2048 }, 2048), { width: 2048, height: 1024 });
});

test('fitWithin scales a portrait image by its height', () => {
  assert.deepEqual(fitWithin({ width: 1000, height: 4000 }, 2000), { width: 500, height: 2000 });
});

test('fitWithin treats a zero cap as no resizing', () => {
  assert.deepEqual(fitWithin({ width: 5000, height: 5000 }, 0), { width: 5000, height: 5000 });
});

test('fitWithin keeps at least one pixel on tiny results', () => {
  assert.deepEqual(fitWithin({ width: 5000, height: 2 }, 1000), { width: 1000, height: 1 });
});

const IMAGE = { width: 1000, height: 500 };

test('clampCropRect keeps a valid rect as-is', () => {
  assert.deepEqual(clampCropRect({ x: 10, y: 10, width: 200, height: 100 }, IMAGE), {
    x: 10,
    y: 10,
    width: 200,
    height: 100,
  });
});

test('clampCropRect clamps overflow back into the image', () => {
  assert.deepEqual(clampCropRect({ x: 900, y: 400, width: 500, height: 500 }, IMAGE), {
    x: 500,
    y: 0,
    width: 500,
    height: 500,
  });
});

test('clampCropRect enforces the minimum crop side', () => {
  const out = clampCropRect({ x: 0, y: 0, width: 1, height: 1 }, IMAGE);
  assert.equal(out.width, MIN_CROP_SIDE);
  assert.equal(out.height, MIN_CROP_SIDE);
});

test('clampCropRect handles negative origins', () => {
  assert.deepEqual(clampCropRect({ x: -50, y: -20, width: 100, height: 100 }, IMAGE), {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
});

test('displayedToNaturalRect scales a half-size preview back to natural pixels', () => {
  const natural = { width: 2000, height: 1000 };
  const displayed = { width: 1000, height: 500 };
  assert.deepEqual(
    displayedToNaturalRect({ x: 100, y: 50, width: 400, height: 200 }, displayed, natural),
    { x: 200, y: 100, width: 800, height: 400 },
  );
});

test('displayedToNaturalRect clamps the mapped rect to the image', () => {
  const natural = { width: 2000, height: 1000 };
  const displayed = { width: 1000, height: 500 };
  const out = displayedToNaturalRect(
    { x: 900, y: 450, width: 400, height: 200 },
    displayed,
    natural,
  );
  assert.ok(out.x + out.width <= natural.width);
  assert.ok(out.y + out.height <= natural.height);
});

test('isFullImageRect detects a no-op crop', () => {
  const image = { width: 100, height: 100 };
  assert.equal(isFullImageRect({ x: 0, y: 0, width: 100, height: 100 }, image), true);
  assert.equal(isFullImageRect({ x: 1, y: 0, width: 100, height: 100 }, image), false);
});

test('dataUrlMime reads the MIME type from a data URL', () => {
  assert.equal(dataUrlMime('data:image/png;base64,iVBOR'), 'image/png');
  assert.equal(dataUrlMime('data:image/svg+xml;base64,PHN2Zw'), 'image/svg+xml');
  assert.equal(dataUrlMime('not-a-data-url'), undefined);
});

test('isPersistableMime matches the desktop store allowlist', () => {
  assert.equal(isPersistableMime('image/png'), true);
  assert.equal(isPersistableMime('image/jpeg'), true);
  assert.equal(isPersistableMime('image/webp'), true);
  assert.equal(isPersistableMime('image/gif'), true);
  assert.equal(isPersistableMime('image/svg+xml'), false);
  assert.equal(isPersistableMime('image/avif'), false);
  assert.equal(isPersistableMime(undefined), false);
});
