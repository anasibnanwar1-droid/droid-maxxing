import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeFactorySession, type RecordedCall } from './testing/fakeFactoryRuntime.js';
import { writeProviderSessionStart } from './testing/historyCharacterizationSupport.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';
import type { ServerEvent } from './protocol.js';
import {
  contextUpdateCount,
  runAutoCompactionScenario,
  runCloseCleanupScenario,
  runShutdownOnlyCleanupScenario,
  seedInitModel,
} from './testing/compactionCharacterizationScenarios.js';

type SessionUpdatedEvent = Extract<ServerEvent, { type: 'session.updated' }>;
type TranscriptEventAppended = Extract<ServerEvent, { type: 'event.appended' }>;

function sessionUpdates(events: ServerEvent[]): SessionUpdatedEvent[] {
  return events.filter((event): event is SessionUpdatedEvent => event.type === 'session.updated');
}

function syncsSummary(
  calls: RecordedCall[],
  appSessionId: string,
  providerSessionId: string,
): boolean {
  return calls.some((call) => {
    if (call.target !== 'history' || call.method !== 'syncSummaries') return false;
    const summaries = call.args[0];
    return (
      Array.isArray(summaries) &&
      summaries.some(
        (summary) =>
          typeof summary === 'object' &&
          summary !== null &&
          'appSessionId' in summary &&
          summary.appSessionId === appSessionId &&
          'providerSessionId' in summary &&
          summary.providerSessionId === providerSessionId,
      )
    );
  });
}

function callCount(
  calls: RecordedCall[],
  target: RecordedCall['target'],
  method: string,
  id: string,
) {
  return calls.filter(
    (call) => call.target === target && call.method === method && call.args[0] === id,
  ).length;
}

test('[C0] Create arms daemon compaction without client-side turn compaction', async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'c0',
      title: 'C0',
      goal: 'ordinary turn',
      interactionMode: 'auto',
      autonomy: 'low',
      compactionTokenLimit: 600,
    });
    await h.waitForIdle();

    assert.equal(
      h.provider
        .session('provider-1')
        .settings.some(
          (settings) =>
            settings['compactionThresholdCheckEnabled'] === true &&
            settings['compactionTokenLimit'] === 600,
        ),
      true,
    );
    assert.equal(callCount(h.calls, 'provider', 'compactSession', 'provider-1'), 0);
  } finally {
    await h.dispose();
  }
});

test('[C1] Manual in-place compaction', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'c1',
      title: 'C1',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.waitForIdle();
    const compactGate = h.provider.deferNextCompaction('provider-1');
    const queuedStreamGate = h.provider.deferNextStream('provider-1');
    h.provider.session('provider-1').nextCompactResult = {
      newSessionId: 'provider-1',
      removedCount: 1,
    };

    const compacting = h.handle({
      type: 'session.compact',
      appSessionId: 'provider-1',
      customInstructions: 'preserve decisions',
    });
    await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'queued once' });
    compactGate.resolve();
    await h.provider.waitForPrompts('provider-1', 2);

    const compactingStatus = h.events.findIndex(
      (event): event is TranscriptEventAppended =>
        event.type === 'event.appended' && event.event.text === 'Compacting conversation...',
    );
    const refreshedContext = h.events.findIndex(
      (event, index) =>
        index > compactingStatus &&
        event.type === 'context.updated' &&
        event.sourceSessionId === 'provider-1',
    );
    const completionStatus = h.events.findIndex(
      (event): event is TranscriptEventAppended =>
        event.type === 'event.appended' && event.event.text === 'Compaction complete.',
    );
    assert.deepEqual(
      [
        compactingStatus >= 0,
        refreshedContext > compactingStatus,
        completionStatus > refreshedContext,
      ],
      [true, true, true],
    );
    const completionRecord = h.calls.findIndex((call) => {
      const [event] = call.args;
      return (
        call.target === 'protocol' &&
        call.method === 'event' &&
        event !== null &&
        typeof event === 'object' &&
        'type' in event &&
        event.type === 'event.appended' &&
        'event' in event &&
        event.event !== null &&
        typeof event.event === 'object' &&
        'text' in event.event &&
        event.event.text === 'Compaction complete.'
      );
    });
    const queuedDelivery = h.calls.findIndex(
      (call) =>
        call.target === 'provider' &&
        call.method === 'stream' &&
        call.args[0] === 'provider-1' &&
        call.args[1] === 'queued once',
    );
    assert.deepEqual([completionRecord >= 0, queuedDelivery > completionRecord], [true, true]);
    assert.deepEqual(h.provider.session('provider-1').prompts, ['go', 'queued once']);

    queuedStreamGate.resolve();
    await compacting;
    const compactCall = h.calls.find(
      (call) => call.target === 'provider' && call.method === 'compactSession',
    );
    assert.deepEqual(compactCall?.args, [
      'provider-1',
      { customInstructions: 'preserve decisions' },
    ]);
    assert.equal(callCount(h.calls, 'provider', 'stream', 'provider-1'), 2);
    assert.equal(sessionUpdates(h.events).at(-1)?.session.providerSessionId, 'provider-1');
  } finally {
    await h.dispose();
  }
});

