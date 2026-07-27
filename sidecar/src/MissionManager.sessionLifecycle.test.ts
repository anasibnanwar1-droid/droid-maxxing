import assert from 'node:assert/strict';
import test from 'node:test';

import { DecompSessionType } from '@factory/droid-sdk';

import {
  FakeDroidSession,
  createSessionCharacterizationHarness,
} from './testing/sessionCharacterizationHarness.js';

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

test(
  '[L5] Resume preserves the app identity while loading the provider session',
  { concurrency: false },
  async () => {
    const h = createSessionCharacterizationHarness();

    try {
      h.history.syncSummaries([summary('app-5', 'provider-5')]);
      h.runtime.loadQueue.set('provider-5', [new FakeDroidSession('provider-5', {}, h.calls)]);
      await h.handle({ type: 'mission.resume', sessionId: 'app-5' });

      assert.equal(h.runtime.loadCalls[0]?.sessionId, 'provider-5');
      assert.equal(h.events.find((event) => event.type === 'mission.created')?.mission.id, 'app-5');
      assert.ok(h.runtime.loadCalls[0]?.handlers.permissionHandler);
      assert.ok(h.runtime.loadCalls[0]?.handlers.askUserHandler);
    } finally {
      await h.dispose();
    }
  },
);

test('[L6] Send lazily resumes a historical mission', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    h.history.syncSummaries([summary('app-6', 'provider-6')]);
    h.runtime.loadQueue.set('provider-6', [new FakeDroidSession('provider-6', {}, h.calls)]);
    await h.handle({ type: 'mission.send', missionId: 'app-6', text: 'once' });

    assert.equal(h.runtime.loadCalls.length, 1);
    assert.deepEqual(h.provider.session('provider-6').prompts, ['once']);
  } finally {
    await h.dispose();
  }
});

test('[L7] Send-now steers ahead of queued sends', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();
  const gate = h.runtime.deferNextCreateStream('provider-1');

  try {
    await h.create({
      clientRef: 'l7',
      title: 'L7',
      goal: 'first',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.handle({ type: 'mission.send', missionId: 'provider-1', text: 'second' });
    await h.handle({ type: 'mission.sendNow', missionId: 'provider-1', text: 'steer' });

    assert.equal(h.calls.filter((call) => call.method === 'interrupt').length, 1);
    gate.resolve();
    await h.provider.waitForPrompts('provider-1', 3);

    assert.deepEqual(h.provider.session('provider-1').prompts, ['first', 'steer', 'second']);
  } finally {
    await h.dispose();
  }
});

test('[L8] Stop state matrix', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    await h.create({
      clientRef: 'l8',
      title: 'L8',
      goal: 'idle',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.waitForIdle();
    await h.handle({ type: 'mission.interrupt', missionId: 'provider-1' });
    await h.handle({ type: 'mission.send', missionId: 'provider-1', text: 'after idle stop' });
    assert.deepEqual(h.provider.session('provider-1').prompts, ['idle', 'after idle stop']);

    const streamGate = h.provider.deferNextStream('provider-1');
    const sending = h.handle({ type: 'mission.send', missionId: 'provider-1', text: 'stream' });
    await h.provider.waitForPrompts('provider-1', 3);
    await h.handle({ type: 'mission.interrupt', missionId: 'provider-1' });
    assert.equal(h.calls.filter((call) => call.method === 'interrupt').length, 2);
    streamGate.resolve();
    await sending;
    await h.waitForIdle();

    const compactGate = h.provider.deferNextCompaction('provider-1');
    const compacting = h.handle({ type: 'mission.compact', missionId: 'provider-1' });
    await h.handle({
      type: 'mission.send',
      missionId: 'provider-1',
      text: 'drop while compacting',
    });
    await h.handle({ type: 'mission.interrupt', missionId: 'provider-1' });
    assert.equal(h.calls.filter((call) => call.method === 'interrupt').length, 2);
    compactGate.resolve();
    await compacting;
    assert.deepEqual(h.provider.session('provider-1').prompts, [
      'idle',
      'after idle stop',
      'stream',
    ]);
  } finally {
    await h.dispose();
  }
});

test(
  '[L9] Interaction-mode mutation reports provider rejection',
  { concurrency: false },
  async () => {
    const h = createSessionCharacterizationHarness();

    try {
      await h.create({
        clientRef: 'l9',
        title: 'L9',
        goal: 'go',
        interactionMode: 'auto',
        autonomy: 'low',
      });
      await h.handle({ type: 'mission.setInteractionMode', missionId: 'provider-1', mode: 'spec' });
      assert.equal(
        h.calls.some((call) => call.method === 'enterSpecMode'),
        true,
      );
      assert.equal(
        h.events.filter((event) => event.type === 'mission.updated').pop()?.mission.kind,
        'spec',
      );
      assert.equal(
        h.events.filter((event) => event.type === 'mission.updated').pop()?.mission.autonomy,
        'low',
      );

      const updatesBeforeFailure = h.events.filter(
        (event) => event.type === 'mission.updated',
      ).length;
      h.provider.session('provider-1').nextEnterSpecModeError = new Error('mode rejected');
      await h.handle({ type: 'mission.setInteractionMode', missionId: 'provider-1', mode: 'spec' });

      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'error' &&
            event.message === 'Could not switch interaction mode: mode rejected',
        ),
        true,
      );
      assert.equal(
        h.events.filter((event) => event.type === 'mission.updated').length,
        updatesBeforeFailure,
      );
    } finally {
      await h.dispose();
    }
  },
);

test('[L10] Autonomy mutation reports provider rejection', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    await h.create({
      clientRef: 'l10',
      title: 'L10',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'off',
    });
    await h.handle({ type: 'mission.setAutonomy', missionId: 'provider-1', autonomy: 'low' });
    assert.equal(
      h.provider
        .session('provider-1')
        .settings.some((settings) => settings['autonomyLevel'] === 'low'),
      true,
    );
    assert.equal(
      h.events.filter((event) => event.type === 'mission.updated').pop()?.mission.autonomy,
      'low',
    );

    const updatesBeforeFailure = h.events.filter(
      (event) => event.type === 'mission.updated',
    ).length;
    h.provider.session('provider-1').nextUpdateSettingsError = new Error('autonomy rejected');
    await h.handle({ type: 'mission.setAutonomy', missionId: 'provider-1', autonomy: 'high' });

    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' &&
          event.message === 'Could not change autonomy: autonomy rejected',
      ),
      true,
    );
    assert.equal(
      h.events.filter((event) => event.type === 'mission.updated').length,
      updatesBeforeFailure,
    );
  } finally {
    await h.dispose();
  }
});

function summary(id: string, sessionId: string) {
  const now = Date.now();
  return {
    id,
    sessionId,
    kind: 'chat' as const,
    role: 'orchestrator' as const,
    title: `Historical ${id}`,
    goal: '',
    cwd: '',
    workspaceKind: 'none' as const,
    autonomy: 'low' as const,
    phase: 'paused' as const,
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}
