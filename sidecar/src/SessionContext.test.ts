import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextStatsAccuracy, ReasoningEffort } from '@factory/droid-sdk';

import { DroidRuntime } from './DroidRuntime.js';
import type { ServerEvent, SessionSummary } from './protocol.js';
import {
  SessionContext,
  type ChildOperationTarget,
  type LiveOperationTarget,
} from './SessionContext.js';
import type { LiveChildSession, LiveSession } from './SessionLifecycle.js';
import { SessionRegistry } from './SessionRegistry.js';
import {
  FakeFactoryRuntime,
  FakeFactorySession,
  type RecordedCall,
} from './testing/fakeFactoryRuntime.js';
import { FakeHistoryIndex } from './testing/historyCharacterizationSupport.js';

interface Harness {
  calls: RecordedCall[];
  events: ServerEvent[];
  runtime: FakeFactoryRuntime;
  history: FakeHistoryIndex;
  registry: SessionRegistry<LiveSession>;
  context: SessionContext;
}

function createHarness(): Harness {
  const calls: RecordedCall[] = [];
  const events: ServerEvent[] = [];
  const runtime = new FakeFactoryRuntime(calls);
  const history = new FakeHistoryIndex(calls);
  const registry = new SessionRegistry<LiveSession>({
    history,
    loadOrdinarySessions: () => [],
    loadMissionControlSessions: () => [],
    projectSummary: (value) => ({ ...value }),
    onSummaryUpdated: (session) => {
      events.push({ type: 'session.updated', session });
    },
    now: () => 10,
  });
  const context = new SessionContext({
    registry,
    runtime,
    emit: (event) => events.push(event),
    maxContextTokensForSummary: (value) => value.maxContextTokens,
  });
  return { calls, events, runtime, history, registry, context };
}

function registerLive(
  h: Harness,
  appSessionId: string,
  providerSessionId = appSessionId,
): { live: LiveSession; session: FakeFactorySession } {
  const session = new FakeFactorySession(providerSessionId, {}, h.calls);
  const live: LiveSession = {
    summary: summary(appSessionId, providerSessionId),
    session,
    streaming: false,
    autoCompacting: false,
    pendingSends: [],
    childSessions: new Map(),
    knownChildSessions: new Set(),
    completedChildSessions: new Set(),
    linkedChildSessions: new Set(),
    childSessionToolUseIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
    mcpServers: [],
    mcpConfigs: [],
  };
  h.registry.register(live);
  return { live, session };
}

function addChild(
  h: Harness,
  parent: LiveSession,
  childSessionId: string,
  providerSessionId: string,
): {
  child: LiveChildSession;
  session: FakeFactorySession;
  target: ChildOperationTarget;
} {
  const session = new FakeFactorySession(providerSessionId, {}, h.calls);
  const child: LiveChildSession = {
    session,
    childSessionId,
    appSessionId: parent.summary.appSessionId,
    role: 'worker',
    lastUsedAt: 1,
    streaming: false,
    autoCompacting: false,
    pendingSends: [],
  };
  parent.childSessions.set(childSessionId, child);
  const target: ChildOperationTarget = {
    appSessionId: parent.summary.appSessionId,
    parentAppSessionId: parent.summary.appSessionId,
    childSessionId,
    providerSessionId,
    sourceSessionId: providerSessionId,
    session,
    role: 'worker',
    child,
    isCurrent: () =>
      !parent.closeMode &&
      h.registry.getLive(parent.summary.appSessionId) === parent &&
      parent.childSessions.get(childSessionId) === child &&
      child.session === session,
  };
  return { child, session, target };
}

function primaryTarget(h: Harness, live: LiveSession): LiveOperationTarget {
  const session = live.session;
  return {
    appSessionId: live.summary.appSessionId,
    providerSessionId: session.sessionId,
    sourceSessionId: live.summary.appSessionId,
    session,
    isCurrent: () =>
      !live.closeMode &&
      h.registry.getLive(live.summary.appSessionId) === live &&
      live.session === session,
  };
}

function contextEvents(h: Harness) {
  return h.events.filter((event) => event.type === 'context.updated');
}

