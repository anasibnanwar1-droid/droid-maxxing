import assert from 'node:assert/strict';
import test from 'node:test';

import { ContextStatsAccuracy } from '@factory/droid-sdk';

import { FakeFactorySession, type RecordedCall } from './testing/fakeFactoryRuntime.js';
import { writeProviderSessionStart } from './testing/historyCharacterizationSupport.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';
import type { ServerEvent } from './protocol.js';
import {
  contextUpdateCount,
  notifyCompaction,
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

test('daemon compaction notifications stream before an active turn settles', async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'mid-turn-compaction',
      title: 'Mid-turn compaction',
      goal: 'initial turn',
      interactionMode: 'auto',
      autonomy: 'low',
      compactionTokenLimit: 600,
    });
    await h.waitForIdle();

    const streamGate = h.provider.deferNextStream('provider-1');
    let turnSettled = false;
    const turn = h
      .handle({ type: 'session.send', appSessionId: 'provider-1', text: 'long running task' })
      .then(() => {
        turnSettled = true;
      });
    await h.provider.waitForPrompts('provider-1', 2);
    h.events.length = 0;

    notifyCompaction(h, 'provider-1', 'started');
    const started = h.events.findIndex(
      (event) =>
        event.type === 'event.appended' && event.event.text === 'Compacting conversation...',
    );
    assert.equal(turnSettled, false);
    assert.equal(started >= 0, true);

    notifyCompaction(h, 'provider-1', 'completed');
    const completed = h.events.findIndex(
      (event) => event.type === 'event.appended' && event.event.kind === 'compaction',
    );
    const summary = sessionUpdates(h.events).at(-1)?.session;
    assert.equal(turnSettled, false);
    assert.equal(completed > started, true);
    assert.equal(summary?.streaming, true);
    assert.equal(summary?.autoCompactions, 1);
    assert.equal(callCount(h.calls, 'provider', 'compactSession', 'provider-1'), 0);

    streamGate.resolve();
    await turn;
    assert.equal(turnSettled, true);
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
      const scopedStatus = (id: string, role: 'primary' | 'worker', childSessionId?: string) =>
        h.events.some(
          (event) =>
            event.type === 'event.appended' &&
            event.event.appSessionId === 'provider-1' &&
            event.event.sourceSessionId === id &&
            event.event.role === role &&
            (childSessionId === undefined || event.event.sourceSessionId === childSessionId) &&
            event.event.compactType === 'auto',
        );
      assert.deepEqual(trace.interruptsAfterExplicitCommands, [1, 1]);
      assert.deepEqual(trace.interruptsAfterSteering, [1, 1]);
      assert.deepEqual(trace.closeCounts, [0, 0, 1]);
      const [parentContextsBefore, workerContextsBefore] = trace.contextsBefore;
      assert.ok(parentContextsBefore !== undefined);
      assert.ok(workerContextsBefore !== undefined);
      assert.deepEqual(
        [
          contextUpdateCount(h, 'provider-1') > parentContextsBefore,
          contextUpdateCount(h, 'child-c4') > workerContextsBefore,
        ],
        [true, true],
      );
      assert.equal(
        scopedStatus('provider-1', 'primary') && scopedStatus('child-c4', 'worker', 'child-c4'),
        true,
      );
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'session.child' &&
            event.child.parentAppSessionId === 'provider-1' &&
            event.child.childSessionId === 'child-c4' &&
            event.child.status === 'completed',
        ),
        true,
      );
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'session.child' &&
            event.child.parentAppSessionId === 'provider-1' &&
            event.child.childSessionId === 'child-c4' &&
            event.child.role === 'worker' &&
            event.child.status === 'completed',
        ),
        true,
      );
      assert.deepEqual(h.provider.session('provider-1').prompts, [
        'go',
        'parent running',
        'parent steer',
        'parent queued',
      ]);
      assert.deepEqual(h.provider.session('worker-c4').prompts, ['worker running']);
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
    h.history.seedChildSessions([
      {
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-logical-c5',
        providerSessionId: 'worker-c5',
        role: 'worker',
        status: 'paused',
        modelId: 'model-worker-loaded',
        transcriptAvailable: true,
        updatedAt: Date.now(),
      },
      {
        parentAppSessionId: 'provider-1',
        childSessionId: 'validator-logical-c5',
        providerSessionId: 'validator-c5',
        role: 'validator',
        status: 'paused',
        modelId: 'model-validator-loaded',
        transcriptAvailable: true,
        updatedAt: Date.now(),
      },
    ]);
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'worker-logical-c5',
      requestId: 'open-worker-c5',
    });
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'validator-logical-c5',
      requestId: 'open-validator-c5',
    });
    assert.deepEqual(
      h.runtime.loadCalls.map((call) => call.sessionId),
      ['worker-c5', 'validator-c5'],
    );
    const opened: ReadonlyArray<readonly [string, 'worker' | 'validator']> = [
      ['worker-logical-c5', 'worker'],
      ['validator-logical-c5', 'validator'],
    ];
    assert.deepEqual(
      opened.map(([childSessionId, role]) =>
        h.events.some(
          (event) =>
            event.type === 'child.updated' &&
            'parentAppSessionId' in event &&
            event.parentAppSessionId === 'provider-1' &&
            event.childSessionId === childSessionId &&
            event.access === 'ready' &&
            h.events.some(
              (summaryEvent) =>
                summaryEvent.type === 'session.child' &&
                summaryEvent.child.childSessionId === childSessionId &&
                summaryEvent.child.role === role,
            ),
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

test(
  '[C8] Learned context window retunes with the 80% ceiling',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    const custom = new FakeFactorySession('provider-1', {}, h.calls, {
      settings: { modelId: 'custom-model' },
    });
    custom.nextContextStats = {
      used: 100,
      remaining: 9_900,
      limit: 10_000,
      accuracy: ContextStatsAccuracy.Estimated,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    h.runtime.createQueue.push(custom);
    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'c7',
        title: 'C7',
        goal: 'go',
        interactionMode: 'auto',
        autonomy: 'low',
        modelId: 'custom-model',
      });
      await h.waitForIdle();

      // Initial arm: custom-model is absent from the catalog, so there is no
      // window ceiling and the daemon default (250k) is used verbatim.
      const compactionArms = () =>
        h.provider
          .session('provider-1')
          .settings.filter((s) => s['compactionThresholdCheckEnabled'] === true);
      assert.equal(compactionArms().at(0)?.['compactionTokenLimit'], 250_000);

      // Wait for the poll → refresh → noteContextWindow → retuneAll chain.
      for (let i = 0; i < 5; i++) await h.waitForIdle();

      // After learning the 10k window from provider stats, the retune clamps to
      // 80% (8_000) — the compaction window fraction.
      assert.equal(compactionArms().at(-1)?.['compactionTokenLimit'], 8_000);
    } finally {
      await h.dispose();
    }
  },
);

