import assert from 'node:assert/strict';
import test from 'node:test';
import type { AskUserResult, RequestPermissionHandlerResult } from '@factory/droid-sdk';

import type { ServerEvent, SessionSummary } from './protocol.js';
import { SessionCompaction } from './SessionCompaction.js';
import type { LiveSession } from './SessionLifecycle.js';
import type { SessionSummaryPatch } from './SessionRegistry.js';
import { createCompactionTestLiveSession } from './testing/compactionTestSupport.js';
import {
  FakeFactoryRuntime,
  FakeFactorySession,
  type RecordedCall,
} from './testing/fakeFactoryRuntime.js';

type CompactionError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

class NoopCompactionSession extends FakeFactorySession {
  override async compactSession(
    options: Parameters<FakeFactorySession['compactSession']>[0] = {},
  ): ReturnType<FakeFactorySession['compactSession']> {
    await super.compactSession(options);
    // Factory can return no result for a noop even though the current SDK type omits it.
    const runtimeNoop: object = {};
    return Reflect.get(runtimeNoop, 'outcome');
  }
}

class TestRegistry {
  readonly live = new Map<string, LiveSession>();
  readonly historical = new Map<string, SessionSummary>();
  nextReplaceError?: Error;

  getLive(id: string): LiveSession | undefined {
    return (
      this.live.get(id) ??
      [...this.live.values()].find(
        (session) =>
          session.summary.providerSessionId === id ||
          session.summary.compactedFromProviderSessionIds?.includes(id),
      )
    );
  }

  resolveSummary(id: string): SessionSummary | undefined {
    const live = this.getLive(id);
    if (live) return live.summary;
    return (
      this.historical.get(id) ??
      [...this.historical.values()].find(
        (summary) =>
          summary.providerSessionId === id || summary.compactedFromProviderSessionIds?.includes(id),
      )
    );
  }

  updateSummary(id: string, patch: SessionSummaryPatch): SessionSummary | undefined {
    const live = this.getLive(id);
    if (!live) return undefined;
    live.summary = { ...live.summary, ...patch };
    return live.summary;
  }

  replaceProvider(
    id: string,
    providerSessionId: string,
    patch: SessionSummaryPatch = {},
  ): SessionSummary | undefined {
    const error = this.nextReplaceError;
    delete this.nextReplaceError;
    if (error) throw error;
    const summary = this.resolveSummary(id);
    if (!summary) return undefined;
    const previousProviderSessionId = summary.providerSessionId ?? summary.appSessionId;
    const updated: SessionSummary = {
      ...summary,
      ...patch,
      providerSessionId,
      compactedFromProviderSessionIds: [
        ...(summary.compactedFromProviderSessionIds ?? []),
        previousProviderSessionId,
      ],
    };
    const live = this.getLive(id);
    if (live) live.summary = updated;
    else this.historical.set(updated.appSessionId, updated);
    return updated;
  }
}

function createHarness() {
  const calls: RecordedCall[] = [];
  const errors: CompactionError[] = [];
  const preserved: { appSessionId: string; tokensIn: number; tokensOut: number }[] = [];
  const refreshed: string[] = [];
  const statuses: string[] = [];
  const registry = new TestRegistry();
  const runtime = new FakeFactoryRuntime(calls);
  let shutdownStarted = false;
  const compaction = new SessionCompaction({
    registry,
    context: {
      recordCompaction: () => undefined,
      refresh: (target) => {
        if (target.isCurrent()) refreshed.push(target.sourceSessionId);
        return Promise.resolve();
      },
      preserveUsage: (appSessionId, usage) => {
        preserved.push({ appSessionId, ...usage });
      },
    },
    timeline: {
      appendStatus: (_appSessionId, text) => {
        statuses.push(text);
      },
    },
    runtime,
    makePermissionHandler: () => () => new Promise<RequestPermissionHandlerResult>(() => undefined),
    makeAskUserHandler: () => () => new Promise<AskUserResult>(() => undefined),
    emitError: (error) => {
      errors.push(error);
    },
    isShutdownStarted: () => shutdownStarted,
    getFactoryDefaults: () => Promise.resolve({}),
    maxContextTokensForModel: () => 1_000,
    resolveAutomaticTarget: () => undefined,
    settleAutomatic: () => undefined,
  });
  return {
    calls,
    compaction,
    errors,
    preserved,
    refreshed,
    registry,
    runtime,
    setShutdownStarted: () => {
      shutdownStarted = true;
    },
    statuses,
  };
}

