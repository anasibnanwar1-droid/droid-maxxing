import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReasoningEffort,
  type AskUserResult,
  type RequestPermissionHandlerResult,
} from '@factory/droid-sdk';
import type { HistoricalSession } from './history.js';
import type { FactoryDefaultSettings, ServerEvent, SessionSummary } from './protocol.js';
import {
  SessionLifecycle,
  type LiveChildSession,
  type LiveSession,
  type SessionCreateCommand,
} from './SessionLifecycle.js';
import { SessionRegistry } from './SessionRegistry.js';
import {
  FakeFactoryRuntime,
  FakeFactorySession,
  type RecordedCall,
} from './testing/fakeFactoryRuntime.js';

class TestHistory {
  readonly persisted: SessionSummary[] = [];
  readonly patches = new Map<string, Partial<SessionSummary>>();
  readonly hidden = new Set<string>();
  constructor(private readonly calls: RecordedCall[]) {}
  syncSummaries(summaries: SessionSummary[]): void {
    this.persisted.push(...summaries.map((summary) => ({ ...summary })));
    this.calls.push({ target: 'history', method: 'syncSummaries', args: summaries });
  }
  summaryPatches(): Map<string, Partial<SessionSummary>> {
    return this.patches;
  }
  hiddenProviderSessionIds(): Set<string> {
    return this.hidden;
  }
}

class RejectingInterruptSession extends FakeFactorySession {
  override interrupt(): Promise<void> {
    return super.interrupt().then(() => {
      throw new Error('interrupt rejected');
    });
  }
}

