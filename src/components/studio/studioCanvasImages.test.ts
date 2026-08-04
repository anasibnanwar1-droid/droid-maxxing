import assert from 'node:assert/strict';
import test from 'node:test';

import { canvasImageName, fittedCanvasImageSize } from './studioCanvasImages';

test('fittedCanvasImageSize preserves aspect ratio while fitting large images', () => {
  assert.deepEqual(fittedCanvasImageSize(2400, 1600), { width: 420, height: 280 });
});

test('fittedCanvasImageSize makes small images readable without distortion', () => {
  assert.deepEqual(fittedCanvasImageSize(20, 10), { width: 144, height: 72 });
});

test('fittedCanvasImageSize keeps extreme aspect ratios within the canvas bounds', () => {
  assert.deepEqual(fittedCanvasImageSize(1000, 10), { width: 420, height: 4 });
});

test('canvasImageName numbers a generic image batch sequentially from its initial count', () => {
  const initialCount = 4;
  const names = ['image.png', 'image 2.png', 'image_3.png'].map((fileName, placed) =>
    canvasImageName(fileName, initialCount + placed + 1),
  );

  assert.deepEqual(names, ['Inspiration 5', 'Inspiration 6', 'Inspiration 7']);
});
