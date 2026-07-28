import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DecompSessionType } from '@factory/droid-sdk';

import type { SessionSummary } from './protocol.js';
import { writeProviderSessionStart } from './testing/historyCharacterizationSupport.js';
import { assistantTextDelta, FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

test('[L1] Ordinary create', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
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
    assert.equal(
      h.events.find((event) => event.type === 'session.created')?.session.sessionPurpose,
      'chat',
    );
    assert.deepEqual(h.provider.session('provider-1').prompts, ['hello']);
  } finally {
    await h.dispose();
  }
});

test('[L2] Spec create', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
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
    assert.equal(
      h.events.find((event) => event.type === 'session.created')?.session.interactionMode,
      'spec',
    );
  } finally {
    await h.dispose();
  }
});

test(
  'design purpose is independent from auto interaction mode',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'design',
        clientRef: 'design-purpose',
        title: 'design',
        goal: 'draw',
        interactionMode: 'auto',
        autonomy: 'low',
      });

      const created = h.events.find((event) => event.type === 'session.created');
      assert.equal(created?.session.sessionPurpose, 'design');
      assert.equal(created?.session.interactionMode, 'auto');
      assert.equal(created?.session.missionId, undefined);
      assert.equal(h.runtime.createCalls[0]?.decompSessionType, undefined);
    } finally {
      await h.dispose();
    }
  },
);

test(
  'AGI interaction mode does not imply Mission Control purpose',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'agi-chat',
        title: 'agi chat',
        goal: 'reason',
        interactionMode: 'agi',
        autonomy: 'low',
      });

      const created = h.events.find((event) => event.type === 'session.created');
      assert.equal(created?.session.sessionPurpose, 'chat');
      assert.equal(created?.session.interactionMode, 'agi');
      assert.equal(created?.session.missionId, undefined);
      assert.equal(h.runtime.createCalls[0]?.decompSessionType, undefined);
    } finally {
      await h.dispose();
    }
  },
);

test('[L3] AGI create', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'mission-control',
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
      h.events.find((event) => event.type === 'session.created')?.session.sessionPurpose,
      'mission-control',
    );
  } finally {
    await h.dispose();
  }
});

test('[L4] Create failure cleanup', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();
  h.runtime.createQueue.push(new Error('create failed'));

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l4',
      title: 'failure',
      goal: 'fail',
      interactionMode: 'auto',
      autonomy: 'low',
    });

    assert.equal(
      h.events.some((event) => event.type === 'session.created'),
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
    const h = createSessionManagerTestContext();

    try {
      h.fixture.seedHistorySummaries([summary('app-5', 'provider-5')]);
      assert.equal(
        existsSync(path.join(h.home, '.factory', 'sessions', 'provider-5.jsonl')),
        false,
      );
      assert.equal(
        h.calls.some((call) => call.target === 'history' && call.method === 'syncSummaries'),
        false,
      );
      writeProviderSessionStart(h.home, 'provider-5', 'Historical app-5');
      h.runtime.loadQueue.set('provider-5', [new FakeFactorySession('provider-5', {}, h.calls)]);
      await h.handle({ type: 'session.resume', appSessionId: 'app-5' });

      assert.equal(h.runtime.loadCalls.length, 1);
      assert.equal(h.runtime.loadCalls[0]?.sessionId, 'provider-5');
      assert.equal(
        h.events.find((event) => event.type === 'session.created')?.session.appSessionId,
        'app-5',
      );
      assert.ok(h.runtime.loadCalls[0]?.handlers.permissionHandler);
      assert.ok(h.runtime.loadCalls[0]?.handlers.askUserHandler);
    } finally {
      await h.dispose();
    }
  },
);

test(
  'resuming an AGI chat preserves its explicit non-Mission-Control purpose',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      h.fixture.seedHistorySummaries([
        { ...summary('app-agi-chat', 'provider-agi-chat'), interactionMode: 'agi' },
      ]);
      writeProviderSessionStart(h.home, 'provider-agi-chat', 'AGI chat');
      h.runtime.loadQueue.set('provider-agi-chat', [
        new FakeFactorySession('provider-agi-chat', {}, h.calls, {
          settings: { interactionMode: 'agi' },
          mission: { state: 'running', features: [] },
        }),
      ]);

      await h.handle({ type: 'session.resume', appSessionId: 'app-agi-chat' });

      const resumed = h.events.find((event) => event.type === 'session.created')?.session;
      assert.equal(resumed?.sessionPurpose, 'chat');
      assert.equal(resumed?.interactionMode, 'agi');
      assert.equal(resumed?.missionId, undefined);
      assert.deepEqual(resumed?.features, []);
      assert.equal(resumed?.phase, 'paused');
      assert.equal(
        h.events.some((event) => event.type === 'mission.features'),
        false,
      );
    } finally {
      await h.dispose();
    }
  },
);