test(
  'manual compaction failure stays recoverable and settles with a unique status',
  { concurrency: false },
  async (t) => {
    const h = createSessionManagerTestContext();

    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'compaction-failure',
        title: 'Compaction failure',
        goal: 'initial',
        interactionMode: 'auto',
        autonomy: 'low',
      });
      await h.waitForIdle();
      h.events.length = 0;
      h.provider.session('provider-1').nextCompactError = new Error('transient failure');
      t.mock.method(Date, 'now', () => 123_456);

      await h.handle({ type: 'session.compact', appSessionId: 'provider-1' });

      const statuses = h.events.filter(
        (event): event is TranscriptEventAppended =>
          event.type === 'event.appended' && event.event.kind === 'status',
      );
      assert.equal(statuses.length, 2);
      assert.equal(new Set(statuses.map((event) => event.event.id)).size, statuses.length);
      assert.equal(
        statuses.some((event) => /could not finish/i.test(event.event.text ?? '')),
        true,
      );
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'error' &&
            event.recoverable === true &&
            event.message === 'Could not compact session: transient failure',
        ),
        true,
      );
      assert.equal(
        sessionUpdates(h.events).some((event) => event.session.phase === 'failed'),
        false,
      );
    } finally {
      await h.dispose();
    }
  },
);

test('manual compaction is rejected while an ordinary turn is streaming', async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'compaction-streaming',
      title: 'Compaction streaming',
      goal: 'initial',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.waitForIdle();
    const streamGate = h.provider.deferNextStream('provider-1');
    const sending = h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'active turn',
    });
    await h.provider.waitForPrompts('provider-1', 2);

    await h.handle({ type: 'session.compact', appSessionId: 'provider-1' });

    assert.equal(callCount(h.calls, 'provider', 'compactSession', 'provider-1'), 0);
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'event.appended' &&
          /cannot compact while a turn is active/i.test(event.event.text ?? ''),
      ),
      true,
    );

    streamGate.resolve();
    await sending;
  } finally {
    await h.dispose();
  }
});

test('[C2] Provider-session swap', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'c2',
      title: 'C2',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.waitForIdle();
    h.provider.session('provider-1').nextCompactResult = {
      newSessionId: 'provider-2',
      removedCount: 1,
    };
    h.runtime.loadQueue.set('provider-2', [new FakeFactorySession('provider-2', {}, h.calls)]);

    await h.handle({ type: 'session.compact', appSessionId: 'provider-1' });

    const update = sessionUpdates(h.events).at(-1);
    const load = h.runtime.loadCalls.at(-1);
    const creation = h.runtime.createCalls[0];
    assert.ok(update);
    assert.ok(load);
    assert.ok(creation);
    assert.equal(update.session.appSessionId, 'provider-1');
    assert.equal(update.session.providerSessionId, 'provider-2');
    assert.equal(load.sessionId, 'provider-2');
    assert.equal(typeof load.handlers.permissionHandler, 'function');
    assert.equal(typeof load.handlers.askUserHandler, 'function');
    assert.equal(load.handlers.mcpServers, creation.mcpServers);
    assert.equal(load.handlers.mcpServers?.length, 1);
    assert.equal(callCount(h.calls, 'provider', 'onNotification', 'provider-2'), 1);
    assert.equal(callCount(h.calls, 'cleanup', 'unsubscribe', 'provider-1'), 1);
    assert.equal(
      h.provider
        .session('provider-2')
        .settings.some((settings) => settings['compactionThresholdCheckEnabled'] === true),
      true,
    );
    assert.equal(callCount(h.calls, 'cleanup', 'session.close', 'provider-1'), 1);
    assert.equal(syncsSummary(h.calls, 'provider-1', 'provider-2'), true);

    await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'after' });
    assert.deepEqual(h.provider.session('provider-2').prompts, ['after']);
    assert.equal(callCount(h.calls, 'provider', 'stream', 'provider-2'), 1);
  } finally {
    await h.dispose();
  }
});

