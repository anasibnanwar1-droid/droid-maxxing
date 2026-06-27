import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitializeSessionParams } from './DroidRuntime.js';

test('exec initialize params enable native compaction checks', () => {
  const params = createInitializeSessionParams({
    cwd: '/tmp/project',
    interactionMode: 'auto',
    modelId: 'main-model',
    compactionModel: 'summary-model',
    compactionTokenLimit: 400_000,
  });

  assert.equal(params.compactionModel, 'summary-model');
  assert.equal(params.compactionThresholdCheckEnabled, true);
  assert.equal(params.compactionTokenLimit, undefined);
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
