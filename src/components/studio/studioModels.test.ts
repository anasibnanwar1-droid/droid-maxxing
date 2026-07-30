import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStudioModelId } from './studioModels';

test('a live Studio session never inherits a stale draft model', () => {
  assert.equal(resolveStudioModelId(true, 'live-model', 'draft-model'), 'live-model');
  assert.equal(resolveStudioModelId(true, undefined, 'draft-model'), undefined);
  assert.equal(resolveStudioModelId(false, undefined, 'draft-model'), 'draft-model');
});
