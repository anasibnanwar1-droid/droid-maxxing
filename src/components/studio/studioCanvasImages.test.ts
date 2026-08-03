import assert from 'node:assert/strict';
import test from 'node:test';

import { fittedCanvasImageSize } from './studioCanvasImages';

test('fittedCanvasImageSize preserves aspect ratio while fitting large images', () => {
  assert.deepEqual(fittedCanvasImageSize(2400, 1600), { width: 420, height: 280 });
});

test('fittedCanvasImageSize makes small images readable without distortion', () => {
  assert.deepEqual(fittedCanvasImageSize(20, 10), { width: 144, height: 72 });
});

test('fittedCanvasImageSize keeps extreme aspect ratios within the canvas bounds', () => {
  assert.deepEqual(fittedCanvasImageSize(1000, 10), { width: 420, height: 4 });
});
