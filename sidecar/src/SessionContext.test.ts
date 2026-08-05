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
import type { LiveSession } from './SessionLifecycle.js';
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
  contextWindowNotes: [string, number][];
}

function createHarness(): Harness {
  const calls: RecordedCall[] = [];
  const events: ServerEvent[] = [];
  const contextWindowNotes: [string, number][] = [];
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
    noteContextWindow: (modelId, contextWindowTokens) => {
      contextWindowNotes.push([modelId, contextWindowTokens]);
    },
  });
  return { calls, events, runtime, history, registry, context, contextWindowNotes };
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
  child: { session: FakeFactorySession };
  session: FakeFactorySession;
  target: ChildOperationTarget;
} {
  const session = new FakeFactorySession(providerSessionId, {}, h.calls);
  const child = { session };
  let children = childRuntimes.get(parent);
  if (!children) {
    children = new Map();
    childRuntimes.set(parent, children);
  }
  children.set(childSessionId, child);
  const target: ChildOperationTarget = {
    appSessionId: parent.summary.appSessionId,
    parentAppSessionId: parent.summary.appSessionId,
    childSessionId,
    providerSessionId,
    sourceSessionId: childSessionId,
    session,
    role: 'worker',
    isCurrent: () =>
      !parent.closeMode &&
      h.registry.getLive(parent.summary.appSessionId) === parent &&
      childRuntimes.get(parent)?.get(childSessionId) === child &&
      child.session === session,
  };
  return { child, session, target };
}

const childRuntimes = new WeakMap<LiveSession, Map<string, { session: FakeFactorySession }>>();

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