function createHarness(ordinarySummaries: SessionSummary[] = []) {
  const calls: RecordedCall[] = [];
  const events: ServerEvent[] = [];
  const history = new TestHistory(calls);
  const runtime = new FakeFactoryRuntime(calls);
  let projection: Partial<SessionSummary> = {};
  let applyPending: (appSessionId: string) => Promise<boolean> = () => Promise.resolve(true);
  let now = 10_000;
  let mcpId = 0;
  const historical = (): HistoricalSession[] =>
    ordinarySummaries.map((item) => ({ summary: { ...item }, progress: [] }));
  const recordEvent = (event: ServerEvent): void => {
    events.push(event);
    calls.push({ target: 'protocol', method: event.type, args: [event] });
  };
  const registry = new SessionRegistry<LiveSession>({
    history,
    loadOrdinarySessions: historical,
    loadMissionControlSessions: () => [],
    projectSummary: (item) => ({ ...item, ...projection }),
    onSummaryUpdated: (session) => recordEvent({ type: 'session.updated', session }),
    now: () => {
      now += 1;
      return now;
    },
  });
  const defaults: FactoryDefaultSettings = {
    modelId: 'model-default',
    reasoningEffort: ReasoningEffort.Low,
    autonomy: 'low',
    interactionMode: 'auto',
  };
  const lifecycle = new SessionLifecycle({
    runtime,
    registry,
    ensureConnected: () => {
      calls.push({ target: 'runtime', method: 'ensureConnected', args: [] });
    },
    getFactoryDefaults: () => Promise.resolve(defaults),
    maxContextTokensForModel: () => 1_000,
    startLocalMcpServers: () => {
      mcpId += 1;
      calls.push({ target: 'runtime', method: 'mcp.start', args: [mcpId] });
      return Promise.resolve({
        servers: [
          {
            close: () => {
              calls.push({ target: 'cleanup', method: 'mcp.close', args: [`mcp-${mcpId}`] });
              return Promise.resolve();
            },
          },
        ],
        configs: [],
      });
    },
    makePermissionHandler: () => () => new Promise<RequestPermissionHandlerResult>(() => undefined),
    makeAskUserHandler: () => () => new Promise<AskUserResult>(() => undefined),
    compactionLimit: () => Promise.resolve(800),
    enableDaemonAutoCompaction: (session, limit) => {
      calls.push({
        target: 'provider',
        method: 'autoCompaction.arm',
        args: [session.sessionId, limit],
      });
      return Promise.resolve(true);
    },
    subscribeSessionCompaction: (live) => {
      live.unsubscribe = live.session.onNotification(() => undefined);
    },
    childSessionLinks: () => [],
    applyPendingSettingsToSummary: (item) => ({ ...item, ...projection }),
    applyPendingSessionSettings: (appSessionId) => applyPending(appSessionId),
    runPrimaryTurn: async (live, prompt) => {
      for await (const event of live.session.stream(prompt, { includePartialMessages: true })) {
        void event;
      }
    },
    refreshContext: (sourceSessionId) => {
      calls.push({ target: 'provider', method: 'context.refresh', args: [sourceSessionId] });
      return Promise.resolve();
    },
    onTurnSettledWhileAutoCompacting: (appSessionId) => {
      calls.push({ target: 'cleanup', method: 'autoCompaction.settled', args: [appSessionId] });
    },
    stopContextPolling: (sourceSessionId) => {
      calls.push({ target: 'cleanup', method: 'poll.stop', args: [sourceSessionId] });
    },
    clearAutoCompactionWatchdog: (sessionId) => {
      calls.push({ target: 'cleanup', method: 'watchdog.clear', args: [sessionId] });
    },
    clearSessionRuntimeCaches: (live) => {
      calls.push({
        target: 'cleanup',
        method: 'runtimeCaches.clear',
        args: [live.summary.appSessionId],
      });
    },
    closeBrowserSession: (appSessionId) => {
      calls.push({ target: 'browser', method: 'browser.close', args: [appSessionId] });
      return Promise.resolve();
    },
    emit: recordEvent,
    emitError: (error) => recordEvent({ type: 'error', ...error }),
    emitStatus: (appSessionId, text) => {
      calls.push({ target: 'protocol', method: 'status', args: [appSessionId, text] });
    },
    emitSessionList: () =>
      recordEvent({ type: 'sessions.list', sessions: registry.listSummaries() }),
  });

  return {
    calls,
    events,
    history,
    runtime,
    registry,
    lifecycle,
    setProjection: (patch: Partial<SessionSummary>) => {
      projection = { ...patch };
    },
    setPendingApply: (action: (appSessionId: string) => Promise<boolean>) => {
      applyPending = action;
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

function summary(
  appSessionId: string,
  providerSessionId = appSessionId,
  patch: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'user',
    title: appSessionId,
    goal: 'test',
    cwd: '/workspace',
    workspaceKind: 'folder',
    modelId: 'model-default',
    reasoningEffort: ReasoningEffort.Low,
    autonomy: 'low',
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function createCommand(goal = 'first'): SessionCreateCommand {
  return {
    type: 'session.create',
    clientRef: 'client-1',
    title: 'Test session',
    goal,
    cwd: '/workspace',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    autonomy: 'low',
  };
}

function queueCreate(harness: Harness, sessionId: string): FakeFactorySession {
  const session = new FakeFactorySession(sessionId, {}, harness.calls);
  harness.runtime.createQueue.push(session);
  return session;
}

function queueLoad(
  harness: Harness,
  providerSessionId: string,
  session: FakeFactorySession = new FakeFactorySession(providerSessionId, {}, harness.calls),
): FakeFactorySession {
  harness.runtime.loadQueue.set(providerSessionId, [session]);
  return session;
}

function requireLive(harness: Harness, id: string): LiveSession {
  const live = harness.registry.getLive(id);
  assert.ok(live);
  return live;
}

function interruptCount(harness: Harness): number {
  return harness.calls.filter((call) => call.target === 'provider' && call.method === 'interrupt')
    .length;
}

test('create and cold resume publish only after registration', async () => {
  const created = createHarness();
  const createdProvider = queueCreate(created, 'created-1');
  await created.lifecycle.create(createCommand());
  await createdProvider.waitForPrompts(1);
  const createTrace = created.calls.map((call) => call.method);
  const createPersist = createTrace.indexOf('syncSummaries');
  const createPublished = createTrace.indexOf('session.created');
  assert.ok(createPersist >= 0 && createPersist < createPublished);
  assert.ok(createPublished < createTrace.indexOf('stream'));
  assert.equal(created.registry.getCanonicalSummary('created-1')?.appSessionId, 'created-1');
  const resumed = createHarness([summary('app-2', 'provider-2')]);
  queueLoad(resumed, 'provider-2');
  await resumed.lifecycle.resume('app-2');

  const resumeTrace = resumed.calls.map((call) => call.method);
  assert.deepEqual(
    resumeTrace.filter((method) =>
      ['loadSession', 'autoCompaction.arm', 'onNotification', 'syncSummaries'].includes(method),
    ),
    ['loadSession', 'autoCompaction.arm', 'onNotification', 'syncSummaries'],
  );
  assert.deepEqual(
    resumed.events.slice(-2).map((event) => event.type),
    ['session.created', 'session.updated'],
  );
});

test('create failure closes started MCP resources without publishing', async () => {
  const harness = createHarness();
  harness.runtime.createQueue.push(new Error('create failed'));
  await harness.lifecycle.create(createCommand());
  assert.equal(harness.calls.filter((call) => call.method === 'mcp.close').length, 1);
  assert.equal(harness.history.persisted.length, 0);
  assert.equal(
    harness.events.some((event) => event.type === 'session.created'),
    false,
  );
  assert.equal(
    harness.events.some((event) => event.type === 'error' && event.message === 'create failed'),
    true,
  );
});

test('send lazily resumes once and sends the prompt exactly once', async () => {
  const harness = createHarness([summary('app-3', 'provider-3')]);
  const provider = queueLoad(harness, 'provider-3');
  await harness.lifecycle.send('app-3', 'only once');
  assert.equal(harness.runtime.loadCalls.length, 1);
  assert.deepEqual(provider.prompts, ['only once']);
});

test('queued sends stay FIFO while send-now prompts are newest first', async () => {
  const fifo = createHarness();
  const fifoProvider = queueCreate(fifo, 'fifo');
  const fifoGate = fifoProvider.deferNextStream();
  await fifo.lifecycle.create(createCommand('first'));
  await fifoProvider.waitForPrompts(1);
  await fifo.lifecycle.send('fifo', 'second');
  await fifo.lifecycle.send('fifo', 'third');
  fifoGate.resolve();
  await fifoProvider.waitForPrompts(3);
  assert.deepEqual(fifoProvider.prompts, ['first', 'second', 'third']);
  const steered = createHarness();
  const steerProvider = queueCreate(steered, 'steered');
  const steerGate = steerProvider.deferNextStream();
  await steered.lifecycle.create(createCommand('first'));
  await steerProvider.waitForPrompts(1);
  await steered.lifecycle.sendNow('steered', 'steer one');
  await steered.lifecycle.sendNow('steered', 'steer two');
  steerGate.resolve();
  await steerProvider.waitForPrompts(3);
  assert.deepEqual(steerProvider.prompts, ['first', 'steer two', 'steer one']);
  assert.equal(interruptCount(steered), 2);
});

test('send-now queues without interrupting compaction and reports interrupt rejection', async () => {
  const compacting = createHarness();
  const provider = queueCreate(compacting, 'compacting');
  await compacting.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const live = requireLive(compacting, 'compacting');
  live.compacting = true;
  await compacting.lifecycle.sendNow('compacting', 'manual');
  live.compacting = false;
  live.autoCompacting = true;
  await compacting.lifecycle.sendNow('compacting', 'automatic');
  assert.deepEqual(live.pendingSends, ['automatic', 'manual']);
  assert.equal(interruptCount(compacting), 0);
  const rejected = createHarness();
  const rejectingProvider = new RejectingInterruptSession('rejected', {}, rejected.calls);
  const gate = rejectingProvider.deferNextStream();
  rejected.runtime.createQueue.push(rejectingProvider);
  await rejected.lifecycle.create(createCommand());
  await rejectingProvider.waitForPrompts(1);
  await rejected.lifecycle.sendNow('rejected', 'keep queued');
  assert.deepEqual(requireLive(rejected, 'rejected').pendingSends, ['keep queued']);
  assert.equal(requireLive(rejected, 'rejected').interruptingForSteer, false);
  assert.equal(
    rejected.events.some(
      (event) => event.type === 'error' && event.code === 'session.send_now_failed',
    ),
    true,
  );
  gate.resolve();
  await rejectingProvider.waitForPrompts(2);
});

test('interrupt handles idle, streaming, manual compaction, and auto-compaction states', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'stop');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const live = requireLive(harness, 'stop');
  await harness.lifecycle.interrupt('stop');
  assert.equal(interruptCount(harness), 1);
  assert.equal(live.interrupting, false);
  live.streaming = true;
  await harness.lifecycle.interrupt('stop');
  assert.equal(interruptCount(harness), 2);
  assert.equal(live.interrupting, true);
  live.streaming = false;
  live.interrupting = false;
  live.compacting = true;
  live.pendingSends = ['drop'];
  await harness.lifecycle.interrupt('stop');
  assert.equal(interruptCount(harness), 2);
  assert.deepEqual(live.pendingSends, []);
  live.compacting = false;
  live.autoCompacting = true;
  await harness.lifecycle.interrupt('stop');
  assert.equal(interruptCount(harness), 3);
  assert.equal(live.autoCompacting, false);
  assert.equal(
    harness.calls.some((call) => call.method === 'watchdog.clear' && call.args[0] === 'stop'),
    true,
  );
});

test('resuming an already-live session does not reload or persist it', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'live');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  harness.calls.length = 0;
  harness.events.length = 0;
  harness.history.persisted.length = 0;
  await harness.lifecycle.resume('live');
  assert.equal(harness.runtime.loadCalls.length, 0);
  assert.equal(harness.history.persisted.length, 0);
  assert.deepEqual(
    harness.events.map((event) => event.type),
    ['session.created'],
  );
  assert.equal(harness.calls.filter((call) => call.method === 'context.refresh').length, 1);
});