test('primary refresh normalizes breakdown and persists estimated context', async () => {
  const h = createHarness();
  const { live, session } = registerLive(h, 'app-1', 'backend-1');
  session.nextContextStats = {
    used: 240,
    remaining: 760,
    limit: 1_000,
    accuracy: ContextStatsAccuracy.Estimated,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  h.runtime.contextBreakdowns.set('backend-1', {
    modelId: 'model-default',
    contextBudget: 1_000,
    categories: [
      { name: 'Messages', tokens: 200, colorKey: 'messages' },
      { name: 'Empty', tokens: 0 },
    ],
    freeTokens: 800,
  });

  await h.context.refresh(primaryTarget(h, live));

  const event = contextEvents(h).at(-1);
  assert.equal(event?.stats.used, 240);
  assert.equal(event?.stats.breakdown?.categories.length, 1);
  assert.equal(live.summary.contextTokens, 240);
  assert.equal(live.summary.contextRemainingTokens, 760);
  assert.equal(
    h.events.some((item) => item.type === 'session.updated'),
    true,
  );
});

test('exact primary usage wins while child usage changes totals only', async () => {
  const h = createHarness();
  const { live, session } = registerLive(h, 'app-1');
  live.summary.maxContextTokens = 1_000;
  h.context.recordUsage('app-1', 'app-1', {
    tokensIn: 10,
    tokensOut: 3,
    contextTokens: 1_200,
  });
  h.context.recordUsage('app-1', 'child-backend', {
    tokensIn: 20,
    tokensOut: 5,
    contextTokens: 900,
  });
  assert.equal(live.summary.tokensIn, 20);
  assert.equal(live.summary.tokensOut, 5);
  assert.equal(live.summary.contextTokens, 1_200);
  assert.equal(h.history.summaryPatches().get('app-1')?.tokensIn, 20);
  assert.equal(h.history.summaryPatches().get('app-1')?.contextTokens, 1_200);

  session.nextContextStats = {
    used: 100,
    remaining: 900,
    limit: 1_000,
    accuracy: ContextStatsAccuracy.Estimated,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await h.context.refresh(primaryTarget(h, live));

  const event = contextEvents(h).at(-1);
  assert.equal(event?.stats.used, 1_000);
  assert.equal(event?.stats.remaining, 0);
  assert.equal(event?.stats.accuracy, 'exact');
});

test('usage persistence failure keeps live telemetry and does not fail the turn', () => {
  const h = createHarness();
  const { live } = registerLive(h, 'app-1');
  h.history.nextSyncError = new Error('disk unavailable');

  assert.doesNotThrow(() =>
    h.context.recordUsage('app-1', 'app-1', {
      tokensIn: 12,
      tokensOut: 4,
      contextTokens: 80,
    }),
  );
  assert.equal(live.summary.tokensIn, 12);
  assert.equal(live.summary.contextTokens, 80);
  assert.equal(h.events.at(-1)?.type, 'session.updated');
});

test('child refresh never inherits the parent exact context reading', async () => {
  const h = createHarness();
  const parent = registerLive(h, 'parent').live;
  parent.summary.contextAccuracy = 'exact';
  parent.summary.contextTokens = 700;
  const child = addChild(h, parent, 'logical-child', 'backend-child');
  child.session.nextContextStats = {
    used: 100,
    remaining: 900,
    limit: 1_000,
    accuracy: ContextStatsAccuracy.Estimated,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  await h.context.refresh(child.target);

  const event = contextEvents(h).at(-1);
  assert.equal(event?.stats.used, 100);
  assert.equal(event?.stats.remaining, 900);
  assert.equal(event?.stats.accuracy, 'estimated');
});

test('child identities scope backend snapshots and compaction generations by parent', async () => {
  const h = createHarness();
  const parentA = registerLive(h, 'parent-a').live;
  const parentB = registerLive(h, 'parent-b').live;
  const childA = addChild(h, parentA, 'same-child', 'backend-a');
  const childB = addChild(h, parentB, 'same-child', 'backend-b');

  h.context.recordCompaction(childA.target);
  await h.context.refresh(childA.target);
  await h.context.refresh(childB.target);

  const bySource = new Map(contextEvents(h).map((event) => [event.sourceSessionId, event.stats]));
  assert.equal(bySource.get('backend-a')?.compactions, 1);
  assert.equal(bySource.get('backend-b')?.compactions, 0);
  assert.equal(childA.target.childSessionId, 'same-child');
  assert.equal(childA.target.providerSessionId, 'backend-a');

  h.context.recordCompaction(primaryTarget(h, parentA));
  assert.equal(parentA.summary.autoCompactions, 1);
  assert.equal(parentB.summary.autoCompactions, undefined);
});

test('forgetChild clears the resolved backend snapshot and logical generation', async () => {
  const h = createHarness();
  const parent = registerLive(h, 'parent').live;
  const child = addChild(h, parent, 'logical-child', 'backend-child');

  h.context.recordCompaction(child.target);
  await h.context.refresh(child.target);
  const snapshots: unknown = Reflect.get(h.context, 'snapshots');
  assert.ok(snapshots instanceof Map);
  assert.equal(snapshots.has('backend-child'), true);

  h.context.forgetChild(
    { parentAppSessionId: 'parent', childSessionId: 'logical-child' },
    'backend-child',
  );
  assert.equal(snapshots.has('backend-child'), false);

  await h.context.refresh(child.target);
  assert.equal(contextEvents(h).at(-1)?.stats.compactions, 0);
});

test('usage carryover survives replacement and can be reseeded after cleanup', () => {
  const h = createHarness();
  const { live } = registerLive(h, 'app-1');
  h.context.preserveUsage('app-1', { tokensIn: 100, tokensOut: 40 });
  h.context.recordUsage('app-1', 'app-1', {
    tokensIn: 5,
    tokensOut: 2,
    contextTokens: 20,
  });
  assert.deepEqual([live.summary.tokensIn, live.summary.tokensOut], [105, 42]);

  h.context.forgetSession(live);
  h.context.preserveUsage('app-1', { tokensIn: 105, tokensOut: 42 });
  h.context.recordUsage('app-1', 'app-1', {
    tokensIn: 1,
    tokensOut: 1,
    contextTokens: 10,
  });
  assert.deepEqual([live.summary.tokensIn, live.summary.tokensOut], [106, 43]);
});

test('polling and cleanup are idempotent and reset child generation state', async (t) => {
  const h = createHarness();
  const { live, session } = registerLive(h, 'app-1', 'backend-1');
  const { target: childTarget } = addChild(h, live, 'logical-child', 'backend-child');
  const target = primaryTarget(h, live);
  t.after(() => h.context.clearAll());

  h.context.startPolling(target);
  h.context.startPolling(target);
  await Promise.resolve();
  assert.equal(session.contextStatsCalls, 1);
  h.context.stopPolling('app-1');
  h.context.stopPolling('app-1');
  h.context.startPolling(target);
  await Promise.resolve();
  assert.equal(session.contextStatsCalls, 2);

  h.context.recordCompaction(childTarget);
  h.context.stopSession(live);
  h.context.stopPolling('backend-child');
  h.context.forgetSession(live);
  h.events.length = 0;
  await h.context.refresh(childTarget);
  assert.equal(contextEvents(h).at(-1)?.stats.compactions, 0);
});

test('late refreshes after close or clearAll are inert', async () => {
  const h = createHarness();
  const first = registerLive(h, 'first');
  const firstGate = first.session.deferNextContextStats();
  const afterClose = h.context.refresh(primaryTarget(h, first.live));
  first.live.closeMode = 'discard-pending';
  firstGate.resolve();
  await afterClose;
  assert.equal(contextEvents(h).length, 0);

  const second = registerLive(h, 'second');
  const secondGate = second.session.deferNextContextStats();
  const afterClear = h.context.refresh(primaryTarget(h, second.live));
  h.context.clearAll();
  secondGate.resolve();
  await afterClear;
  assert.equal(contextEvents(h).length, 0);

  const parent = registerLive(h, 'parent').live;
  const original = addChild(h, parent, 'logical-child', 'child-backend');
  const childGate = original.session.deferNextContextStats();
  const afterReplacement = h.context.refresh(original.target);
  addChild(h, parent, 'logical-child', 'replacement-backend');
  childGate.resolve();
  await afterReplacement;
  assert.equal(contextEvents(h).length, 0);

  const adopted = addChild(h, parent, 'adopted-child', 'old-backend');
  const adoptionGate = adopted.session.deferNextContextStats();
  const afterAdoption = h.context.refresh(adopted.target);
  adopted.child.session = new FakeFactorySession('new-backend', {}, h.calls);
  adoptionGate.resolve();
  await afterAdoption;
  assert.equal(contextEvents(h).length, 0);
});

test('breakdown failures and malformed values keep valid context stats', async () => {
  const h = createHarness();
  const { live, session } = registerLive(h, 'app-1');
  h.runtime.contextBreakdownErrors.set('app-1', new Error('private RPC failed'));
  await h.context.refresh(primaryTarget(h, live));
  assert.equal(contextEvents(h).at(-1)?.stats.used, 0);

  h.runtime.contextBreakdownErrors.delete('app-1');
  h.runtime.contextBreakdowns.set('app-1', { categories: 'invalid' });
  const beforeMalformed = contextEvents(h).length;
  await h.context.refresh(primaryTarget(h, live));
  assert.equal(contextEvents(h).length, beforeMalformed + 1);
  assert.equal(contextEvents(h).at(-1)?.stats.breakdown, undefined);

  session.nextContextStatsError = new Error('stats unavailable');
  const before = contextEvents(h).length;
  await h.context.refresh(primaryTarget(h, live));
  assert.equal(contextEvents(h).length, before);
});

test('DroidRuntime reads public and private context breakdown seams best effort', async () => {
  const calls: RecordedCall[] = [];
  const session = new FakeFactorySession('backend', {}, calls);
  const runtime = new DroidRuntime();
  Reflect.set(session, 'getContextBreakdown', () => Promise.resolve({ usedTokens: 10 }));
  assert.deepEqual(await runtime.readContextBreakdown(session), { usedTokens: 10 });

  Reflect.deleteProperty(session, 'getContextBreakdown');
  let rpcMethod = '';
  Reflect.set(session, '_client', {
    _sessionRpcWithoutParams: (method: string) => {
      rpcMethod = method;
      return Promise.resolve({ freeTokens: 90 });
    },
  });
  assert.deepEqual(await runtime.readContextBreakdown(session), { freeTokens: 90 });
  assert.equal(rpcMethod, 'droid.get_context_breakdown');

  Reflect.set(session, '_client', {
    _sessionRpcWithoutParams: () => Promise.reject(new Error('transport closed')),
  });
  assert.equal(await runtime.readContextBreakdown(session), undefined);
});

function summary(appSessionId: string, providerSessionId: string): SessionSummary {
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
    maxContextTokens: 1_000,
    createdAt: 1,
    updatedAt: 1,
  };
}
