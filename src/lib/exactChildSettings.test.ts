import assert from 'node:assert/strict';
import test from 'node:test';

import type { BridgeFeature, ModelInfo } from '../types/bridge.js';
import {
  buildExactChildSettingsTarget,
  buildSelectedChildSettingsTarget,
  childSettingsReadinessLabel,
  planChildModelUpdate,
  type ExactChildSettingsTarget,
} from './exactChildSettings.js';

test('child settings readiness uses reader-facing labels', () => {
  assert.equal(childSettingsReadinessLabel('opening'), 'Opening child…');
  assert.equal(childSettingsReadinessLabel('ready'), 'Ready');
  assert.equal(childSettingsReadinessLabel('failed'), 'Child unavailable');
});

function feature(input: Partial<BridgeFeature> = {}): BridgeFeature {
  return {
    id: 'worker-feature',
    description: 'Implement the feature',
    status: 'in_progress',
    skillName: 'implementation',
    preconditions: [],
    expectedBehavior: [],
    verificationSteps: [],
    currentWorkerProviderSessionId: 'worker-logical',
    ...input,
  };
}

test('exact child targets require the current live feature and preserve validator settings', () => {
  const worker = buildExactChildSettingsTarget({
    parentAppSessionId: 'parent-a',
    childSessionId: 'worker-logical',
    features: [feature()],
    child: { modelId: 'worker-model', reasoningEffort: 'high' },
    label: 'Sub-agent 1',
    readiness: 'opening',
  });
  assert.deepEqual(worker, {
    parentAppSessionId: 'parent-a',
    childSessionId: 'worker-logical',
    role: 'worker',
    label: 'Sub-agent 1',
    modelId: 'worker-model',
    reasoningEffort: 'high',
    readiness: 'opening',
  });

  const validator = buildExactChildSettingsTarget({
    parentAppSessionId: 'parent-a',
    childSessionId: 'validator-logical',
    features: [
      feature({
        id: 'validation-feature',
        description: 'Scrutiny pass',
        currentWorkerProviderSessionId: 'validator-logical',
      }),
    ],
    child: { modelId: 'validator-model', reasoningEffort: 'xhigh' },
    label: 'Sub-agent 2',
    readiness: 'ready',
  });
  assert.equal(validator?.role, 'validator');
  assert.equal(validator?.modelId, 'validator-model');
  assert.equal(validator?.reasoningEffort, 'xhigh');

  assert.equal(
    buildExactChildSettingsTarget({
      parentAppSessionId: 'parent-a',
      childSessionId: 'worker-logical',
      features: [
        feature({
          status: 'completed',
          currentWorkerProviderSessionId: null,
          completedWorkerProviderSessionId: 'worker-logical',
        }),
      ],
      label: 'Historical worker',
      readiness: 'ready',
    }),
    undefined,
  );
  assert.equal(
    buildExactChildSettingsTarget({
      parentAppSessionId: 'parent-a',
      childSessionId: 'historical-only',
      features: [feature()],
      label: 'Historical worker',
      readiness: 'ready',
    }),
    undefined,
  );
});

test('a selected child remains in disabled child scope after completion or replacement', () => {
  const currentFeature = feature();
  const current = buildSelectedChildSettingsTarget({
    parentAppSessionId: 'parent-a',
    childSessionId: 'worker-logical',
    features: [currentFeature],
    child: { modelId: 'worker-model', reasoningEffort: 'high' },
    label: 'Sub-agent 1',
    readiness: 'ready',
  });
  assert.equal(current.readiness, 'ready');

  const completed = buildSelectedChildSettingsTarget({
    parentAppSessionId: 'parent-a',
    childSessionId: 'worker-logical',
    features: [
      feature({
        status: 'completed',
        currentWorkerProviderSessionId: null,
        completedWorkerProviderSessionId: 'worker-logical',
      }),
    ],
    child: { modelId: 'worker-model', reasoningEffort: 'high' },
    label: 'Sub-agent 1',
    readiness: 'ready',
  });
  assert.equal(completed.readiness, 'failed');
  assert.equal(completed.childSessionId, 'worker-logical');
  assert.equal(planChildModelUpdate(completed, 'other-model', 'high', []), undefined);

  const replaced = buildSelectedChildSettingsTarget({
    parentAppSessionId: 'parent-a',
    childSessionId: 'worker-logical',
    features: [feature({ currentWorkerProviderSessionId: 'replacement-logical' })],
    child: { modelId: 'worker-model', reasoningEffort: 'high' },
    label: 'Sub-agent 1',
    readiness: 'ready',
  });
  assert.equal(replaced.readiness, 'failed');
  assert.equal(planChildModelUpdate(replaced, 'other-model', 'high', []), undefined);
});

test('child model planning is readiness-gated and emits only the exact command identity', () => {
  const target: ExactChildSettingsTarget = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'validator-logical',
    role: 'validator',
    label: 'Sub-agent 2',
    modelId: 'old-model',
    reasoningEffort: 'high',
    readiness: 'ready',
  };
  const models: ModelInfo[] = [
    {
      id: 'new-model',
      displayName: 'New model',
      isCustom: false,
      supportedReasoningEfforts: ['low'],
      defaultReasoningEffort: 'low',
    },
  ];

  assert.equal(
    planChildModelUpdate({ ...target, readiness: 'opening' }, 'new-model', 'high', models),
    undefined,
  );
  assert.equal(
    planChildModelUpdate({ ...target, readiness: 'failed' }, 'new-model', 'high', models),
    undefined,
  );
  assert.deepEqual(planChildModelUpdate(target, 'new-model', 'high', models), {
    parentAppSessionId: 'parent-a',
    childSessionId: 'validator-logical',
    modelId: 'new-model',
    reasoningEffort: 'low',
  });
  assert.deepEqual(planChildModelUpdate(target, undefined, 'high', models), {
    parentAppSessionId: 'parent-a',
    childSessionId: 'validator-logical',
    modelId: null,
  });
});
