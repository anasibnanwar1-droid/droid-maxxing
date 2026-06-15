import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitializeSessionParams } from './DroidRuntime.js';

test('passes daemon compaction mode when initializing a session', () => {
  const params = createInitializeSessionParams({
    cwd: '/tmp/project',
    interactionMode: 'auto',
    modelId: 'main-model',
    compactionModel: 'summary-model',
    compactionThresholdCheckEnabled: true,
  });

  assert.equal(params.compactionModel, 'summary-model');
  assert.equal(params.compactionThresholdCheckEnabled, true);
});

test('passes current-model compaction sentinel when initializing a session', () => {
  const params = createInitializeSessionParams({
    cwd: '/tmp/project',
    interactionMode: 'auto',
    modelId: 'main-model',
    compactionModel: 'current-model',
  });

  assert.equal(params.compactionModel, 'current-model');
});
