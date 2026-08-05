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
  nextSyncError?: Error;
  constructor(private readonly calls: RecordedCall[]) {}
  syncSummaries(summaries: SessionSummary[]): void {
    const error = this.nextSyncError;
    delete this.nextSyncError;
    if (error) throw error;
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

class CallbackCloseSession extends FakeFactorySession {
  constructor(
    sessionId: string,
    calls: RecordedCall[],
    private readonly afterClose: () => Promise<void>,
  ) {
    super(sessionId, {}, calls);
  }

  override async close(): Promise<void> {
    await super.close();
    await this.afterClose();
  }
}

class RejectingCloseSession extends FakeFactorySession {
  override async close(): Promise<void> {
    await super.close();
    throw new Error(`close failed: ${this.sessionId}`);
  }
}

function createHarness(ordinarySummaries: SessionSummary[] = []) {
  const calls: RecordedCall[] = [];
  const events: ServerEvent[] = [];
  const publicationRegistration: boolean[] = [];
  const forgettingAfterUnregister: boolean[] = [];
  const eventFlowForgettingAfterUnregister: boolean[] = [];
  const missionForgettingAfterUnregister: boolean[] = [];
  const history = new TestHistory(calls);
  const runtime = new FakeFactoryRuntime(calls);
  let projection: Partial<SessionSummary> = {};
  let applyPending: (appSessionId: string) => Promise<boolean> = () => Promise.resolve(true);
  let enableAutoCompaction = (): Promise<boolean> => Promise.resolve(true);
  let compactionLimit = (): Promise<number> => Promise.resolve(800);
  let shutdownStarted = false;
  let closeChildren: (appSessionId: string) => Promise<void> = () => Promise.resolve();
  let nextEmitFailure: { type: ServerEvent['type']; error: Error } | undefined;
  let now = 10_000;
  let mcpId = 0;
  const historical = (): HistoricalSession[] =>
    ordinarySummaries.map((item) => ({ summary: { ...item }, progress: [] }));
  const recordEvent = (event: ServerEvent): void => {
    if (nextEmitFailure?.type === event.type) {
      const error = nextEmitFailure.error;
      nextEmitFailure = undefined;
      throw error;
    }
    events.push(event);
    calls.push({ target: 'protocol', method: event.type, args: [event] });
    if (event.type === 'session.created' || event.type === 'session.updated') {
      publicationRegistration.push(registry.getLive(event.session.appSessionId) !== undefined);
    }
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
    childSessions: {
      attachParent: (appSessionId) => {
        calls.push({ target: 'cleanup', method: 'children.attach', args: [appSessionId] });
      },
      closeParent: (appSessionId) => closeChildren(appSessionId),
    },
    startLocalMcpServers: () => {
      const resourceId = ++mcpId;
      calls.push({ target: 'runtime', method: 'mcp.start', args: [resourceId] });
      return Promise.resolve({
        servers: [
          {
            close: () => {
              calls.push({
                target: 'cleanup',
                method: 'mcp.close',
                args: [`mcp-${resourceId}`],
              });
              return Promise.resolve();
            },
          },
        ],
        configs: [],
      });
    },
    makePermissionHandler: () => () => new Promise<RequestPermissionHandlerResult>(() => undefined),
    makeAskUserHandler: () => () => new Promise<AskUserResult>(() => undefined),
    compaction: {
      resolveLimit: () => compactionLimit(),
      arm: async (target, limit) => {
        if (!target.isCurrent()) return false;
        calls.push({
          target: 'provider',
          method: 'autoCompaction.arm',
          args: [target.session.sessionId, limit],
        });
        const armed = await enableAutoCompaction();
        return target.isCurrent() && armed;
      },
      subscribePrimary: (target) => {
        target.liveSession.unsubscribe = target.session.onNotification(() => undefined);
      },
      afterTurn: (target) => {
        calls.push({
          target: 'cleanup',
          method: 'autoCompaction.settled',
          args: [target.appSessionId],
        });
      },
      cancel: (target) => {
        if (target.kind === 'primary') target.liveSession.autoCompacting = false;
        else target.setAutoCompacting(false);
        calls.push({
          target: 'cleanup',
          method: 'watchdog.clear',
          args: [target.kind === 'primary' ? target.appSessionId : target.childSessionId],
        });
      },
      forgetSession: (appSessionId) => {
        calls.push({
          target: 'cleanup',
          method: 'compaction.forgetSession',
          args: [appSessionId],
        });
      },
    },
    isShutdownStarted: () => shutdownStarted,
    applyPendingSettingsToSummary: (item) => ({ ...item, ...projection }),
    applyPendingSessionSettings: (appSessionId) => applyPending(appSessionId),
    runPrimaryTurn: async (live, prompt) => {
      for await (const event of live.session.stream(prompt, { includePartialMessages: true })) {
        void event;
      }
    },
    context: {
      refresh: (target) => {
        calls.push({
          target: 'provider',
          method: 'context.refresh',
          args: [target.sourceSessionId],
        });
        return Promise.resolve();
      },
      stopPolling: (sourceSessionId) => {
        calls.push({ target: 'cleanup', method: 'poll.stop', args: [sourceSessionId] });
      },
      stopSession: (live) => {
        calls.push({
          target: 'cleanup',
          method: 'poll.stop',
          args: [live.summary.appSessionId],
        });
        if (live.summary.providerSessionId)
          calls.push({
            target: 'cleanup',
            method: 'poll.stop',
            args: [live.summary.providerSessionId],
          });
      },
      forgetSession: (live) => {
        calls.push({
          target: 'cleanup',
          method: 'runtimeCaches.clear',
          args: [live.summary.appSessionId],
        });
      },
    },
    forgetInteractions: (appSessionId) => {
      forgettingAfterUnregister.push(registry.getLive(appSessionId) === undefined);
      calls.push({ target: 'cleanup', method: 'interactions.forget', args: [appSessionId] });
    },
    forgetEventFlow: (appSessionId) => {
      eventFlowForgettingAfterUnregister.push(registry.getLive(appSessionId) === undefined);
      calls.push({ target: 'cleanup', method: 'eventFlow.forget', args: [appSessionId] });
    },
    forgetMissionControl: (appSessionId) => {
      missionForgettingAfterUnregister.push(registry.getLive(appSessionId) === undefined);
      calls.push({ target: 'cleanup', method: 'missionControl.forget', args: [appSessionId] });
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
    publicationRegistration,
    forgettingAfterUnregister,
    eventFlowForgettingAfterUnregister,
    missionForgettingAfterUnregister,
    setProjection: (patch: Partial<SessionSummary>) => {
      projection = { ...patch };
    },
    setPendingApply: (action: (appSessionId: string) => Promise<boolean>) => {
      applyPending = action;
    },
    setEnableAutoCompaction: (action: () => Promise<boolean>) => {
      enableAutoCompaction = action;
    },
    setCompactionLimit: (action: () => Promise<number>) => {
      compactionLimit = action;
    },
    setShutdownStarted: (started: boolean) => {
      shutdownStarted = started;
    },
    setChildCloser: (action: (appSessionId: string) => Promise<void>) => {
      closeChildren = action;
    },
    failNextEmit: (type: ServerEvent['type'], error: Error) => {
      nextEmitFailure = { type, error };
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
  assert.equal(created.publicationRegistration.every(Boolean), true);
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
  assert.equal(resumed.publicationRegistration.every(Boolean), true);
});

test('create omits an unarmed daemon compaction limit from its summary', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'unarmed-create');
  harness.setEnableAutoCompaction(() => Promise.resolve(false));

  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);

  const created = harness.events.find(
    (event) => event.type === 'session.created' && event.session.appSessionId === 'unarmed-create',
  );
  assert.equal(created?.type, 'session.created');
  assert.equal(created.session.compactionTokenLimit, undefined);
  assert.equal(
    harness.registry.getCanonicalSummary('unarmed-create')?.compactionTokenLimit,
    undefined,
  );
  assert.equal(
    harness.calls.some(
      (call) =>
        call.method === 'autoCompaction.arm' &&
        call.args[0] === 'unarmed-create' &&
        call.args[1] === 800,
    ),
    true,
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

test('post-open create and resume failures close provider and MCP resources', async () => {
  const created = createHarness();
  queueCreate(created, 'failed-create');
  created.setEnableAutoCompaction(() => Promise.reject(new Error('create setup failed')));
  await created.lifecycle.create(createCommand());
  assert.deepEqual(
    created.calls
      .filter((call) => call.method === 'mcp.close' || call.method === 'session.close')
      .map((call) => [call.method, call.args[0]]),
    [
      ['mcp.close', 'mcp-1'],
      ['session.close', 'failed-create'],
    ],
  );
  assert.equal(created.registry.getLive('failed-create'), undefined);

  const resumed = createHarness([summary('failed-resume-app', 'failed-resume-provider')]);
  queueLoad(resumed, 'failed-resume-provider');
  resumed.setEnableAutoCompaction(() => Promise.reject(new Error('resume setup failed')));
  await resumed.lifecycle.resume('failed-resume-app');
  assert.deepEqual(
    resumed.calls
      .filter((call) => call.method === 'mcp.close' || call.method === 'session.close')
      .map((call) => [call.method, call.args[0]]),
    [
      ['mcp.close', 'mcp-1'],
      ['session.close', 'failed-resume-provider'],
    ],
  );
  assert.equal(resumed.registry.getLive('failed-resume-app'), undefined);
});

test('registration failure closes resources without indexing the failed session', async () => {
  const harness = createHarness();
  queueCreate(harness, 'failed-registration');
  harness.history.nextSyncError = new Error('persist failed');

  await harness.lifecycle.create(createCommand());

  assert.deepEqual(
    harness.calls
      .filter((call) => call.method === 'mcp.close' || call.method === 'session.close')
      .map((call) => [call.method, call.args[0]]),
    [
      ['mcp.close', 'mcp-1'],
      ['session.close', 'failed-registration'],
    ],
  );
  assert.equal(harness.registry.getLive('failed-registration'), undefined);
  assert.equal(
    harness.events.some((event) => event.type === 'error' && event.message === 'persist failed'),
    true,
  );
});

test('post-registration publication failures unregister and close opened resources', async () => {
  const created = createHarness();
  queueCreate(created, 'failed-create-publication');
  created.failNextEmit('session.created', new Error('create publication failed'));

  await created.lifecycle.create(createCommand());

  assert.equal(created.registry.getLive('failed-create-publication'), undefined);
  assert.deepEqual(
    created.calls
      .filter((call) => ['unsubscribe', 'mcp.close', 'session.close'].includes(call.method))
      .map((call) => [call.method, call.args[0]]),
    [
      ['unsubscribe', 'failed-create-publication'],
      ['mcp.close', 'mcp-1'],
      ['session.close', 'failed-create-publication'],
    ],
  );
  assert.equal(
    created.events.some(
      (event) => event.type === 'error' && event.message === 'create publication failed',
    ),
    true,
  );

  const resumed = createHarness([
    summary('failed-resume-publication-app', 'failed-resume-publication-provider'),
  ]);
  queueLoad(resumed, 'failed-resume-publication-provider');
  resumed.failNextEmit('session.created', new Error('resume publication failed'));

  await resumed.lifecycle.resume('failed-resume-publication-app');

  assert.equal(resumed.registry.getLive('failed-resume-publication-app'), undefined);
  assert.deepEqual(
    resumed.calls
      .filter((call) => ['unsubscribe', 'mcp.close', 'session.close'].includes(call.method))
      .map((call) => [call.method, call.args[0]]),
    [
      ['unsubscribe', 'failed-resume-publication-provider'],
      ['mcp.close', 'mcp-1'],
      ['session.close', 'failed-resume-publication-provider'],
    ],
  );
  assert.equal(
    resumed.events.some(
      (event) => event.type === 'error' && event.message === 'resume publication failed',
    ),
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

test('an eager resume and immediate send share one provider load', async () => {
  const harness = createHarness([summary('warm-app', 'warm-provider')]);
  const provider = queueLoad(harness, 'warm-provider');
  let releaseLimit: (limit: number) => void = () => undefined;
  harness.setCompactionLimit(
    () =>
      new Promise<number>((resolve) => {
        releaseLimit = resolve;
      }),
  );

  const warming = harness.lifecycle.resume('warm-app');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const sending = harness.lifecycle.send('warm-app', 'send while warming');

  assert.equal(harness.runtime.loadCalls.length, 1);
  releaseLimit(800);
  assert.equal(await warming, true);
  await sending;
  assert.deepEqual(provider.prompts, ['send while warming']);
  assert.equal(harness.runtime.loadCalls.length, 1);
});

test('failed lazy resume emits only the original load error', async () => {
  const harness = createHarness([summary('lazy-failure-app', 'lazy-failure-provider')]);
  harness.runtime.loadQueue.set('lazy-failure-provider', [new Error('provider load failed')]);

  await harness.lifecycle.send('lazy-failure-app', 'not delivered');

  assert.deepEqual(
    harness.events
      .filter((event): event is Extract<ServerEvent, { type: 'error' }> => event.type === 'error')
      .map((event) => event.message),
    ['provider load failed'],
  );
});

test('failed turn setup clears streaming so the next send can run', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'setup-recovery');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  harness.history.nextSyncError = new Error('persist failed');

  await assert.rejects(harness.lifecycle.send('setup-recovery', 'failed setup'), /persist failed/);

  assert.equal(requireLive(harness, 'setup-recovery').streaming, false);
  await harness.lifecycle.send('setup-recovery', 'recovered');
  assert.deepEqual(provider.prompts, ['first', 'recovered']);
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

  const rejected = createHarness();
  const rejectingProvider = new RejectingInterruptSession('rejected-stop', {}, rejected.calls);
  rejected.runtime.createQueue.push(rejectingProvider);
  await rejected.lifecycle.create(createCommand());
  await rejectingProvider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rejectedLive = requireLive(rejected, 'rejected-stop');
  rejectedLive.autoCompacting = true;
  await assert.rejects(rejected.lifecycle.interrupt('rejected-stop'), /interrupt rejected/);
  assert.equal(rejectedLive.interrupting, false);
  assert.equal(rejectedLive.autoCompacting, true);
  assert.equal(
    rejected.calls.some(
      (call) => call.method === 'watchdog.clear' && call.args[0] === 'rejected-stop',
    ),
    false,
  );

  const aliased = createHarness([summary('stable-stop', 'provider-stop')]);
  queueLoad(aliased, 'provider-stop');
  await aliased.lifecycle.resume('stable-stop');
  const aliasedLive = requireLive(aliased, 'provider-stop');
  aliasedLive.autoCompacting = true;
  aliased.calls.length = 0;
  await aliased.lifecycle.interrupt('provider-stop');
  assert.equal(
    aliased.calls.some(
      (call) => call.method === 'watchdog.clear' && call.args[0] === 'stable-stop',
    ),
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
  assert.deepEqual(
    harness.calls
      .filter((call) =>
        [
          'mcp.start',
          'loadSession',
          'autoCompaction.arm',
          'onNotification',
          'syncSummaries',
        ].includes(call.method),
      )
      .map((call) => call.method),
    [],
  );
});

test('create and resume abandon in-flight opens when shutdown admission closes', async () => {
  const creating = createHarness();
  let releaseCreateLimit: (limit: number) => void = () => undefined;
  creating.setCompactionLimit(
    () =>
      new Promise<number>((resolve) => {
        releaseCreateLimit = resolve;
      }),
  );
  const create = creating.lifecycle.create(createCommand());
  await new Promise<void>((resolve) => setImmediate(resolve));
  creating.setShutdownStarted(true);
  releaseCreateLimit(800);
  await create;
  assert.equal(creating.runtime.createCalls.length, 0);
  assert.equal(creating.registry.liveSessionsSnapshot().length, 0);
  assert.equal(creating.calls.filter((call) => call.method === 'autoCompaction.arm').length, 0);
  assert.equal(
    creating.events.some((event) => event.type === 'error'),
    false,
  );

  const historical = summary('resume-stable', 'resume-provider');
  const resuming = createHarness([historical]);
  const provider = queueLoad(resuming, 'resume-provider');
  let releaseResumeLimit: (limit: number) => void = () => undefined;
  resuming.setCompactionLimit(
    () =>
      new Promise<number>((resolve) => {
        releaseResumeLimit = resolve;
      }),
  );
  const resume = resuming.lifecycle.resume('resume-stable');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resuming.runtime.loadCalls.length, 1);
  resuming.setShutdownStarted(true);
  releaseResumeLimit(800);
  assert.equal(await resume, false);
  assert.equal(resuming.registry.liveSessionsSnapshot().length, 0);
  assert.equal(resuming.calls.filter((call) => call.method === 'autoCompaction.arm').length, 0);
  assert.equal(
    resuming.calls.filter(
      (call) => call.method === 'session.close' && call.args[0] === provider.sessionId,
    ).length,
    1,
  );
  assert.equal(
    resuming.events.some((event) => event.type === 'error'),
    false,
  );
});

test('close follows ownership order and closeAll closes its initial snapshot', async () => {
  const harness = createHarness();
  const provider = new CallbackCloseSession('owner', harness.calls, () => {
    assert.ok(harness.registry.getLive('owner'));
    return Promise.resolve();
  });
  harness.runtime.createQueue.push(provider);
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  requireLive(harness, 'owner');
  const child = new FakeFactorySession('child', {}, harness.calls);
  const unsubscribeChild = child.onNotification(() => undefined);
  harness.setChildCloser(async () => {
    unsubscribeChild();
    await child.close();
  });
  harness.calls.length = 0;
  await harness.lifecycle.close('owner');
  const closeTrace = harness.calls
    .filter((call) =>
      [
        'unsubscribe',
        'session.close',
        'mcp.close',
        'browser.close',
        'compaction.forgetSession',
        'runtimeCaches.clear',
      ].includes(call.method),
    )
    .map((call) => `${call.method}:${String(call.args[0] ?? '')}`);
  assert.deepEqual(closeTrace, [
    'unsubscribe:child',
    'session.close:child',
    'compaction.forgetSession:owner',
    'unsubscribe:owner',
    'mcp.close:mcp-1',
    'session.close:owner',
    'browser.close:owner',
    'runtimeCaches.clear:owner',
  ]);
  assert.deepEqual(harness.forgettingAfterUnregister, [true]);
  assert.deepEqual(harness.eventFlowForgettingAfterUnregister, [true]);
  assert.deepEqual(harness.missionForgettingAfterUnregister, [true]);
  assert.equal(harness.registry.getLive('owner'), undefined);
  assert.ok(
    harness.calls.findIndex((call) => call.method === 'missionControl.forget') <
      harness.calls.findIndex((call) => call.method === 'session.closed'),
  );
  const ownerList = harness.events.findLast((event) => event.type === 'sessions.list');
  assert.equal(
    ownerList?.sessions.some((session) => session.appSessionId === 'owner'),
    false,
  );

  const all = createHarness();
  let registerLate = (): Promise<void> => Promise.resolve();
  const first = new CallbackCloseSession('first', all.calls, () => registerLate());
  all.runtime.createQueue.push(first);
  const second = queueCreate(all, 'second');
  await all.lifecycle.create(createCommand());
  await first.waitForPrompts(1);
  await all.lifecycle.create(createCommand());
  await second.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  registerLate = async () => {
    const late = queueCreate(all, 'late');
    await all.lifecycle.create(createCommand());
    await late.waitForPrompts(1);
  };
  await all.lifecycle.closeAll();
  assert.deepEqual(
    all.calls.filter((call) => call.method === 'session.close').map((call) => call.args[0]),
    ['first', 'second'],
  );
  assert.deepEqual(
    all.registry.liveSessionsSnapshot().map((session) => session.summary.appSessionId),
    ['late'],
  );
  await all.lifecycle.closeAll();
  assert.equal(all.registry.liveSessionsSnapshot().length, 0);
});

test('closeAll marks its full snapshot before sequential cleanup', async () => {
  const harness = createHarness();
  let releaseFirst = (): void => undefined;
  const first = new CallbackCloseSession(
    'first-marked',
    harness.calls,
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
  );
  const second = new FakeFactorySession('second-marked', {}, harness.calls);
  harness.runtime.createQueue.push(first, second);
  await harness.lifecycle.create(createCommand());
  await first.waitForPrompts(1);
  await harness.lifecycle.create(createCommand());
  await second.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const closingAll = harness.lifecycle.closeAll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const firstLive = harness.registry.getLive('first-marked');
  const secondLive = harness.registry.getLive('second-marked');
  assert.equal(firstLive?.closeMode, 'discard-pending');
  assert.equal(secondLive?.closeMode, 'discard-pending');
  assert.ok(secondLive?.closePromise);

  let directSecondSettled = false;
  const directSecond = harness.lifecycle.close('second-marked').then(() => {
    directSecondSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(directSecondSettled, false);
  assert.equal(
    harness.calls.some(
      (call) => call.method === 'session.close' && call.args[0] === 'second-marked',
    ),
    false,
  );

  releaseFirst();
  await Promise.all([closingAll, directSecond]);
  assert.deepEqual(
    harness.calls.filter((call) => call.method === 'session.close').map((call) => call.args[0]),
    ['first-marked', 'second-marked'],
  );
});

test('closeAll records a cleanup failure and still closes later sessions', async () => {
  const harness = createHarness();
  const first = new RejectingCloseSession('first-rejecting', {}, harness.calls);
  const second = new FakeFactorySession('second-after-rejection', {}, harness.calls);
  harness.runtime.createQueue.push(first, second);
  await harness.lifecycle.create(createCommand());
  await first.waitForPrompts(1);
  await harness.lifecycle.create(createCommand());
  await second.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));

  await assert.rejects(harness.lifecycle.closeAll(), /close failed: first-rejecting/);
  assert.deepEqual(
    harness.calls.filter((call) => call.method === 'session.close').map((call) => call.args[0]),
    ['first-rejecting', 'second-after-rejection'],
  );
  assert.equal(harness.registry.liveSessionsSnapshot().length, 0);
});

test('closing an active session discards queued sends without reopening it', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'closing');
  const gate = provider.deferNextStream();
  await harness.lifecycle.create(createCommand('active'));
  await provider.waitForPrompts(1);
  await harness.lifecycle.send('closing', 'queued');
  const live = requireLive(harness, 'closing');

  await harness.lifecycle.close('closing');
  gate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(provider.prompts, ['active']);
  assert.deepEqual(live.pendingSends, []);
  assert.equal(harness.runtime.loadCalls.length, 0);
  assert.equal(harness.registry.getLive('closing'), undefined);
});

test('concurrent close waits for cleanup and discard overrides queue preservation', async () => {
  const harness = createHarness();
  let finishProviderClose: () => void = () => undefined;
  const provider = new CallbackCloseSession(
    'concurrent-close',
    harness.calls,
    () =>
      new Promise<void>((resolve) => {
        finishProviderClose = resolve;
      }),
  );
  harness.runtime.createQueue.push(provider);
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const live = requireLive(harness, 'concurrent-close');
  live.pendingSends = ['preserve unless user closes'];

  const preserving = harness.lifecycle.close('concurrent-close', 'preserve-pending');
  await new Promise<void>((resolve) => setImmediate(resolve));
  let discardSettled = false;
  const discarding = harness.lifecycle.close('concurrent-close').then(() => {
    discardSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(discardSettled, false);
  assert.equal(live.closeMode, 'discard-pending');
  assert.deepEqual(live.pendingSends, []);
  finishProviderClose();
  await Promise.all([preserving, discarding]);
  assert.equal(harness.registry.getLive('concurrent-close'), undefined);
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
  const settingsCall = harness.calls.findIndex((call) => call.method === 'updateSettings');
  const streamCall = harness.calls.findIndex(
    (call) => call.method === 'stream' && call.args[1] === 'apply now',
  );
  assert.ok(settingsCall >= 0 && settingsCall < streamCall);
  assert.equal(harness.registry.getCanonicalSummary('app-pending')?.modelId, 'model-pending');
  assert.equal(harness.history.persisted.at(-1)?.reasoningEffort, ReasoningEffort.High);

  const failed = createHarness([saved]);
  const failedProvider = new FakeFactorySession('provider-pending', {}, failed.calls, {
    settings: { modelId: 'model-saved', reasoningEffort: ReasoningEffort.Low },
  });
  queueLoad(failed, 'provider-pending', failedProvider);
  failed.setProjection(pending);
  await failed.lifecycle.resume('app-pending');
  failed.setPendingApply(() => Promise.resolve(false));
  await failed.lifecycle.send('app-pending', 'must not stream');
  assert.deepEqual(failedProvider.prompts, []);
  assert.equal(failed.registry.getCanonicalSummary('app-pending')?.modelId, 'model-saved');
  assert.equal(failed.registry.resolveSummary('app-pending')?.modelId, 'model-pending');
});