test('[C3] Failed swap recovery', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'c3',
      title: 'C3',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.waitForIdle();
    const compactGate = h.provider.deferNextCompaction('provider-1');
    h.provider.session('provider-1').nextCompactResult = {
      newSessionId: 'provider-3',
      removedCount: 1,
    };
    h.runtime.loadQueue.set('provider-3', [
      new Error('first load fails'),
      new FakeFactorySession('provider-3', {}, h.calls),
    ]);

    const compacting = h.handle({ type: 'session.compact', appSessionId: 'provider-1' });
    await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'redeliver once' });
    compactGate.resolve();
    await compacting;

    assert.equal(h.runtime.loadCalls.filter((call) => call.sessionId === 'provider-3').length, 2);
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' && event.message === 'Could not compact session: first load fails',
      ),
      true,
    );
    assert.equal(sessionUpdates(h.events).at(-1)?.session.providerSessionId, 'provider-3');
    assert.deepEqual(h.provider.session('provider-3').prompts, ['redeliver once']);
    assert.equal(callCount(h.calls, 'provider', 'stream', 'provider-3'), 1);
    assert.equal(callCount(h.calls, 'provider', 'stream', 'provider-1'), 1);
    assert.equal(callCount(h.calls, 'cleanup', 'session.close', 'provider-1'), 1);
    assert.equal(syncsSummary(h.calls, 'provider-1', 'provider-3'), true);
  } finally {
    await h.dispose();
  }
});

test('[C7] Permanent swap failure settles after old-provider close rejects', async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'c7',
      title: 'C7',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.waitForIdle();
    const compactGate = h.provider.deferNextCompaction('provider-1');
    h.provider.session('provider-1').nextCompactResult = {
      newSessionId: 'provider-7',
      removedCount: 1,
    };
    h.provider.session('provider-1').nextCloseError = new Error('old provider close failed');
    const resumed = new FakeFactorySession('provider-7', {}, h.calls);
    writeProviderSessionStart(h.home, 'provider-7', 'C7 compacted');
    h.runtime.loadQueue.set('provider-7', [
      new Error('first adoption failed'),
      new Error('second adoption failed'),
      resumed,
    ]);

    const compacting = h.handle({ type: 'session.compact', appSessionId: 'provider-1' });
    await h.waitForIdle();
    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'redeliver after resume',
    });
    compactGate.resolve();
    await compacting;

    assert.equal(h.runtime.loadCalls.filter((call) => call.sessionId === 'provider-7').length, 3);
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' &&
          event.recoverable === true &&
          event.message ===
            'Compaction moved this conversation to a new session but reloading it failed: second adoption failed. It will reload on your next message.',
      ),
      true,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' &&
          event.providerSessionId === 'provider-1' &&
          event.recoverable === true &&
          event.message ===
            'Could not fully close the compacted session: old provider close failed',
      ),
      true,
    );
    assert.equal(syncsSummary(h.calls, 'provider-1', 'provider-7'), true);
    assert.equal(callCount(h.calls, 'cleanup', 'session.close', 'provider-1'), 1);
    assert.deepEqual(h.provider.session('provider-1').prompts, ['go']);
    assert.deepEqual(resumed.prompts, ['redeliver after resume']);
    assert.equal(callCount(h.calls, 'provider', 'stream', 'provider-7'), 1);
    assert.equal(sessionUpdates(h.events).at(-1)?.session.providerSessionId, 'provider-7');
  } finally {
    await h.dispose();
  }
});

test(
  '[C4] Automatic compaction retains the current interrupt escape hatch',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      const trace = await runAutoCompactionScenario(h);
      const scopedStatus = (id: string, role: 'primary' | 'worker') =>
        h.events.some(
          (event) =>
            event.type === 'event.appended' &&
            event.event.appSessionId === 'provider-1' &&
            event.event.sourceSessionId === id &&
            event.event.role === role &&
            event.event.compactType === 'auto',
        );
      assert.deepEqual(trace.interruptsAfterExplicitCommands, [1, 1]);
      assert.deepEqual(trace.interruptsAfterSteering, [1, 1]);
      assert.deepEqual(trace.closeCounts, [0, 0, 0]);
      const [parentContextsBefore, workerContextsBefore] = trace.contextsBefore;
      assert.ok(parentContextsBefore !== undefined);
      assert.ok(workerContextsBefore !== undefined);
      assert.deepEqual(
        [
          contextUpdateCount(h, 'provider-1') > parentContextsBefore,
          contextUpdateCount(h, 'worker-c4') > workerContextsBefore,
        ],
        [true, true],
      );
      assert.equal(
        scopedStatus('provider-1', 'primary') && scopedStatus('worker-c4', 'worker'),
        true,
      );
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'session.child' &&
            'appSessionId' in event &&
            event.appSessionId === 'provider-1' &&
            event.event === 'completed' &&
            event.providerSessionId === 'worker-c4',
        ),
        true,
      );
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'child.updated' &&
            'appSessionId' in event &&
            event.appSessionId === 'provider-1' &&
            event.providerSessionId === 'worker-c4' &&
            event.role === 'worker' &&
            event.status === 'completed',
        ),
        true,
      );
      assert.deepEqual(h.provider.session('provider-1').prompts, [
        'go',
        'parent running',
        'parent steer',
        'parent queued',
      ]);
      assert.deepEqual(h.provider.session('worker-c4').prompts, [
        'worker running',
        'worker steer',
        'worker queued',
      ]);
      assert.deepEqual(
        [
          callCount(h.calls, 'cleanup', 'session.close', 'worker-c4'),
          callCount(h.calls, 'cleanup', 'unsubscribe', 'worker-c4'),
        ],
        [1, 1],
      );
    } finally {
      await h.dispose();
    }
  },
);

