import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactionTokenLimitForModel,
  createAutonomyForCommand,
  createCompactionSettingsForModel,
  createModelDefaultsForMode,
  createSessionSettingsForAgent,
} from './MissionManager.js';

test('uses Factory default autonomy when create command omits autonomy', () => {
  assert.equal(createAutonomyForCommand({}, { autonomy: 'high' }), 'high');
});

test('uses explicit session autonomy ahead of Factory default autonomy', () => {
  assert.equal(createAutonomyForCommand({ autonomy: 'low' }, { autonomy: 'high' }), 'low');
});

test('uses mission orchestrator defaults for AGI missions', () => {
  assert.deepEqual(
    createModelDefaultsForMode('agi', {}, {
      modelId: 'default-model',
      reasoningEffort: 'medium',
      missionOrchestratorModelId: 'mission-model',
      missionOrchestratorReasoningEffort: 'high',
    }),
    { modelId: 'mission-model', reasoningEffort: 'high' },
  );
});

test('uses regular session defaults for normal chat', () => {
  assert.deepEqual(
    createModelDefaultsForMode('auto', {}, {
      modelId: 'default-model',
      reasoningEffort: 'medium',
      missionOrchestratorModelId: 'mission-model',
      missionOrchestratorReasoningEffort: 'high',
    }),
    { modelId: 'default-model', reasoningEffort: 'medium' },
  );
});

test('uses per-model compaction limit ahead of global limits', () => {
  assert.equal(
    compactionTokenLimitForModel(
      'model-b',
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-b': 800_000 } },
      { compactionTokenLimit: 100_000, compactionTokenLimitPerModel: { 'model-b': 300_000 } },
    ),
    800_000,
  );
});

test('uses Factory compaction defaults when command omits them', () => {
  assert.equal(
    compactionTokenLimitForModel('model-a', {}, { compactionTokenLimit: 200_000 }),
    200_000,
  );
});

test('builds Droid compaction update payloads', () => {
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

test('disables threshold checks when a live compaction limit is cleared', () => {
  assert.deepEqual(
    createCompactionSettingsForModel('model-a', { compactionTokenLimit: null, compactionTokenLimitPerModel: {} }, {}, true),
    { compactionThresholdCheckEnabled: false },
  );
});

test('maps mission worker settings to Droid mission settings', () => {
  assert.deepEqual(
    createSessionSettingsForAgent('worker', { modelId: 'worker-model', reasoningEffort: 'high' }),
    {
      missionSettings: {
        workerModel: 'worker-model',
        workerReasoningEffort: 'high',
      },
    },
  );
});

test('maps orchestrator model changes with current compaction limits', () => {
  assert.deepEqual(
    createSessionSettingsForAgent(
      'orchestrator',
      {
        modelId: 'model-b',
        compactionTokenLimit: 200_000,
        compactionTokenLimitPerModel: { 'model-b': 150_000 },
      },
      'model-a',
    ),
    {
      modelId: 'model-b',
      compactionTokenLimit: 150_000,
      compactionThresholdCheckEnabled: true,
    },
  );
});
