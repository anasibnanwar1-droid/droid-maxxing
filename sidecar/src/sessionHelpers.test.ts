import assert from 'node:assert/strict';
import test from 'node:test';

import type { FactoryDefaultSettings, SessionSummary } from './protocol.js';
import {
  buildResumedSession,
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

test('cold resume preserves a persisted Mission Control proposal', () => {
  const historical: SessionSummary = {
    appSessionId: 'mission-app',
    providerSessionId: 'mission-provider',
    missionId: 'mission-id',
    sessionPurpose: 'mission-control',
    interactionMode: 'agi',
    role: 'primary',
    title: 'Mission',
    goal: 'Complete the mission',
    cwd: '/workspace',
    workspaceKind: 'folder',
    autonomy: 'low',
    phase: 'paused',
    proposal: '# Persisted plan',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  const resumed = buildResumedSession({
    init: { settings: { interactionMode: 'agi' } },
    historical,
    appSessionId: historical.appSessionId,
    providerSessionId: historical.providerSessionId ?? historical.appSessionId,
    defaults: {},
    maxContextTokensForModel: () => undefined,
    now: 2,
  });

  assert.equal(resumed.summary.proposal, '# Persisted plan');
});
