import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStudioModelId } from './studioModels';

test('a live Studio session never inherits a stale draft model', () => {
  assert.equal(
    resolveStudioModelId(true, 'live-model', 'draft-model', 'default-model'),
    'live-model',
  );
  assert.equal(resolveStudioModelId(true, undefined, 'draft-model', 'default-model'), undefined);
  assert.equal(
    resolveStudioModelId(false, undefined, 'draft-model', 'default-model'),
    'draft-model',
  );
});

test('a new Studio session resolves its visible default to an explicit model', () => {
  assert.equal(
    resolveStudioModelId(false, undefined, undefined, 'configured-default'),
    'configured-default',
  );
});