test('[L6] Send lazily resumes a historical session', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    h.fixture.seedHistorySummaries([summary('app-6', 'provider-6')]);
    assert.equal(existsSync(path.join(h.home, '.factory', 'sessions', 'provider-6.jsonl')), false);
    assert.equal(
      h.calls.some((call) => call.target === 'history' && call.method === 'syncSummaries'),
      false,
    );
    writeProviderSessionStart(h.home, 'provider-6', 'Historical app-6');
    h.runtime.loadQueue.set('provider-6', [new FakeFactorySession('provider-6', {}, h.calls)]);
    await h.handle({ type: 'session.send', appSessionId: 'app-6', text: 'once' });

    assert.equal(h.runtime.loadCalls.length, 1);
    assert.deepEqual(h.provider.session('provider-6').prompts, ['once']);
  } finally {
    await h.dispose();
  }
});

test(
  'mixed stable and provider identities preserve output across turns',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();

    try {
      h.fixture.seedHistorySummaries([summary('app-alias', 'provider-alias')]);
      writeProviderSessionStart(h.home, 'provider-alias', 'Alias');
      const provider = new FakeFactorySession('provider-alias', {}, h.calls);
      provider.queueStreamEvents([assistantTextDelta('first answer', 'first-message')]);
      provider.queueStreamEvents([assistantTextDelta('second answer', 'second-message')]);
      h.runtime.loadQueue.set('provider-alias', [provider]);

      await h.handle({ type: 'session.send', appSessionId: 'app-alias', text: 'first' });
      await h.handle({ type: 'session.send', appSessionId: 'provider-alias', text: 'second' });

      const textEvents = h.events.flatMap((event) =>
        event.type === 'event.appended' && event.event.kind === 'text' ? [event.event] : [],
      );
      assert.deepEqual(provider.prompts, ['first', 'second']);
      assert.deepEqual(
        textEvents.map((event) => event.text),
        ['first answer', 'second answer'],
      );
      assert.deepEqual(
        textEvents.map((event) => event.appSessionId),
        ['app-alias', 'app-alias'],
      );
    } finally {
      await h.dispose();
    }
  },
);

test('[L7] Send-now steers ahead of queued sends', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();
  const gate = h.runtime.deferNextCreateStream('provider-1');

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l7',
      title: 'L7',
      goal: 'first',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'second' });
    await h.handle({ type: 'session.sendNow', appSessionId: 'provider-1', text: 'steer' });

    assert.equal(h.calls.filter((call) => call.method === 'interrupt').length, 1);
    gate.resolve();
    await h.provider.waitForPrompts('provider-1', 3);

    assert.deepEqual(h.provider.session('provider-1').prompts, ['first', 'steer', 'second']);
  } finally {
    await h.dispose();
  }
});

test('[L8] Stop state matrix', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l8',
      title: 'L8',
      goal: 'idle',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.waitForIdle();
    await h.handle({ type: 'session.interrupt', appSessionId: 'provider-1' });
    await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'after idle stop' });
    assert.deepEqual(h.provider.session('provider-1').prompts, ['idle', 'after idle stop']);

    const streamGate = h.provider.deferNextStream('provider-1');
    const sending = h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'stream' });
    await h.provider.waitForPrompts('provider-1', 3);
    await h.handle({ type: 'session.interrupt', appSessionId: 'provider-1' });
    assert.equal(h.calls.filter((call) => call.method === 'interrupt').length, 2);
    streamGate.resolve();
    await sending;
    await h.waitForIdle();

    const compactGate = h.provider.deferNextCompaction('provider-1');
    const compacting = h.handle({ type: 'session.compact', appSessionId: 'provider-1' });
    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'drop while compacting',
    });
    await h.handle({ type: 'session.interrupt', appSessionId: 'provider-1' });
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
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'l9',
        title: 'L9',
        goal: 'go',
        interactionMode: 'auto',
        autonomy: 'low',
      });
      await h.handle({
        type: 'session.updateSettings',
        appSessionId: 'provider-1',
        interactionMode: 'spec',
      });
      assert.equal(
        h.calls.some((call) => call.method === 'enterSpecMode'),
        true,
      );
      assert.equal(
        h.events.filter((event) => event.type === 'session.updated').pop()?.session.interactionMode,
        'spec',
      );
      assert.equal(
        h.events.filter((event) => event.type === 'session.updated').pop()?.session.autonomy,
        'low',
      );

      const updatesBeforeFailure = h.events.filter(
        (event) => event.type === 'session.updated',
      ).length;
      h.provider.session('provider-1').nextEnterSpecModeError = new Error('mode rejected');
      await h.handle({
        type: 'session.updateSettings',
        appSessionId: 'provider-1',
        interactionMode: 'spec',
      });

      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'error' &&
            event.message === 'Could not switch interaction mode: mode rejected',
        ),
        true,
      );
      assert.equal(
        h.events.filter((event) => event.type === 'session.updated').length,
        updatesBeforeFailure,
      );
    } finally {
      await h.dispose();
    }
  },
);

