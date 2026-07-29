import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelInfo } from '../types/bridge.js';
import {
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

test('exact child targets use canonical child role and settings', () => {
  const worker = buildSelectedChildSettingsTarget({
    parentAppSessionId: 'parent-a',
    childSessionId: 'worker-logical',
    child: { role: 'worker', modelId: 'worker-model', reasoningEffort: 'high' },
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

  const validator = buildSelectedChildSettingsTarget({
    parentAppSessionId: 'parent-a',
    childSessionId: 'validator-logical',
    child: { role: 'validator', modelId: 'validator-model', reasoningEffort: 'xhigh' },
    label: 'Sub-agent 2',
    readiness: 'ready',
  });
  assert.equal(validator?.role, 'validator');
  assert.equal(validator?.modelId, 'validator-model');
  assert.equal(validator?.reasoningEffort, 'xhigh');

  const missing = buildSelectedChildSettingsTarget({
    parentAppSessionId: 'parent-a',
    childSessionId: 'missing-child',
    label: 'Missing child',
    readiness: 'ready',
  });
  assert.equal(missing.readiness, 'failed');
});

test('a selected child remains in exact scope while readiness controls writes', () => {
  const current = buildSelectedChildSettingsTarget({
    parentAppSessionId: 'parent-a',
    childSessionId: 'worker-logical',
    child: { role: 'worker', modelId: 'worker-model', reasoningEffort: 'high' },
    label: 'Sub-agent 1',
    readiness: 'ready',
  });
  assert.equal(current.readiness, 'ready');

  const completed = buildSelectedChildSettingsTarget({
    parentAppSessionId: 'parent-a',
    childSessionId: 'worker-logical',
    child: { role: 'worker', modelId: 'worker-model', reasoningEffort: 'high' },
    label: 'Sub-agent 1',
    readiness: 'failed',
  });
  assert.equal(completed.readiness, 'failed');
  assert.equal(completed.childSessionId, 'worker-logical');
  assert.equal(planChildModelUpdate(completed, 'other-model', 'high', []), undefined);

  const unavailable = buildSelectedChildSettingsTarget({
    parentAppSessionId: 'parent-a',
    childSessionId: 'worker-logical',
    label: 'Sub-agent 1',
    readiness: 'ready',
  });
  assert.equal(unavailable.readiness, 'failed');
  assert.equal(planChildModelUpdate(unavailable, 'other-model', 'high', []), undefined);
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
