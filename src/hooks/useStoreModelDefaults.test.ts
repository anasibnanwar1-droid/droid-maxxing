import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
import type { AppState } from './useStore';
import type { FactoryDefaultSettings } from '../types/bridge';

test('FACTORY_DEFAULTS stores the global and mode-specific orchestrator default models', () => {
  // Regression guard for #18: the context meter resolves the chat default model
  // from defaultModelId (agentConfig.orchestrator.modelId is undefined when the
  // user picks the UI "Default" model), plus the spec / mission orchestrator
  // defaults, so all three must be persisted from the Factory defaults event.
  const defaults: FactoryDefaultSettings = {
    modelId: 'chat-default',
    specModelId: 'spec-default',
    missionOrchestratorModelId: 'mission-default',
  };
  const state = reducer(initialState as AppState, { type: 'FACTORY_DEFAULTS', defaults });
  assert.equal(state.defaultModelId, 'chat-default');
  assert.equal(state.specModelId, 'spec-default');
  assert.equal(state.missionOrchestratorModelId, 'mission-default');
});