test('[L10] Autonomy mutation reports provider rejection', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l10',
      title: 'L10',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'off',
    });
    await h.handle({ type: 'session.updateSettings', appSessionId: 'provider-1', autonomy: 'low' });
    assert.equal(
      h.provider
        .session('provider-1')
        .settings.some((settings) => settings['autonomyLevel'] === 'low'),
      true,
    );
    assert.equal(
      h.events.filter((event) => event.type === 'session.updated').pop()?.session.autonomy,
      'low',
    );

    const updatesBeforeFailure = h.events.filter(
      (event) => event.type === 'session.updated',
    ).length;
    h.provider.session('provider-1').nextUpdateSettingsError = new Error('autonomy rejected');
    await h.handle({
      type: 'session.updateSettings',
      appSessionId: 'provider-1',
      autonomy: 'high',
    });

    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' &&
          event.message === 'Could not change autonomy: autonomy rejected',
      ),
      true,
    );
    assert.equal(
      h.events.filter((event) => event.type === 'session.updated').length,
      updatesBeforeFailure,
    );
  } finally {
    await h.dispose();
  }
});

test('Summary patches preserve existing provider transcripts', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'l11',
      title: 'L11',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    const file = path.join(h.home, '.factory', 'sessions', 'provider-1.jsonl');
    const transcript =
      `${JSON.stringify({
        type: 'session_start',
        sessionId: 'provider-1',
        sessionTitle: 'L11',
        cwd: '',
      })}\n` +
      `${JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'preserve me' }] },
      })}\n`;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, transcript);

    await h.waitForIdle();
    const syncSummariesBefore = h.calls.filter(
      (call) => call.target === 'history' && call.method === 'syncSummaries',
    ).length;

    await h.handle({
      type: 'session.updateSettings',
      appSessionId: 'provider-1',
      autonomy: 'high',
    });

    assert.equal(
      h.calls.filter((call) => call.target === 'history' && call.method === 'syncSummaries').length,
      syncSummariesBefore + 1,
    );
    assert.equal(
      h.events.filter((event) => event.type === 'session.updated').at(-1)?.session.autonomy,
      'high',
    );
    assert.equal(h.history.summaryPatches().get('provider-1')?.autonomy, 'high');
    assert.equal(readFileSync(file, 'utf8'), transcript);
  } finally {
    await h.dispose();
  }
});

test(
  'History fixture materializes only persisted summary metadata',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    const seeded: SessionSummary = {
      ...summary('app-history', 'provider-old'),
      compactedFromProviderSessionIds: [
        'provider-older',
        'provider-oldest',
        'app-history',
        '',
        'provider-older',
      ],
      title: 'Persisted title',
      goal: 'transient goal',
      workspaceKind: 'folder',
      modelId: 'primary-model',
      reasoningEffort: 'high',
      compactionModel: 'compaction-model',
      workerModelId: 'worker-model',
      workerReasoningEffort: 'medium',
      validatorModelId: 'validator-model',
      validatorReasoningEffort: 'low',
      autonomy: 'high',
      phase: 'running',
      streaming: true,
      queuedSends: 2,
      features: [],
      tokensIn: 11,
      tokensOut: 12,
      contextTokens: 13,
      contextRemainingTokens: 14,
      contextAccuracy: 'exact',
      contextUpdatedAt: '2026-07-27T00:00:00.000Z',
      maxContextTokens: 15,
      autoCompactions: 16,
      createdAt: 17,
      updatedAt: 18,
    };

    try {
      h.fixture.seedHistorySummaries([seeded]);
      h.fixture.seedHistorySummaries([
        { ...seeded, providerSessionId: 'provider-current', updatedAt: 19 },
      ]);

      const patches = h.history.summaryPatches();
      const patch = patches.get('app-history');
      assert.deepEqual(patch, {
        appSessionId: 'app-history',
        providerSessionId: 'provider-current',
        compactedFromProviderSessionIds: [
          'provider-older',
          'provider-oldest',
          'app-history',
          '',
          'provider-older',
        ],
        sessionPurpose: 'chat',
        interactionMode: 'auto',
        title: 'Persisted title',
        cwd: '',
        workspaceKind: 'folder',
        modelId: 'primary-model',
        reasoningEffort: 'high',
        compactionModel: 'compaction-model',
        workerModelId: 'worker-model',
        workerReasoningEffort: 'medium',
        validatorModelId: 'validator-model',
        validatorReasoningEffort: 'low',
        autonomy: 'high',
        tokensIn: 11,
        tokensOut: 12,
        contextTokens: 13,
        contextRemainingTokens: 14,
        contextAccuracy: 'exact',
        contextUpdatedAt: '2026-07-27T00:00:00.000Z',
        maxContextTokens: 15,
        autoCompactions: 16,
        updatedAt: 19,
      });
      assert.equal(patches.get('provider-current'), patch);
      assert.equal(patches.has('provider-old'), false);
      assert.deepEqual(
        h.history.hiddenProviderSessionIds(),
        new Set(['provider-older', 'provider-oldest']),
      );
    } finally {
      await h.dispose();
    }
  },
);

function summary(appSessionId: string, providerSessionId: string): SessionSummary {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: `Historical ${appSessionId}`,
    goal: '',
    cwd: '',
    workspaceKind: 'none',
    autonomy: 'low',
    phase: 'paused',
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
