import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FakeDroidSession,
  createSessionCharacterizationHarness,
} from './testing/sessionCharacterizationHarness.js';
import type { RecordedCall } from './testing/sessionCharacterizationHarness.js';
import type { ServerEvent } from './protocol.js';

type MissionUpdatedEvent = Extract<ServerEvent, { type: 'mission.updated' }>;
type MissionTranscriptEvent = Extract<ServerEvent, { type: 'mission.transcript' }>;

function missionUpdates(events: ServerEvent[]): MissionUpdatedEvent[] {
  return events.filter((event): event is MissionUpdatedEvent => event.type === 'mission.updated');
}

function syncsSummary(calls: RecordedCall[], missionId: string, sessionId: string): boolean {
  return calls.some((call) => {
    if (call.target !== 'history' || call.method !== 'syncSummaries') return false;
    const summaries = call.args[0];
    return (
      Array.isArray(summaries) &&
      summaries.some(
        (summary) =>
          typeof summary === 'object' &&
          summary !== null &&
          'id' in summary &&
          summary.id === missionId &&
          'sessionId' in summary &&
          summary.sessionId === sessionId,
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
      type: 'mission.compact',
      missionId: 'provider-1',
      customInstructions: 'preserve decisions',
    });
    await h.handle({ type: 'mission.send', missionId: 'provider-1', text: 'queued once' });
    compactGate.resolve();
    await h.provider.waitForPrompts('provider-1', 2);

    const compactingStatus = h.events.findIndex(
      (event): event is MissionTranscriptEvent =>
        event.type === 'mission.transcript' && event.event.text === 'Compacting conversation...',
    );
    const refreshedContext = h.events.findIndex(
      (event, index) =>
        index > compactingStatus &&
        event.type === 'context.updated' &&
        event.sessionId === 'provider-1',
    );
    const completionStatus = h.events.findIndex(
      (event): event is MissionTranscriptEvent =>
        event.type === 'mission.transcript' && event.event.text === 'Compaction complete.',
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
        event.type === 'mission.transcript' &&
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
    assert.equal(missionUpdates(h.events).at(-1)?.mission.sessionId, 'provider-1');
  } finally {
    await h.dispose();
  }
});

test('[C2] Provider-session swap', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    await h.create({
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

    await h.handle({ type: 'mission.compact', missionId: 'provider-1' });

    const update = missionUpdates(h.events).at(-1);
    const load = h.runtime.loadCalls.at(-1);
    const creation = h.runtime.createCalls[0];
    assert.ok(update);
    assert.ok(load);
    assert.ok(creation);
    assert.equal(update.mission.id, 'provider-1');
    assert.equal(update.mission.sessionId, 'provider-2');
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

    await h.handle({ type: 'mission.send', missionId: 'provider-1', text: 'after' });
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

    const compacting = h.handle({ type: 'mission.compact', missionId: 'provider-1' });
    await h.handle({ type: 'mission.send', missionId: 'provider-1', text: 'redeliver once' });
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
    assert.equal(
      h.events.some((event) => event.type === 'mission.error'),
      false,
    );
    assert.equal(missionUpdates(h.events).at(-1)?.mission.sessionId, 'provider-3');
    assert.deepEqual(h.provider.session('provider-3').prompts, ['redeliver once']);
    assert.equal(callCount(h.calls, 'provider', 'stream', 'provider-3'), 1);
    assert.equal(callCount(h.calls, 'provider', 'stream', 'provider-1'), 1);
    assert.equal(callCount(h.calls, 'cleanup', 'session.close', 'provider-1'), 1);
    assert.equal(syncsSummary(h.calls, 'provider-1', 'provider-3'), true);
  } finally {
    await h.dispose();
  }
});