test('close follows ownership order and closeAll closes its initial snapshot', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'owner');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const live = requireLive(harness, 'owner');
  const child = new FakeFactorySession('child', {}, harness.calls);
  const childLive: LiveChildSession = {
    session: child,
    providerSessionId: 'child',
    appSessionId: 'owner',
    role: 'worker',
    lastUsedAt: 1,
    streaming: false,
    autoCompacting: false,
    pendingSends: [],
    unsubscribe: child.onNotification(() => undefined),
  };
  live.childSessions.set('child', childLive);
  harness.calls.length = 0;
  await harness.lifecycle.close('owner');
  const closeTrace = harness.calls
    .filter((call) =>
      [
        'unsubscribe',
        'session.close',
        'mcp.close',
        'browser.close',
        'runtimeCaches.clear',
      ].includes(call.method),
    )
    .map((call) => `${call.method}:${String(call.args[0] ?? '')}`);
  assert.deepEqual(closeTrace, [
    'unsubscribe:owner',
    'unsubscribe:child',
    'session.close:child',
    'mcp.close:mcp-1',
    'session.close:owner',
    'browser.close:owner',
    'runtimeCaches.clear:owner',
  ]);
  assert.equal(harness.registry.getLive('owner'), undefined);
  const all = createHarness();
  const first = queueCreate(all, 'first');
  const second = queueCreate(all, 'second');
  await all.lifecycle.create(createCommand());
  await first.waitForPrompts(1);
  await all.lifecycle.create(createCommand());
  await second.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await all.lifecycle.closeAll();
  assert.deepEqual(
    all.calls.filter((call) => call.method === 'session.close').map((call) => call.args[0]),
    ['first', 'second'],
  );
  assert.equal(all.registry.liveSessionsSnapshot().length, 0);
});

