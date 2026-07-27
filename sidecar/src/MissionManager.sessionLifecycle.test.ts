import assert from 'node:assert/strict';
import test from 'node:test';

import { DecompSessionType } from '@factory/droid-sdk';

import { createSessionCharacterizationHarness } from './testing/sessionCharacterizationHarness.js';

test('[L1] Ordinary create', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    await h.create({
      clientRef: 'l1',
      title: 'ordinary',
      goal: 'hello',
      interactionMode: 'auto',
      autonomy: 'low',
    });

    const options = h.runtime.createCalls[0];
    assert.ok(options);
    assert.equal(options.interactionMode, 'auto');
    assert.equal(options.autonomyLevel, 'low');
    assert.equal(h.events.find((event) => event.type === 'mission.created')?.mission.kind, 'chat');
    assert.deepEqual(h.provider.session('provider-1').prompts, ['hello']);
  } finally {
    await h.dispose();
  }
});

test('[L2] Spec create', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    await h.create({
      clientRef: 'l2',
      title: 'spec',
      goal: 'write',
      interactionMode: 'spec',
      autonomy: 'off',
      modelId: 'spec-model',
      reasoningEffort: 'high',
    });

    const options = h.runtime.createCalls[0];
    assert.ok(options);
    assert.equal(options.interactionMode, 'spec');
    assert.equal(options.specModeModelId, 'spec-model');
    assert.equal(options.workerModelId, undefined);
    assert.equal(h.events.find((event) => event.type === 'mission.created')?.mission.kind, 'spec');
  } finally {
    await h.dispose();
  }
});

test('[L3] AGI create', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    await h.create({
      clientRef: 'l3',
      title: 'agi',
      goal: 'plan',
      interactionMode: 'agi',
      autonomy: 'low',
      workerModel: 'worker',
      validatorModel: 'validator',
    });

    const options = h.runtime.createCalls[0];
    assert.ok(options);
    assert.equal(options.decompSessionType, DecompSessionType.Orchestrator);
    assert.equal(options.workerModelId, 'worker');
    assert.equal(options.validatorModelId, 'validator');
    assert.equal(
      h.events.find((event) => event.type === 'mission.created')?.mission.kind,
      'mission_orchestrator',
    );
  } finally {
    await h.dispose();
  }
});

test('[L4] Create failure cleanup', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();
  h.runtime.createQueue.push(new Error('create failed'));

  try {
    await h.create({
      clientRef: 'l4',
      title: 'failure',
      goal: 'fail',
      interactionMode: 'auto',
      autonomy: 'low',
    });

    assert.equal(
      h.events.some((event) => event.type === 'mission.created'),
      false,
    );
    assert.equal(
      h.calls.some((call) => call.target === 'history' && call.method === 'syncSummaries'),
      false,
    );
    assert.equal(
      h.events.some((event) => event.type === 'error' && event.message === 'create failed'),
      true,
    );
    assert.equal(h.mcpServerCloseCalls, 1);
  } finally {
    await h.dispose();
  }
});