function addLive(
  harness: ReturnType<typeof createHarness>,
  appSessionId = 'app-1',
  providerSessionId = 'provider-1',
  session: FakeFactorySession = new FakeFactorySession(providerSessionId, {}, harness.calls),
) {
  const live = createCompactionTestLiveSession(appSessionId, session);
  live.summary.tokensIn = 12;
  live.summary.tokensOut = 4;
  live.summary.contextTokens = 80;
  live.summary.autoCompactions = 2;
  harness.registry.live.set(appSessionId, live);
  return { live, session };
}

function closeCount(calls: RecordedCall[], providerSessionId: string): number {
  return calls.filter(
    (call) =>
      call.target === 'cleanup' &&
      call.method === 'session.close' &&
      call.args[0] === providerSessionId,
  ).length;
}

test('manual in-place compaction refreshes context and returns ready to settle', async () => {
  const h = createHarness();
  const { live, session } = addLive(h);
  session.nextCompactResult = { newSessionId: session.sessionId, removedCount: 1 };

  const result = await h.compaction.compact('app-1', 'preserve decisions');

  assert.deepEqual(result, { kind: 'ready-to-settle' });
  assert.equal(live.compacting, false);
  assert.deepEqual(
    [live.summary.contextTokens, live.summary.autoCompactions, h.refreshed],
    [0, 3, ['app-1']],
  );
  assert.deepEqual(h.statuses, ['Compacting conversation...', 'Compaction complete.']);
  assert.deepEqual(h.calls.find((call) => call.method === 'compactSession')?.args, [
    'provider-1',
    { customInstructions: 'preserve decisions' },
  ]);
});

test('manual noop and failure outcomes remain ready to settle', async () => {
  const noopHarness = createHarness();
  const noopSession = new NoopCompactionSession('provider-noop', {}, noopHarness.calls);
  const { live: noopLive } = addLive(noopHarness, 'app-noop', noopSession.sessionId, noopSession);

  assert.deepEqual(await noopHarness.compaction.compact('app-noop'), {
    kind: 'ready-to-settle',
  });
  assert.equal(noopLive.compacting, false);
  assert.deepEqual(noopHarness.statuses, ['Compacting conversation...', 'Nothing to compact.']);
  assert.deepEqual(noopHarness.refreshed, []);
  assert.deepEqual([noopLive.summary.contextTokens, noopLive.summary.autoCompactions], [80, 2]);
  assert.deepEqual(noopHarness.errors, []);

  const failedHarness = createHarness();
  const { live: failedLive, session: failedSession } = addLive(
    failedHarness,
    'app-failed',
    'provider-failed',
  );
  failedSession.nextCompactError = new Error('provider rejected');

  assert.deepEqual(await failedHarness.compaction.compact('app-failed'), {
    kind: 'ready-to-settle',
  });
  assert.equal(failedLive.compacting, false);
  assert.deepEqual(failedHarness.refreshed, []);
  assert.deepEqual([failedLive.summary.contextTokens, failedLive.summary.autoCompactions], [80, 2]);
  assert.deepEqual(failedHarness.statuses, [
    'Compacting conversation...',
    'Compaction could not finish; continuing with the current conversation.',
  ]);
  assert.equal(
    failedHarness.errors.some(
      (error) =>
        error.recoverable === true &&
        error.message === 'Could not compact session: provider rejected',
    ),
    true,
  );
});

test('provider adoption retries cleanly after a partial first adoption', async () => {
  const h = createHarness();
  const { live, session: original } = addLive(h);
  const firstReplacement = new FakeFactorySession('provider-2', {}, h.calls);
  const secondReplacement = new FakeFactorySession('provider-2', {}, h.calls);
  original.nextCompactResult = { newSessionId: 'provider-2', removedCount: 1 };
  h.runtime.loadQueue.set('provider-2', [firstReplacement, secondReplacement]);
  h.registry.nextReplaceError = new Error('first persistence failed');

  const result = await h.compaction.compact('app-1');

  assert.deepEqual(result, { kind: 'ready-to-settle' });
  assert.equal(live.session, secondReplacement);
  assert.equal(live.summary.providerSessionId, 'provider-2');
  assert.deepEqual([closeCount(h.calls, 'provider-1'), closeCount(h.calls, 'provider-2')], [1, 1]);
  assert.deepEqual(h.preserved, [
    { appSessionId: 'app-1', tokensIn: 12, tokensOut: 4 },
    { appSessionId: 'app-1', tokensIn: 12, tokensOut: 4 },
  ]);
  assert.equal(
    h.errors.some((error) => error.message.includes('first persistence failed')),
    true,
  );
});