test(
  '[C9] setInteractionMode re-arms the compaction threshold',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'c8',
        title: 'C8',
        goal: 'go',
        interactionMode: 'auto',
        autonomy: 'low',
      });
      await h.waitForIdle();

      const compactionArmCount = () =>
        h.provider
          .session('provider-1')
          .settings.filter((s) => s['compactionThresholdCheckEnabled'] === true).length;

      const latestArmLimit = () =>
        h.provider
          .session('provider-1')
          .settings.filter((s) => s['compactionThresholdCheckEnabled'] === true)
          .at(-1)?.['compactionTokenLimit'];

      const armsBefore = compactionArmCount();

      await h.handle({
        type: 'session.updateSettings',
        appSessionId: 'provider-1',
        interactionMode: 'spec',
      });
      await h.waitForIdle();

      // Switching to spec mode must re-arm with the new mode's default model.
      // The limit is the daemon default (250k) clamped to 80% of the model
      // window (1k → 800), so the re-arm must carry compactionTokenLimit 800.
      assert.equal(compactionArmCount() > armsBefore, true);
      assert.equal(latestArmLimit(), 800);
    } finally {
      await h.dispose();
    }
  },
);

test('[C10] Arm failure emits a visible recoverable error', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();
  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'c9',
      title: 'C9',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.waitForIdle();
    h.events.length = 0;
    h.provider.session('provider-1').nextUpdateSettingsError = new Error('provider rejected');

    await h.handle({
      type: 'settings.compaction.update',
      compactionTokenLimit: 400,
    });
    await h.waitForIdle();

    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' &&
          event.appSessionId === 'provider-1' &&
          event.recoverable === true &&
          /Could not arm auto-compaction/.test(event.message),
      ),
      true,
    );
  } finally {
    await h.dispose();
  }
});

test(
  '[C11] Lowering the limit below current usage compacts in place and resets the meter',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    const session = new FakeFactorySession('provider-1', {}, h.calls, {
      settings: { modelId: 'custom-model' },
    });
    session.nextContextStats = {
      used: 200_000,
      remaining: 800_000,
      limit: 1_000_000,
      accuracy: ContextStatsAccuracy.Estimated,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    h.runtime.createQueue.push(session);
    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'c11',
        title: 'C11',
        goal: 'go',
        interactionMode: 'auto',
        autonomy: 'low',
        modelId: 'custom-model',
        compactionTokenLimit: 250_000,
      });
      for (let i = 0; i < 5; i++) await h.waitForIdle();

      const compactionArms = () =>
        h.provider
          .session('provider-1')
          .settings.filter((s) => s['compactionThresholdCheckEnabled'] === true);
      assert.equal(compactionArms().at(-1)?.['compactionTokenLimit'], 250_000);
      assert.equal(sessionUpdates(h.events).at(-1)?.session.contextTokens, 200_000);

      // Drop the limit below the 200k already in the window. Our side only
      // re-arms the daemon threshold; nothing is restarted or compacted here.
      await h.handle({ type: 'settings.compaction.update', compactionTokenLimit: 100_000 });
      await h.waitForIdle();
      assert.equal(compactionArms().at(-1)?.['compactionTokenLimit'], 100_000);
      assert.equal(callCount(h.calls, 'provider', 'compactSession', 'provider-1'), 0);

      // The daemon reacts on its next threshold check with an in-place
      // compaction; completion must reset the meter to the fresh reading.
      session.nextContextStats = {
        used: 12_000,
        remaining: 988_000,
        limit: 1_000_000,
        accuracy: ContextStatsAccuracy.Estimated,
        updatedAt: '2026-01-01T00:01:00.000Z',
      };
      notifyCompaction(h, 'provider-1', 'started');
      notifyCompaction(h, 'provider-1', 'completed');
      for (let i = 0; i < 5; i++) await h.waitForIdle();

      const summary = sessionUpdates(h.events).at(-1)?.session;
      assert.equal(summary?.autoCompactions, 1);
      assert.equal(summary?.contextTokens, 12_000);
      assert.equal(
        h.events.some(
          (event) => event.type === 'event.appended' && event.event.kind === 'compaction',
        ),
        true,
      );

      // The session keeps taking turns afterwards.
      await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'after' });
      assert.deepEqual(h.provider.session('provider-1').prompts, ['go', 'after']);
    } finally {
      await h.dispose();
    }
  },
);
