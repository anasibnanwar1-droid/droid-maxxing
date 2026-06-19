import test from 'node:test';
import assert from 'node:assert/strict';
import { compactionTokenLimitForModel, createCompactionSettingsForModel } from './compaction.js';

test('uses per-model compaction limit ahead of global limits', () => {
  assert.equal(
    compactionTokenLimitForModel('model-b', {
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'model-b': 800_000 },
    }),
    800_000,
  );
});

test('omits daemon trigger budgets when local overrides omit the model', () => {
  assert.equal(
    compactionTokenLimitForModel('model-a', { compactionTokenLimitPerModel: {} }),
    undefined,
  );
});

test('uses local global compaction limits when no per-model override exists', () => {
  assert.equal(
    compactionTokenLimitForModel('model-a', {
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: {},
    }),
    200_000,
  );
});

test('explicitly disabled global compaction omits daemon trigger budgets', () => {
  assert.equal(
    compactionTokenLimitForModel('model-a', {
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: {},
    }),
    undefined,
  );
});

test('explicitly disabled global compaction overrides stale per-model budgets', () => {
  assert.equal(
    compactionTokenLimitForModel('model-a', {
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: { 'model-a': 120_000 },
    }),
    undefined,
  );
  assert.deepEqual(
    createCompactionSettingsForModel('model-a', {
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: { 'model-a': 120_000 },
    }),
    { compactionThresholdCheckEnabled: false },
  );
});

test('Factory default enables daemon checks without sending a numeric budget', () => {
  assert.deepEqual(createCompactionSettingsForModel('model-a', {}), {
    compactionThresholdCheckEnabled: true,
  });
});

test('builds Droid compaction payloads from the selected daemon budget', () => {
  assert.deepEqual(
    createCompactionSettingsForModel('model-a', {
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'model-a': 150_000 },
    }),
    {
      compactionTokenLimit: 150_000,
      compactionThresholdCheckEnabled: true,
    },
  );
});

test('disables daemon compaction threshold checks when budget is explicitly off', () => {
  assert.deepEqual(
    createCompactionSettingsForModel('model-a', {
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: {},
    }),
    { compactionThresholdCheckEnabled: false },
  );
});
