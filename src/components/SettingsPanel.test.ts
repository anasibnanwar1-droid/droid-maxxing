import assert from 'node:assert/strict';
import test from 'node:test';
import { compactionSettingsForGlobalLimit } from '../lib/compactionSettings';

test('global compaction Factory default sends the Factory-default sentinel', () => {
  assert.deepEqual(compactionSettingsForGlobalLimit(undefined, { 'model-a': 100_000 }), {
    compactionTokenLimit: 'factory-default',
    compactionTokenLimitPerModel: { 'model-a': 100_000 },
  });
});

test('global compaction preset sends the selected numeric limit', () => {
  assert.deepEqual(compactionSettingsForGlobalLimit(200_000, {}), {
    compactionTokenLimit: 200_000,
    compactionTokenLimitPerModel: {},
  });
});
