import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, viewportForMode, viewportFromFrame } from './browserViewport';

test('viewportFromFrame matches the fit browser surface inside the canvas frame', () => {
  assert.deepEqual(viewportFromFrame({ width: 1325, height: 857 }), {
    width: 1289,
    height: 821,
    deviceScaleFactor: 2,
  });
});

test('viewportFromFrame follows the available browser surface', () => {
  assert.deepEqual(viewportFromFrame({ width: 320, height: 300 }), {
    width: 284,
    height: 264,
    deviceScaleFactor: 2,
  });
  assert.deepEqual(viewportFromFrame({ width: 5000, height: 3000 }), {
    width: 4964,
    height: 2964,
    deviceScaleFactor: 2,
  });
  assert.deepEqual(viewportFromFrame({ width: 1325, height: 857 }, true), {
    width: 1325,
    height: 857,
    deviceScaleFactor: 2,
  });
});

test('viewportForMode keeps custom viewport and mobile device scale', () => {
  const fit = { width: 1000, height: 600, deviceScaleFactor: 1 };
  const custom = { width: 777, height: 555, deviceScaleFactor: 1 };
  assert.deepEqual(viewportForMode('custom', fit, custom), custom);
  assert.deepEqual(viewportForMode('mobile', fit, custom), {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
  });
});

test('normalizeUrl preserves local browser targets', () => {
  assert.equal(normalizeUrl('127.0.0.1:1420'), 'http://127.0.0.1:1420');
  assert.equal(normalizeUrl('localhost:3000/app'), 'http://localhost:3000/app');
  assert.equal(normalizeUrl('//example.com/path'), 'https://example.com/path');
  assert.equal(normalizeUrl('::1:8080/dev'), 'http://[::1]:8080/dev');
  assert.equal(normalizeUrl('example.com'), 'https://example.com');
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
});
