import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canvasPointToContent,
  contentPointToCanvas,
  fitContent,
  isPointInsideRenderedContent,
} from './canvasMath';

test('fitContent preserves aspect ratio and centers content', () => {
  const fit = fitContent({ width: 1000, height: 700 }, { width: 1600, height: 900 }, 40);

  assert.equal(fit.scale, 0.575);
  assert.deepEqual(fit.rendered, { width: 920, height: 518 });
  assert.deepEqual(fit.offset, { x: 40, y: 91 });
});

test('canvasPointToContent maps rendered pixels back to content coordinates', () => {
  const fit = fitContent({ width: 1000, height: 700 }, { width: 1600, height: 900 }, 40);

  assert.deepEqual(canvasPointToContent({ x: 500, y: 350 }, fit), { x: 800, y: 450 });
});

test('contentPointToCanvas maps content coordinates into rendered pixels', () => {
  const fit = fitContent({ width: 1000, height: 700 }, { width: 1600, height: 900 }, 40);

  assert.deepEqual(contentPointToCanvas({ x: 800, y: 450 }, fit), { x: 500, y: 350 });
});

test('isPointInsideRenderedContent excludes letterboxed space', () => {
  const fit = fitContent({ width: 1000, height: 700 }, { width: 1600, height: 900 }, 40);

  assert.equal(isPointInsideRenderedContent({ x: 500, y: 350 }, fit), true);
  assert.equal(isPointInsideRenderedContent({ x: 500, y: 40 }, fit), false);
});
