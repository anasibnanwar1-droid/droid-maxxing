import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactionTokenLimitForModel,
  createAutonomyForCommand,
  createCompactionSettingsForModel,
  createModelDefaultsForMode,
  createSessionSettingsForAgent,
  startupFactoryDefaults,
  validateFactoryDefaults,
} from './MissionManager.js';
import type { ModelInfo } from './protocol.js';

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

const models: ModelInfo[] = [
  {
    id: 'model-a',
    displayName: 'Model A',
    isDefault: true,
    isCustom: false,
    supportedReasoningEfforts: ['low', 'medium'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'model-b',
    displayName: 'Model B',
    isCustom: false,
    supportedReasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
  },
];

test('startup defaults do not seed unvalidated model ids when no catalog is cached', () => {
  assert.deepEqual(
    startupFactoryDefaults({
      modelId: 'missing-model',
      reasoningEffort: 'high',
      compactionModel: 'missing-model',
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'missing-model': 150_000 },
      autonomy: 'high',
      interactionMode: 'auto',
      workerModelId: 'missing-worker',
    }, []),
    {
      autonomy: 'high',
      interactionMode: 'auto',
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'missing-model': 150_000 },
    },
  );
});

test('validates Factory defaults against the model catalog', () => {
  assert.deepEqual(
    validateFactoryDefaults({
      modelId: 'missing-model',
      reasoningEffort: 'high',
      compactionModel: 'missing-model',
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'model-b': 150_000, missing: 90_000 },
      specModelId: 'model-b',
      specReasoningEffort: 'low',
      workerModelId: 'model-b',
      workerReasoningEffort: 'medium',
      validatorModelId: 'missing-validator',
    }, models),
    {
      modelId: 'model-a',
      reasoningEffort: 'medium',
      compactionModel: 'current-model',
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'model-b': 150_000 },
      specModelId: 'model-b',
      specReasoningEffort: 'high',
      workerModelId: 'model-b',
      workerReasoningEffort: 'high',
      validatorModelId: 'model-a',
      validatorReasoningEffort: undefined,
    },
  );
});
