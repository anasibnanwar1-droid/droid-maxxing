import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutonomyForCommand, createModelDefaultsForMode } from './MissionManager.js';

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