test('plausible exact primary usage wins while child usage changes totals only', async () => {
  const h = createHarness();
  const { live, session } = registerLive(h, 'app-1');
  live.summary.maxContextTokens = 1_000;
  h.context.recordUsage('app-1', 'app-1', {
    tokensIn: 10,
    tokensOut: 3,
    contextTokens: 800,
  });
  h.context.recordUsage('app-1', 'child-backend', {
    tokensIn: 20,
    tokensOut: 5,
    contextTokens: 900,
  });
  assert.equal(live.summary.tokensIn, 20);
  assert.equal(live.summary.tokensOut, 5);
  assert.equal(live.summary.contextTokens, 800);
  assert.equal(h.history.summaryPatches().get('app-1')?.tokensIn, 20);
  assert.equal(h.history.summaryPatches().get('app-1')?.contextTokens, 800);

  session.nextContextStats = {
    used: 100,
    remaining: 900,
    limit: 1_000,
    accuracy: ContextStatsAccuracy.Estimated,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await h.context.refresh(primaryTarget(h, live));

  const event = contextEvents(h).at(-1);
  assert.equal(event?.stats.used, 800);
  assert.equal(event?.stats.remaining, 200);
  assert.equal(event?.stats.accuracy, 'exact');
});

test('provider context wins over an impossible persisted exact reading', async () => {
  const h = createHarness();
  const { live, session } = registerLive(h, 'app-1');
  live.summary.maxContextTokens = 1_000;
  live.summary.contextTokens = 13_105_406;
  live.summary.contextAccuracy = 'exact';
  session.nextContextStats = {
    used: 320,
    remaining: 680,
    limit: 1_000,
    accuracy: ContextStatsAccuracy.Estimated,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  await h.context.refresh(primaryTarget(h, live));

  const event = contextEvents(h).at(-1);
  assert.equal(event?.stats.used, 320);
  assert.equal(event?.stats.remaining, 680);
  assert.equal(live.summary.contextTokens, 320);
  assert.equal(live.summary.contextAccuracy, 'estimated');
});

test('cumulative provider estimates rebase after restored in-place compactions', async () => {
  const h = createHarness();
  const { live, session } = registerLive(h, 'app-1');
  live.summary.autoCompactions = 5;
  session.nextContextStats = {
    used: 397_000,
    remaining: 0,
    limit: 196_608,
    accuracy: ContextStatsAccuracy.Estimated,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  h.runtime.contextBreakdowns.set('app-1', {
    modelId: 'model-default',
    contextBudget: 100_000,
    usedTokens: 397_000,
    freeTokens: 0,
    categories: [{ name: 'Messages', tokens: 380_000, colorKey: 'messages' }],
  });

  await h.context.refresh(primaryTarget(h, live));

  const reset = contextEvents(h).at(-1)?.stats;
  assert.equal(reset?.used, 0);
  assert.equal(reset?.remaining, 196_608);
  assert.equal(reset?.breakdown, undefined);
  assert.equal(live.summary.contextTokens, 0);

  session.nextContextStats = {
    ...session.nextContextStats,
    used: 409_000,
  };
  await h.context.refresh(primaryTarget(h, live));

  const advanced = contextEvents(h).at(-1)?.stats;
  assert.equal(advanced?.used, 12_000);
  assert.equal(advanced?.remaining, 184_608);
});

test('a live compaction rebases a sub-window provider counter until the counter resets', async () => {
  const h = createHarness();
  const { live, session } = registerLive(h, 'app-1');
  session.nextContextStats = {
    used: 900,
    remaining: 100,
    limit: 1_000,
    accuracy: ContextStatsAccuracy.Estimated,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await h.context.refresh(primaryTarget(h, live));

  h.context.recordCompaction(primaryTarget(h, live));
  session.nextContextStats = {
    ...session.nextContextStats,
    used: 950,
    remaining: 50,
  };
  await h.context.refresh(primaryTarget(h, live));

  const rebased = contextEvents(h).at(-1)?.stats;
  assert.equal(rebased?.used, 50);
  assert.equal(rebased?.remaining, 950);
  assert.equal(live.summary.autoCompactions, 1);

  session.nextContextStats = {
    ...session.nextContextStats,
    used: 40,
    remaining: 960,
  };
  await h.context.refresh(primaryTarget(h, live));

  const reset = contextEvents(h).at(-1)?.stats;
  assert.equal(reset?.used, 40);
  assert.equal(reset?.remaining, 960);
});

test('a zero-limit provider reading cannot poison a live compaction baseline', async () => {
  const h = createHarness();
  const { live, session } = registerLive(h, 'app-1');
  session.nextContextStats = {
    used: 900,
    remaining: 100,
    limit: 1_000,
    accuracy: ContextStatsAccuracy.Estimated,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await h.context.refresh(primaryTarget(h, live));
  h.context.recordCompaction(primaryTarget(h, live));

  const eventCount = contextEvents(h).length;
  session.nextContextStats = {
    ...session.nextContextStats,
    used: 0,
    remaining: 0,
    limit: 0,
  };
  await h.context.refresh(primaryTarget(h, live));
  assert.equal(contextEvents(h).length, eventCount);

  session.nextContextStats = {
    ...session.nextContextStats,
    used: 950,
    remaining: 50,
    limit: 1_000,
  };
  await h.context.refresh(primaryTarget(h, live));

  const rebased = contextEvents(h).at(-1)?.stats;
  assert.equal(rebased?.used, 50);
  assert.equal(rebased?.remaining, 950);
});

test('usage without current-context telemetry updates totals only', () => {
  const h = createHarness();
  const { live } = registerLive(h, 'app-1');
  live.summary.contextTokens = 320;
  live.summary.contextAccuracy = 'estimated';

  h.context.recordUsage('app-1', 'app-1', { tokensIn: 900, tokensOut: 40 });

  assert.equal(live.summary.tokensIn, 900);
  assert.equal(live.summary.tokensOut, 40);
  assert.equal(live.summary.contextTokens, 320);
  assert.equal(live.summary.contextAccuracy, 'estimated');
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

test('child identities scope snapshots, pollers, and compaction generations by parent', async (t) => {
  const h = createHarness();
  const parentA = registerLive(h, 'parent-a').live;
  const parentB = registerLive(h, 'parent-b').live;
  const childA = addChild(h, parentA, 'same-child', 'backend-a');
  const childB = addChild(h, parentB, 'same-child', 'backend-b');
  t.after(() => h.context.clearAll());

  h.context.recordCompaction(childA.target);
  h.context.startPolling(childA.target);
  h.context.startPolling(childB.target);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const childEvents = contextEvents(h).filter((event) => event.sourceSessionId === 'same-child');
  assert.equal(
    childEvents.find((event) => event.parentAppSessionId === 'parent-a')?.stats.compactions,
    1,
  );
  assert.equal(
    childEvents.find((event) => event.parentAppSessionId === 'parent-b')?.stats.compactions,
    0,
  );
  assert.equal(childA.session.contextStatsCalls, 1);
  assert.equal(childB.session.contextStatsCalls, 1);
  assert.equal(childA.target.childSessionId, 'same-child');
  assert.equal(childA.target.providerSessionId, 'backend-a');

  h.context.recordCompaction(primaryTarget(h, parentA));
  assert.equal(parentA.summary.autoCompactions, 1);
  assert.equal(parentB.summary.autoCompactions, undefined);
});

test('primary and child resource keys cannot alias', async (t) => {
  const h = createHarness();
  const primary = registerLive(h, '1:px');
  const parent = registerLive(h, 'p').live;
  const child = addChild(h, parent, 'x', 'child-provider');
  t.after(() => h.context.clearAll());
  child.session.nextContextStats = {
    used: 100,
    remaining: 900,
    limit: 1_000,
    accuracy: ContextStatsAccuracy.Estimated,
    updatedAt: '2026-07-30T00:00:00.000Z',
  };
  h.runtime.contextBreakdowns.set('child-provider', {
    usedTokens: 100,
    contextBudget: 1_000,
    categories: [{ name: 'Child tools', tokens: 100 }],
  });
  await h.context.refresh(child.target);

  h.context.recordUsage('1:px', '1:px', {
    tokensIn: 10,
    tokensOut: 5,
    contextTokens: 50,
  });
  const primaryEstimate = contextEvents(h).findLast(
    (event) => event.appSessionId === '1:px' && event.sourceSessionId === '1:px',
  );
  assert.equal(primaryEstimate?.stats.breakdown, undefined);

  h.context.startPolling(primaryTarget(h, primary.live));
  h.context.startPolling(child.target);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(primary.session.contextStatsCalls, 1);
  assert.equal(child.session.contextStatsCalls, 2);

  h.context.stopSession(primary.live);
  h.context.startPolling(child.target);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(child.session.contextStatsCalls, 2);
});

test('a refresh in flight across a primary compaction never republishes stale stats', async () => {
  const h = createHarness();
  const { live, session } = registerLive(h, 'app-1');
  session.nextContextStats = {
    used: 900,
    remaining: 100,
    limit: 1_000,
    accuracy: ContextStatsAccuracy.Exact,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const gate = session.deferNextContextStats();
  const inFlight = h.context.refresh(primaryTarget(h, live));

  h.context.recordCompaction(primaryTarget(h, live));
  assert.equal(live.summary.contextTokens, 0);
  assert.equal(live.summary.autoCompactions, 1);

  gate.resolve();
  await inFlight;
  assert.equal(contextEvents(h).length, 0);
  assert.equal(live.summary.contextTokens, 0);
});

test('queued pre-compaction exact usage cannot undo the reset before a new turn', async () => {
  const h = createHarness();
  const { live, session } = registerLive(h, 'app-1');
  h.context.recordCompaction(primaryTarget(h, live));

  h.context.recordUsage('app-1', 'app-1', { tokensIn: 10, tokensOut: 5, contextTokens: 800 });
  assert.equal(live.summary.tokensIn, 10);
  assert.equal(live.summary.tokensOut, 5);
  assert.equal(live.summary.contextTokens, 0);
  assert.equal(contextEvents(h).length, 0);

  session.nextContextStats = {
    used: 120,
    remaining: 880,
    limit: 1_000,
    accuracy: ContextStatsAccuracy.Estimated,
    updatedAt: '2026-01-01T00:00:01.000Z',
  };
  await h.context.refresh(primaryTarget(h, live));
  assert.equal(contextEvents(h).at(-1)?.stats.used, 120);
  assert.equal(live.summary.contextTokens, 120);

  // A late pre-compaction usage event must NOT resurrect the old meter, even
  // though the provider reading has already confirmed the reset. The guard
  // persists until the next turn boundary, so contextTokens stays at the
  // provider reading's 120 (not the stale 800 from the usage event).
  h.context.recordUsage('app-1', 'app-1', { tokensIn: 11, tokensOut: 6, contextTokens: 800 });
  assert.equal(live.summary.tokensIn, 11);
  assert.equal(live.summary.tokensOut, 6);
  assert.equal(live.summary.contextTokens, 120);

  // The new turn begins: the guard is cleared, and post-compaction usage
  // events now apply their context fields normally.
  h.context.beginTurn('app-1');
  h.context.recordUsage('app-1', 'app-1', { tokensIn: 12, tokensOut: 6, contextTokens: 200 });
  assert.equal(live.summary.contextTokens, 200);
});

test('provider-observed context windows are reported for compaction tuning', async () => {
  const h = createHarness();
  const { live } = registerLive(h, 'app-1');
  await h.context.refresh(primaryTarget(h, live));
  assert.deepEqual(h.contextWindowNotes.at(-1), ['model-default', 1_000]);
});

test('forgetChild clears the resolved backend snapshot and logical generation', async () => {
  const h = createHarness();
  const parent = registerLive(h, 'parent').live;
  const child = addChild(h, parent, 'logical-child', 'backend-child');

  h.context.recordCompaction(child.target);
  await h.context.refresh(child.target);

  h.context.forgetChild({ parentAppSessionId: 'parent', childSessionId: 'logical-child' });

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
  h.context.stopPolling(target);
  h.context.stopPolling(target);
  h.context.startPolling(target);
  await Promise.resolve();
  assert.equal(session.contextStatsCalls, 2);

  h.context.recordCompaction(childTarget);
  h.context.stopSession(live);
  h.context.stopPolling(childTarget);
  h.context.forgetChild({
    parentAppSessionId: 'app-1',
    childSessionId: 'logical-child',
  });
  h.context.forgetSession(live);
  h.events.length = 0;
  await h.context.refresh(childTarget);
  assert.equal(contextEvents(h).at(-1)?.stats.compactions, 0);
});

test('a stale child runtime cannot stop its replacement poller', async (t) => {
  const h = createHarness();
  const parent = registerLive(h, 'parent').live;
  const stale = addChild(h, parent, 'child', 'provider-old');
  t.after(() => h.context.clearAll());

  h.context.startPolling(stale.target);
  h.context.stopPolling(stale.target);
  const replacement = addChild(h, parent, 'child', 'provider-new');
  h.context.startPolling(replacement.target);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replacement.session.contextStatsCalls, 1);

  h.context.stopPolling(stale.target);
  h.context.startPolling(replacement.target);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replacement.session.contextStatsCalls, 1);
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
