import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReasoningEffort,
  type AskUserResult,
  type RequestPermissionHandlerResult,
} from '@factory/droid-sdk';
import type { HistoricalSession } from './history.js';
import type { FactoryDefaultSettings, ServerEvent, SessionSummary } from './protocol.js';
import { SessionLifecycle, type LiveSession } from './SessionLifecycle.js';
import { SessionRegistry } from './SessionRegistry.js';
import {
  FakeFactoryRuntime,
  FakeFactorySession,
  type RecordedCall,
} from './testing/fakeFactoryRuntime.js';

interface MembershipObservation {
  stage: string;
  registered: boolean;
}

class RejectingInterruptSession extends FakeFactorySession {
  override async interrupt(): Promise<void> {
    await super.interrupt();
    throw new Error('interrupt rejected');
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
    modelId: 'model-saved',
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

function createHarness(ordinarySummaries: SessionSummary[]) {
  const calls: RecordedCall[] = [];
  const events: ServerEvent[] = [];
  const membership: MembershipObservation[] = [];
  const persisted: SessionSummary[] = [];
  const runtime = new FakeFactoryRuntime(calls);
  let projection: Partial<SessionSummary> = {};
  let applyPending: (appSessionId: string) => Promise<boolean> = () => Promise.resolve(true);
  let resourceSequence = 0;

  const observe = (stage: string, id: string): void => {
    membership.push({ stage, registered: registry.getLive(id) !== undefined });
  };
  const history = {
    syncSummaries(summaries: SessionSummary[]): void {
      persisted.push(...summaries.map((item) => ({ ...item })));
      for (const item of summaries) observe('history.sync', item.appSessionId);
      calls.push({ target: 'history', method: 'syncSummaries', args: summaries });
    },
    summaryPatches: () => new Map<string, Partial<SessionSummary>>(),
    hiddenProviderSessionIds: () => new Set<string>(),
  };
  const historical = (): HistoricalSession[] =>
    ordinarySummaries.map((item) => ({ summary: { ...item }, progress: [] }));
  const emit = (event: ServerEvent): void => {
    events.push(event);
    calls.push({ target: 'protocol', method: event.type, args: [event] });
    if (event.type === 'session.created' || event.type === 'session.updated') {
      observe(`publish.${event.type}`, event.session.appSessionId);
    }
  };

  const registry = new SessionRegistry<LiveSession>({
    history,
    loadOrdinarySessions: historical,
    loadMissionControlSessions: () => [],
    projectSummary: (item) => ({ ...item, ...projection }),
    onSummaryUpdated: (session) => emit({ type: 'session.updated', session }),
    now: () => 10_000,
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
    startLocalMcpServers: (ref) => {
      const resourceId = ++resourceSequence;
      calls.push({ target: 'runtime', method: 'mcp.start', args: [ref.id, resourceId] });
      return Promise.resolve({
        servers: [
          {
            close: () => {
              observe(`mcp.close.${String(resourceId)}`, ref.id);
              calls.push({
                target: 'cleanup',
                method: 'mcp.close',
                args: [ref.id, resourceId],
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
    compactionLimit: () => Promise.resolve(800),
    enableDaemonAutoCompaction: (session) => {
      calls.push({
        target: 'provider',
        method: 'autoCompaction.arm',
        args: [session.sessionId],
      });
      return Promise.resolve(true);
    },
    subscribeSessionCompaction: (live) => {
      const unsubscribe = live.session.onNotification(() => undefined);
      live.unsubscribe = () => {
        observe('notification.unsubscribe', live.summary.appSessionId);
        unsubscribe();
      };
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
    onTurnSettledWhileAutoCompacting: () => undefined,
    stopContextPolling: (sourceSessionId) => {
      observe('poll.stop', sourceSessionId);
      calls.push({ target: 'cleanup', method: 'poll.stop', args: [sourceSessionId] });
    },
    clearAutoCompactionWatchdog: (sessionId) => {
      observe('watchdog.clear', sessionId);
      calls.push({ target: 'cleanup', method: 'watchdog.clear', args: [sessionId] });
    },
    clearSessionRuntimeCaches: (live) => {
      observe('runtimeCaches.clear', live.summary.appSessionId);
      calls.push({
        target: 'cleanup',
        method: 'runtimeCaches.clear',
        args: [live.summary.appSessionId],
      });
    },
    closeBrowserSession: (appSessionId) => {
      observe('browser.close', appSessionId);
      calls.push({ target: 'browser', method: 'browser.close', args: [appSessionId] });
      return Promise.resolve();
    },
    emit,
    emitError: (error) => emit({ type: 'error', ...error }),
    emitStatus: (appSessionId, text) => {
      calls.push({ target: 'protocol', method: 'status', args: [appSessionId, text] });
    },
    emitSessionList: () => {
      membership.push({
        stage: 'publish.sessions.list',
        registered: registry.liveSessionsSnapshot().length > 0,
      });
      emit({ type: 'sessions.list', sessions: registry.listSummaries() });
    },
  });

  return {
    calls,
    events,
    membership,
    persisted,
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

test('interrupt rejection preserves auto-compaction ownership and watchdog state', async () => {
  const harness = createHarness([summary('app-interrupt', 'provider-interrupt')]);
  const provider = new RejectingInterruptSession('provider-interrupt', {}, harness.calls);
  queueLoad(harness, 'provider-interrupt', provider);
  await harness.lifecycle.resume('app-interrupt');
  const live = requireLive(harness, 'app-interrupt');
  live.autoCompacting = true;
  harness.calls.length = 0;

  await assert.rejects(harness.lifecycle.interrupt('app-interrupt'), /interrupt rejected/);

  assert.equal(live.autoCompacting, true);
  assert.equal(
    harness.calls.some((call) => call.method === 'watchdog.clear'),
    false,
  );
  assert.deepEqual(
    harness.calls.filter((call) => call.method === 'interrupt').map((call) => call.args[0]),
    ['provider-interrupt'],
  );
});

test('pending settings apply before the first stream and become canonical only on success', async () => {
  const harness = createHarness([summary('app-settings', 'provider-settings')]);
  const provider = new FakeFactorySession('provider-settings', {}, harness.calls, {
    settings: { modelId: 'model-saved', reasoningEffort: ReasoningEffort.Low },
  });
  queueLoad(harness, 'provider-settings', provider);
  const pending = {
    modelId: 'model-pending',
    reasoningEffort: ReasoningEffort.High,
  };
  harness.setProjection(pending);
  await harness.lifecycle.resume('app-settings');
  assert.equal(harness.registry.getCanonicalSummary('app-settings')?.modelId, 'model-saved');

  harness.calls.length = 0;
  harness.setPendingApply(async (appSessionId) => {
    harness.calls.push({ target: 'provider', method: 'settings.apply', args: [appSessionId] });
    await provider.updateSettings(pending);
    harness.registry.updateSummary(appSessionId, pending);
    return true;
  });
  await harness.lifecycle.send('app-settings', 'first prompt');

  const methods = harness.calls.map((call) => call.method);
  assert.ok(methods.indexOf('settings.apply') < methods.indexOf('updateSettings'));
  assert.ok(methods.indexOf('updateSettings') < methods.indexOf('stream'));
  assert.deepEqual(provider.prompts, ['first prompt']);
  assert.equal(harness.registry.getCanonicalSummary('app-settings')?.modelId, 'model-pending');
  assert.equal(harness.persisted.at(-1)?.reasoningEffort, ReasoningEffort.High);
});

test('failed pending-settings application prevents the prompt and preserves projection locality', async () => {
  const harness = createHarness([summary('app-failed-settings', 'provider-failed-settings')]);
  const provider = new FakeFactorySession('provider-failed-settings', {}, harness.calls, {
    settings: { modelId: 'model-saved', reasoningEffort: ReasoningEffort.Low },
  });
  queueLoad(harness, 'provider-failed-settings', provider);
  harness.setProjection({
    modelId: 'model-pending',
    reasoningEffort: ReasoningEffort.High,
  });
  await harness.lifecycle.resume('app-failed-settings');
  harness.setPendingApply(() => Promise.resolve(false));

  await harness.lifecycle.send('app-failed-settings', 'must not send');

  assert.deepEqual(provider.prompts, []);
  assert.equal(harness.registry.getCanonicalSummary('app-failed-settings')?.modelId, 'model-saved');
  assert.equal(harness.registry.resolveSummary('app-failed-settings')?.modelId, 'model-pending');
  assert.equal(harness.persisted.at(-1)?.modelId, 'model-saved');
});

test('cold resume registers before publication and live resume allocates no resources', async () => {
  const harness = createHarness([summary('app-resume', 'provider-resume')]);
  queueLoad(harness, 'provider-resume');

  await harness.lifecycle.resume('app-resume');

  const coldMethods = harness.calls.map((call) => call.method);
  assert.deepEqual(
    coldMethods.filter((method) =>
      [
        'mcp.start',
        'loadSession',
        'autoCompaction.arm',
        'onNotification',
        'syncSummaries',
        'session.created',
        'session.updated',
        'context.refresh',
      ].includes(method),
    ),
    [
      'mcp.start',
      'loadSession',
      'autoCompaction.arm',
      'onNotification',
      'syncSummaries',
      'session.created',
      'session.updated',
      'context.refresh',
    ],
  );
  assert.deepEqual(
    harness.membership.filter((item) => item.stage === 'history.sync'),
    [{ stage: 'history.sync', registered: true }],
  );
  assert.deepEqual(
    harness.membership.filter((item) => item.stage.startsWith('publish.session')),
    [
      { stage: 'publish.session.created', registered: true },
      { stage: 'publish.session.updated', registered: true },
    ],
  );

  harness.calls.length = 0;
  harness.events.length = 0;
  const loadCount = harness.runtime.loadCalls.length;
  await harness.lifecycle.resume('app-resume');

  assert.equal(harness.runtime.loadCalls.length, loadCount);
  assert.deepEqual(
    harness.calls.map((call) => call.method),
    ['ensureConnected', 'session.created', 'context.refresh'],
  );
  assert.deepEqual(
    harness.events.map((event) => event.type),
    ['session.created'],
  );
});

test('close keeps registration through cleanup and publishes the list after unregistering', async () => {
  const harness = createHarness([summary('app-close', 'provider-close')]);
  const provider = new CallbackCloseSession('provider-close', harness.calls, () => {
    harness.membership.push({
      stage: 'provider.close',
      registered: harness.registry.getLive('app-close') !== undefined,
    });
    return Promise.resolve();
  });
  queueLoad(harness, 'provider-close', provider);
  await harness.lifecycle.resume('app-close');
  harness.membership.length = 0;
  harness.events.length = 0;

  await harness.lifecycle.close('app-close');

  const cleanupObservations = harness.membership.filter(
    (item) => item.stage !== 'publish.sessions.list',
  );
  assert.ok(cleanupObservations.length > 0);
  assert.equal(
    cleanupObservations.every((item) => item.registered),
    true,
  );
  assert.deepEqual(harness.membership.at(-1), {
    stage: 'publish.sessions.list',
    registered: false,
  });
  const listEvent = harness.events.find((event) => event.type === 'sessions.list');
  assert.deepEqual(listEvent?.sessions, [summary('app-close', 'provider-close')]);
  assert.equal(harness.registry.getLive('app-close'), undefined);
});

test('closeAll closes its initial snapshot and leaves a session registered during cleanup', async () => {
  const harness = createHarness([
    summary('app-first', 'provider-first'),
    summary('app-second', 'provider-second'),
    summary('app-late', 'provider-late'),
  ]);
  let resumeLate = (): Promise<void> => Promise.resolve();
  const first = new CallbackCloseSession('provider-first', harness.calls, () => resumeLate());
  queueLoad(harness, 'provider-first', first);
  queueLoad(harness, 'provider-second');
  queueLoad(harness, 'provider-late');
  await harness.lifecycle.resume('app-first');
  await harness.lifecycle.resume('app-second');
  resumeLate = () => harness.lifecycle.resume('app-late');
  harness.calls.length = 0;

  await harness.lifecycle.closeAll();

  assert.deepEqual(
    harness.calls.filter((call) => call.method === 'session.close').map((call) => call.args[0]),
    ['provider-first', 'provider-second'],
  );
  assert.equal(harness.registry.getLive('app-first'), undefined);
  assert.equal(harness.registry.getLive('app-second'), undefined);
  assert.ok(harness.registry.getLive('app-late'));
});