test('[C5] Compaction retuning uses each live session model', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();
  const parent = new FakeFactorySession('provider-1', {}, h.calls);
  const worker = new FakeFactorySession('worker-c5', {}, h.calls);
  const validator = new FakeFactorySession('validator-c5', {}, h.calls);
  seedInitModel(parent, 'model-parent-loaded');
  seedInitModel(worker, 'model-worker-loaded');
  seedInitModel(validator, 'model-validator-loaded');
  h.runtime.createQueue.push(parent);
  h.runtime.loadQueue.set('worker-c5', [worker]);
  h.runtime.loadQueue.set('validator-c5', [validator]);
  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'c5',
      title: 'C5',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
      modelId: 'model-parent-effective',
      workerModel: 'model-worker-fallback',
      validatorModel: 'model-validator-fallback',
    });
    await h.waitForIdle();
    await h.handle({
      type: 'child.open',
      appSessionId: 'provider-1',
      providerSessionId: 'worker-c5',
      role: 'worker',
    });
    await h.handle({
      type: 'child.open',
      appSessionId: 'provider-1',
      providerSessionId: 'validator-c5',
      role: 'validator',
    });
    assert.deepEqual(
      h.runtime.loadCalls.map((call) => call.sessionId),
      ['worker-c5', 'validator-c5'],
    );
    const opened: ReadonlyArray<readonly [string, 'worker' | 'validator']> = [
      ['worker-c5', 'worker'],
      ['validator-c5', 'validator'],
    ];
    assert.deepEqual(
      opened.map(([childSessionId, role]) =>
        h.events.some(
          (event) =>
            event.type === 'child.updated' &&
            'parentAppSessionId' in event &&
            event.parentAppSessionId === 'provider-1' &&
            event.childSessionId === childSessionId &&
            event.role === role &&
            event.status === 'opened' &&
            event.settingsReady,
        ),
      ),
      [true, true],
    );
    await h.handle({
      type: 'settings.compaction.update',
      compactionTokenLimit: 400,
      compactionTokenLimitPerModel: {
        'model-parent-effective': 100,
        'model-worker-loaded': 200,
        'model-validator-loaded': 300,
        'model-worker-fallback': 201,
        'model-validator-fallback': 301,
      },
    });
    const limits: ReadonlyArray<readonly [string, number]> = [
      ['provider-1', 100],
      ['worker-c5', 200],
      ['validator-c5', 300],
    ];
    for (const [id, limit] of limits)
      assert.equal(
        h.provider
          .session(id)
          .settings.filter((settings) => settings['compactionThresholdCheckEnabled'] === true)
          .at(-1)?.['compactionTokenLimit'],
        limit,
      );
  } finally {
    await h.dispose();
  }
});

test('[C6] Close and shutdown clean keyed resources', { concurrency: false }, async () => {
  const close = await runCloseCleanupScenario();
  assert.equal(close.initialPollersDistinct, true);
  assert.equal(close.parentStartUntouchedByWorkerStart, true);
  assert.equal(close.watchdogHandlesDistinct, true);
  assert.equal(close.replacementPollersDistinct, true);
  assert.deepEqual(close.watchdogsActiveAtClose, [0, 0]);
  assert.deepEqual(close.initialClearState, [1, 1, 1, 1]);
  assert.deepEqual(close.cleanupAtClose, [1, 1, 1, 1, 1]);
  assert.deepEqual(close.closeTimerState, [1, 1, 1, 1]);
  assert.deepEqual(close.cleanupAfterShutdown, [1, 1, 1, 1, 1]);
  assert.deepEqual([close.browserClose, close.browserCloseAll, close.historyClose], [1, 1, 1]);

  const shutdown = await runShutdownOnlyCleanupScenario();
  assert.deepEqual(shutdown.cleanup, [1, 1, 1, 1, 1]);
  assert.deepEqual(shutdown.timerClears, [1, 1, 1, 1]);
  assert.deepEqual(shutdown.browserCounts, [1, 1]);
  assert.equal(shutdown.historyClose, 1);
});