test('provider adoption continuations become inert after shutdown starts', async () => {
  const h = createHarness();
  const { session: original } = addLive(h);
  const replacement = new FakeFactorySession('provider-shutdown', {}, h.calls);
  const compactGate = original.deferNextCompaction();
  original.nextCompactResult = { newSessionId: replacement.sessionId, removedCount: 1 };
  h.runtime.loadQueue.set(replacement.sessionId, [replacement]);

  const compacting = h.compaction.compact('app-1');
  h.setShutdownStarted();
  compactGate.resolve();
  const result = await compacting;
  const statusesAfterCompaction = h.statuses.length;
  replacement.emitNotification({
    jsonrpc: '2.0',
    method: 'droid.session_notification',
    params: {
      notification: {
        type: 'droid_working_state_changed',
        newState: 'compacting_conversation',
      },
    },
  });

  assert.deepEqual(result, { kind: 'ready-to-settle' });
  assert.deepEqual(replacement.settings, []);
  assert.deepEqual(h.refreshed, []);
  assert.equal(h.statuses.length, statusesAfterCompaction);
});

test('permanent adoption failure persists the daemon identity before recovery', async () => {
  const h = createHarness();
  const { live, session } = addLive(h);
  session.nextCompactResult = { newSessionId: 'provider-7', removedCount: 1 };
  h.runtime.loadQueue.set('provider-7', [
    new Error('first adoption failed'),
    new Error('second adoption failed'),
  ]);

  const result = await h.compaction.compact('app-1');

  assert.deepEqual(result, {
    kind: 'close-and-resume',
    appSessionId: 'app-1',
    providerSessionId: 'provider-7',
    carryover: { tokensIn: 12, tokensOut: 4 },
  });
  assert.equal(live.summary.providerSessionId, 'provider-7');
  assert.equal(live.compacting, false);
  assert.equal(closeCount(h.calls, 'provider-1'), 0);
});

test('permanent recovery rejects when the daemon identity cannot be persisted', async () => {
  const h = createHarness();
  const { live, session } = addLive(h);
  session.nextCompactResult = { newSessionId: 'provider-8', removedCount: 1 };
  h.runtime.loadQueue.set('provider-8', [new Error('load one'), new Error('load two')]);
  h.registry.nextReplaceError = new Error('history unavailable');

  await assert.rejects(h.compaction.compact('app-1'), /history unavailable/);

  assert.equal(live.summary.providerSessionId, 'provider-1');
  assert.equal(live.compacting, false);
  assert.equal(
    h.errors.some(
      (error) =>
        error.providerSessionId === 'provider-8' &&
        error.recoverable === true &&
        error.message === 'Could not persist compacted session identity: history unavailable',
    ),
    true,
  );
});

test('historical compaction uses a temporary provider without live side effects', async () => {
  const h = createHarness();
  const historical = createCompactionTestLiveSession(
    'app-history',
    new FakeFactorySession('provider-history', {}, h.calls),
  ).summary;
  h.registry.historical.set(historical.appSessionId, historical);
  const temporary = new FakeFactorySession('provider-history', {}, h.calls);
  temporary.nextCompactResult = { newSessionId: 'provider-history-2', removedCount: 1 };
  h.runtime.loadQueue.set('provider-history', [temporary]);

  const result = await h.compaction.compact('provider-history', 'keep decisions');

  assert.deepEqual(result, { kind: 'ready-to-settle' });
  assert.equal(h.registry.resolveSummary('app-history')?.providerSessionId, 'provider-history-2');
  assert.equal(closeCount(h.calls, 'provider-history'), 1);
  assert.deepEqual([h.statuses, h.refreshed, h.preserved], [[], [], []]);
  assert.deepEqual(temporary.settings, []);
});
