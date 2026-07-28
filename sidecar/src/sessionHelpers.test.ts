import assert from 'node:assert/strict';
import test from 'node:test';

import type { FactoryDefaultSettings } from './protocol.js';
import {
  createAutonomyForCommand,
  createMissionAgentDefaultsForMode,
  createModelDefaultsForMode,
} from './sessionHelpers.js';

test('create defaults preserve explicit autonomy and mode-specific primary settings', () => {
  assert.equal(createAutonomyForCommand({}, { autonomy: 'high' }), 'high');
  assert.equal(createAutonomyForCommand({ autonomy: 'low' }, { autonomy: 'high' }), 'low');

  const defaults: Pick<
    FactoryDefaultSettings,
    | 'modelId'
    | 'reasoningEffort'
    | 'missionOrchestratorModelId'
    | 'missionOrchestratorReasoningEffort'
  > = {
    modelId: 'default-model',
    reasoningEffort: 'medium',
    missionOrchestratorModelId: 'mission-model',
    missionOrchestratorReasoningEffort: 'high',
  };
  assert.deepEqual(createModelDefaultsForMode('auto', {}, defaults), {
    modelId: 'default-model',
    reasoningEffort: 'medium',
  });
  assert.deepEqual(createModelDefaultsForMode('agi', {}, defaults), {
    modelId: 'mission-model',
    reasoningEffort: 'high',
  });
});

test('worker and validator defaults apply only to Mission Control sessions', () => {
  const defaults: Pick<
    FactoryDefaultSettings,
    'workerModelId' | 'workerReasoningEffort' | 'validatorModelId' | 'validatorReasoningEffort'
  > = {
    workerModelId: 'worker-default',
    workerReasoningEffort: 'medium',
    validatorModelId: 'validator-default',
    validatorReasoningEffort: 'high',
  };

  assert.deepEqual(
    createMissionAgentDefaultsForMode(
      'agi',
      { workerModel: 'worker-custom', workerReasoning: 'low' },
      defaults,
    ),
    {
      workerModelId: 'worker-custom',
      workerReasoningEffort: 'low',
      validatorModelId: 'validator-default',
      validatorReasoningEffort: 'high',
    },
  );
  assert.deepEqual(createMissionAgentDefaultsForMode('auto', {}, defaults), {});
  assert.deepEqual(createMissionAgentDefaultsForMode('spec', {}, defaults), {});
});
