import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FakeDroidSession,
  createSessionCharacterizationHarness,
} from './testing/sessionCharacterizationHarness.js';
import type { RecordedCall } from './testing/sessionCharacterizationHarness.js';
import type { ServerEvent } from './protocol.js';
import {
  contextUpdateCount,
  runAutoCompactionScenario,
  runCloseCleanupScenario,
  runShutdownOnlyCleanupScenario,
  seedInitModel,
} from './testing/compactionCharacterizationScenarios.js';

type MissionUpdatedEvent = Extract<ServerEvent, { type: 'session.updated' }>;
type MissionTranscriptEvent = Extract<ServerEvent, { type: 'event.appended' }>;

function missionUpdates(events: ServerEvent[]): MissionUpdatedEvent[] {
  return events.filter((event): event is MissionUpdatedEvent => event.type === 'session.updated');
}

function syncsSummary(calls: RecordedCall[], appSessionId: string, sessionId: string): boolean {
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
          summary.providerSessionId === sessionId,
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

test('[C1] Manual in-place compaction', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

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
      (event): event is MissionTranscriptEvent =>
        event.type === 'event.appended' && event.event.text === 'Compacting conversation...',
    );
    const refreshedContext = h.events.findIndex(
      (event, index) =>
        index > compactingStatus &&
        event.type === 'context.updated' &&
        event.sourceSessionId === 'provider-1',
    );
    const completionStatus = h.events.findIndex(
      (event): event is MissionTranscriptEvent =>
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
    assert.equal(missionUpdates(h.events).at(-1)?.session.providerSessionId, 'provider-1');
  } finally {
    await h.dispose();
  }
});

test('[C2] Provider-session swap', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

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
    h.runtime.loadQueue.set('provider-2', [new FakeDroidSession('provider-2', {}, h.calls)]);

    await h.handle({ type: 'session.compact', appSessionId: 'provider-1' });

    const update = missionUpdates(h.events).at(-1);
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
  const h = createSessionCharacterizationHarness();

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
      new FakeDroidSession('provider-3', {}, h.calls),
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
    assert.equal(missionUpdates(h.events).at(-1)?.session.providerSessionId, 'provider-3');
    assert.deepEqual(h.provider.session('provider-3').prompts, ['redeliver once']);
    assert.equal(callCount(h.calls, 'provider', 'stream', 'provider-3'), 1);
    assert.equal(callCount(h.calls, 'provider', 'stream', 'provider-1'), 1);
    assert.equal(callCount(h.calls, 'cleanup', 'session.close', 'provider-1'), 1);
    assert.equal(syncsSummary(h.calls, 'provider-1', 'provider-3'), true);
  } finally {
    await h.dispose();
  }
});

test(
  '[C4] Automatic compaction retains the current interrupt escape hatch',
  { concurrency: false },
  async () => {
    const h = createSessionCharacterizationHarness();
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
  const h = createSessionCharacterizationHarness();
  const parent = new FakeDroidSession('provider-1', {}, h.calls);
  const worker = new FakeDroidSession('worker-c5', {}, h.calls);
  const validator = new FakeDroidSession('validator-c5', {}, h.calls);
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
      opened.map(([providerSessionId, role]) =>
        h.events.some(
          (event) =>
            event.type === 'child.updated' &&
            event.appSessionId === 'provider-1' &&
            event.providerSessionId === providerSessionId &&
            event.role === role &&
            event.status === 'opened',
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

test.todo(
  "active worker/validator model changes must re-arm that exact child session with the new model's effective threshold without altering parent/other children",
);
test.todo(
  "closing or shutting down with an active worker stream must prevent its later unwind from re-arming that worker's watchdog or context poller",
);

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
