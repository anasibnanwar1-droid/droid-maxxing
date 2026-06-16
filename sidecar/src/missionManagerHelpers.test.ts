import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedInt,
  contextBreakdownSnapshot,
  createAutonomyForCommand,
  createModelDefaultsForMode,
  createSessionSettingsForAgent,
  stringValue,
  validateFactoryDefaults,
} from './missionManagerHelpers.js';
import type { FactoryDefaultSettings, ModelInfo } from './protocol.js';

test('contextBreakdownSnapshot normalizes empty and detailed breakdowns', () => {
  assert.equal(contextBreakdownSnapshot(undefined), undefined);
  assert.equal(
    contextBreakdownSnapshot({ categories: [], usedTokens: 0, contextBudget: 0 }),
    undefined,
  );

  assert.deepEqual(
    contextBreakdownSnapshot({
      modelId: 'model-a',
      modelDisplayName: 'Model A',
      contextBudget: 100,
      freeTokens: 25,
      categories: [
        { name: 'Messages', tokens: 40, colorKey: 'messages' },
        { tokens: 35 },
        { name: 'Ignored', tokens: 0 },
      ],
    }),
    {
      modelId: 'model-a',
      modelDisplayName: 'Model A',
      contextBudget: 100,
      usedTokens: 75,
      freeTokens: 25,
      categories: [
        { name: 'Messages', tokens: 40, colorKey: 'messages' },
        { name: 'Context', tokens: 35, colorKey: undefined },
      ],
    },
  );
});

test('scalar helpers clamp and normalize edge inputs', () => {
  assert.equal(stringValue(123), undefined);
  assert.equal(boundedInt(undefined, 4, 1, 10), 4);
  assert.equal(boundedInt('oops', 4, 1, 10), 4);
  assert.equal(boundedInt('0', 4, 1, 10), 1);
  assert.equal(boundedInt('20', 4, 1, 10), 10);
  assert.equal(createAutonomyForCommand({}, {}), 'low');
});

test('model and agent defaults cover explicit and fallback branches', () => {
  const defaults: FactoryDefaultSettings = {
    modelId: 'model-a',
    reasoningEffort: 'medium',
    specModelId: 'spec-model',
    specReasoningEffort: 'high',
    missionOrchestratorModelId: 'mission-model',
    missionOrchestratorReasoningEffort: 'low',
    workerModelId: 'worker-model',
    workerReasoningEffort: 'medium',
    validatorModelId: 'validator-model',
    validatorReasoningEffort: 'high',
  };

  assert.deepEqual(createModelDefaultsForMode('spec', { modelId: 'custom' }, defaults), {
    modelId: 'custom',
    reasoningEffort: 'high',
  });
  assert.deepEqual(createModelDefaultsForMode('auto', { reasoningEffort: 'xhigh' }, defaults), {
    modelId: 'model-a',
    reasoningEffort: 'xhigh',
  });
  assert.deepEqual(createModelDefaultsForMode('agi', {}, defaults), {
    modelId: 'mission-model',
    reasoningEffort: 'low',
  });
  assert.deepEqual(createSessionSettingsForAgent('orchestrator', {}), {});
  assert.deepEqual(createSessionSettingsForAgent('validator', { reasoningEffort: 'low' }), {
    missionSettings: { validationWorkerReasoningEffort: 'low' },
  });
});

test('validateFactoryDefaults falls back to catalog-safe model settings', () => {
  const models: ModelInfo[] = [
    {
      id: 'safe-model',
      displayName: 'Safe Model',
      isDefault: true,
      isCustom: false,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium'],
    },
  ];

  assert.deepEqual(
    validateFactoryDefaults(
      {
        modelId: 'missing',
        reasoningEffort: 'xhigh',
        specModelId: 'missing-spec',
        compactionModel: 'missing-compact',
        compactionTokenLimitPerModel: { missing: 50_000, 'safe-model': 75_000 },
      },
      models,
    ),
    {
      modelId: 'safe-model',
      reasoningEffort: 'medium',
      specModelId: 'safe-model',
      specReasoningEffort: undefined,
      workerModelId: 'safe-model',
      workerReasoningEffort: undefined,
      validatorModelId: 'safe-model',
      validatorReasoningEffort: undefined,
      compactionModel: 'current-model',
      compactionTokenLimit: undefined,
      compactionTokenLimitPerModel: { 'safe-model': 75_000 },
    },
  );
});