test('pending settings stay projected until successful first-send application', async () => {
  const saved = summary('app-pending', 'provider-pending', {
    modelId: 'model-saved',
    reasoningEffort: ReasoningEffort.Low,
  });
  const harness = createHarness([saved]);
  const provider = new FakeFactorySession('provider-pending', {}, harness.calls, {
    settings: { modelId: 'model-saved', reasoningEffort: ReasoningEffort.Low },
  });
  queueLoad(harness, 'provider-pending', provider);
  const pending = {
    modelId: 'model-pending',
    reasoningEffort: ReasoningEffort.High,
  };
  harness.setProjection(pending);
  await harness.lifecycle.resume('app-pending');
  assert.equal(harness.registry.getCanonicalSummary('app-pending')?.modelId, 'model-saved');
  assert.equal(harness.registry.resolveSummary('app-pending')?.modelId, 'model-pending');
  assert.equal(harness.registry.listSummaries()[0]?.reasoningEffort, ReasoningEffort.High);
  assert.equal(harness.history.persisted.at(-1)?.modelId, 'model-saved');
  assert.equal(
    harness.events.find((event) => event.type === 'session.created')?.session.modelId,
    'model-pending',
  );
  const replaced = harness.registry.replaceProvider('app-pending', 'provider-next');
  assert.equal(replaced?.modelId, 'model-saved');
  assert.equal(harness.history.persisted.at(-1)?.modelId, 'model-saved');
  harness.setPendingApply(async (appSessionId) => {
    await provider.updateSettings(pending);
    harness.registry.updateSummary(appSessionId, pending);
    return true;
  });
  await harness.lifecycle.send('app-pending', 'apply now');
  assert.deepEqual(provider.settings, [pending]);
  assert.deepEqual(provider.prompts, ['apply now']);
  assert.equal(harness.registry.getCanonicalSummary('app-pending')?.modelId, 'model-pending');
  assert.equal(harness.history.persisted.at(-1)?.reasoningEffort, ReasoningEffort.High);
});
