import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoCompactionWatchdogs } from './autoCompactionWatchdog.js';
import type { SessionRole } from './protocol.js';
import {
  handleCompactionNotification,
  type AutoCompactionHost,
  type CompactingChildState,
} from './sessionAutoCompaction.js';

interface TestSession {
  id: string;
}

type TestChild = CompactingChildState;

interface TestSummary {
  appSessionId: string;
  autoCompactions?: number;
  contextTokens?: number;
  contextAccuracy?: number;
}

interface TestLiveSession {
  summary: TestSummary;
  streaming: boolean;
  compacting?: boolean;
  autoCompacting: boolean;
  pendingSends: string[];
  childSessions: Map<string, TestChild>;
}

interface SummaryPatch {
  contextTokens?: number;
  contextAccuracy?: undefined;
  autoCompactions?: number;
  queuedSends?: number;
}

interface StatusCall {
  appSessionId: string;
  text: string;
  providerSessionId: string;
  role: SessionRole;
}

interface ChildCall {
  appSessionId: string;
  providerSessionId: string;
}

interface NotificationTarget {
  appSessionId: string;
  providerSessionId: string;
  role: SessionRole;
  session: TestSession;
}

interface Harness {
  host: AutoCompactionHost<TestChild, TestLiveSession, TestSession>;
  live: TestLiveSession;
  child: TestChild;
  primarySession: TestSession;
  childSession: TestSession;
  primaryTarget: NotificationTarget;
  childTarget: NotificationTarget;
  watchdogs: AutoCompactionWatchdogs;
  statuses: StatusCall[];
  patches: SummaryPatch[];
  refreshed: { providerSessionId: string; session: TestSession }[];
  settledPrimary: string[];
  driven: { child: TestChild; text: string }[];
  closed: ChildCall[];
  paused: TestChild[];
}

function createHarness(
  childKey = 'worker-1',
  childProviderSessionId = childKey,
  childTransportId = childKey,
): Harness {
  const primarySession: TestSession = { id: 'primary-transport' };
  const childSession: TestSession = { id: childTransportId };
  const child: TestChild = {
    appSessionId: 'app-1',
    providerSessionId: childProviderSessionId,
    role: 'worker',
    streaming: false,
    autoCompacting: false,
    pendingSends: [],
  };
  const live: TestLiveSession = {
    summary: {
      appSessionId: 'app-1',
      autoCompactions: 0,
      contextTokens: 120,
      contextAccuracy: 0.8,
    },
    streaming: false,
    autoCompacting: false,
    pendingSends: [],
    childSessions: new Map([[childKey, child]]),
  };
  const statuses: StatusCall[] = [];
  const patches: SummaryPatch[] = [];
  const refreshed: { providerSessionId: string; session: TestSession }[] = [];
  const settledPrimary: string[] = [];
  const driven: { child: TestChild; text: string }[] = [];
  const closed: ChildCall[] = [];
  const paused: TestChild[] = [];
  const watchdogs = new AutoCompactionWatchdogs(() => undefined);
  const childSessionCompactions = new Map<string, number>();
  const primaryTarget: NotificationTarget = {
    appSessionId: 'app-1',
    providerSessionId: 'app-1',
    role: 'primary',
    session: primarySession,
  };
  const childTarget: NotificationTarget = {
    appSessionId: 'app-1',
    providerSessionId: childKey,
    role: 'worker',
    session: childSession,
  };
  const host: AutoCompactionHost<TestChild, TestLiveSession, TestSession> = {
    watchdogs,
    sessions: () => [live],
    findSession: (appSessionId) => (appSessionId === live.summary.appSessionId ? live : undefined),
    childSessionCompactions,
    emitCompactionStatus: (appSessionId, text, providerSessionId, role) => {
      statuses.push({ appSessionId, text, providerSessionId, role });
    },
    patchSummary: (_appSessionId, patch) => {
      patches.push(patch);
      if (patch.contextTokens !== undefined) live.summary.contextTokens = patch.contextTokens;
      if ('contextAccuracy' in patch) live.summary.contextAccuracy = patch.contextAccuracy;
      if (patch.autoCompactions !== undefined) live.summary.autoCompactions = patch.autoCompactions;
    },
    refreshContext: (providerSessionId, session) => {
      refreshed.push({ providerSessionId, session });
      return Promise.resolve();
    },
    settlePrimary: (appSessionId) => {
      settledPrimary.push(appSessionId);
    },
    driveChildSession: (drivenChild, text) => {
      driven.push({ child: drivenChild, text });
      return Promise.resolve();
    },
    closeChildSession: (appSessionId, providerSessionId) => {
      closed.push({ appSessionId, providerSessionId });
      return Promise.resolve();
    },
    emitChildSessionPaused: (pausedChild) => {
      paused.push(pausedChild);
    },
  };
  return {
    host,
    live,
    child,
    primarySession,
    childSession,
    primaryTarget,
    childTarget,
    watchdogs,
    statuses,
    patches,
    refreshed,
    settledPrimary,
    driven,
    closed,
    paused,
  };
}

function startedNotification(): Record<string, unknown> {
  return {
    params: {
      notification: {
        type: 'droid_working_state_changed',
        newState: 'compacting_conversation',
      },
    },
  };
}

function completedNotification(): Record<string, unknown> {
  return {
    params: {
      notification: { type: 'session_compacted', summaryId: 'summary-1', removedCount: 12 },
    },
  };
}

function idleNotification(): Record<string, unknown> {
  return {
    params: {
      notification: { type: 'droid_working_state_changed', newState: 'idle' },
    },
  };
}

test('primary start and completion publish exact statuses and settle accounting', (t) => {
  const harness = createHarness();
  t.after(() => harness.watchdogs.clearAll());
  harness.live.summary.autoCompactions = 2;
  harness.live.pendingSends.push('next primary prompt');

  assert.equal(
    handleCompactionNotification(harness.host, harness.primaryTarget, startedNotification()),
    true,
  );
  assert.equal(harness.live.autoCompacting, true);
  assert.equal(harness.watchdogs.isArmed('app-1'), true);

  assert.equal(
    handleCompactionNotification(harness.host, harness.primaryTarget, completedNotification()),
    true,
  );

  assert.equal(harness.live.autoCompacting, false);
  assert.equal(harness.watchdogs.isArmed('app-1'), false);
  assert.deepEqual(harness.statuses, [
    {
      appSessionId: 'app-1',
      text: 'Compacting conversation...',
      providerSessionId: 'app-1',
      role: 'primary',
    },
    {
      appSessionId: 'app-1',
      text: 'Compaction complete.',
      providerSessionId: 'app-1',
      role: 'primary',
    },
  ]);
  assert.deepEqual(harness.patches, [
    { contextTokens: 0, contextAccuracy: undefined, autoCompactions: 3 },
  ]);
  assert.deepEqual(harness.settledPrimary, ['app-1']);
  assert.deepEqual(harness.refreshed, [
    { providerSessionId: 'app-1', session: harness.primarySession },
  ]);
});

test('worker completion drains one queued send and increments only the worker generation', (t) => {
  const harness = createHarness();
  t.after(() => harness.watchdogs.clearAll());
  harness.live.summary.autoCompactions = 4;
  harness.host.childSessionCompactions.set('worker-1', 6);
  harness.child.pendingSends.push('next worker prompt');

  assert.equal(
    handleCompactionNotification(harness.host, harness.childTarget, startedNotification()),
    true,
  );
  assert.equal(harness.child.autoCompacting, true);
  assert.equal(harness.watchdogs.isArmed('worker-1'), true);

  assert.equal(
    handleCompactionNotification(harness.host, harness.childTarget, completedNotification()),
    true,
  );

  assert.equal(harness.child.autoCompacting, false);
  assert.equal(harness.watchdogs.isArmed('worker-1'), false);
  assert.deepEqual(harness.statuses, [
    {
      appSessionId: 'app-1',
      text: 'Compacting conversation...',
      providerSessionId: 'worker-1',
      role: 'worker',
    },
    {
      appSessionId: 'app-1',
      text: 'Compaction complete.',
      providerSessionId: 'worker-1',
      role: 'worker',
    },
  ]);
  assert.equal(harness.host.childSessionCompactions.get('worker-1'), 7);
  assert.equal(harness.live.summary.autoCompactions, 4);
  assert.deepEqual(harness.patches, []);
  assert.deepEqual(harness.driven, [{ child: harness.child, text: 'next worker prompt' }]);
  assert.deepEqual(harness.child.pendingSends, []);
  assert.deepEqual(harness.refreshed, [
    { providerSessionId: 'worker-1', session: harness.childSession },
  ]);
});

test('idle working state settles active primary and worker compaction without accounting', (t) => {
  const harness = createHarness();
  t.after(() => harness.watchdogs.clearAll());

  handleCompactionNotification(harness.host, harness.primaryTarget, startedNotification());
  assert.equal(
    handleCompactionNotification(harness.host, harness.primaryTarget, idleNotification()),
    false,
  );

  harness.child.pendingSends.push('queued worker prompt');
  handleCompactionNotification(harness.host, harness.childTarget, startedNotification());
  assert.equal(
    handleCompactionNotification(harness.host, harness.childTarget, idleNotification()),
    false,
  );

  assert.equal(harness.live.autoCompacting, false);
  assert.equal(harness.child.autoCompacting, false);
  assert.deepEqual(harness.settledPrimary, ['app-1']);
  assert.deepEqual(harness.driven, [{ child: harness.child, text: 'queued worker prompt' }]);
  assert.deepEqual(harness.patches, []);
  assert.equal(harness.host.childSessionCompactions.size, 0);
  assert.deepEqual(harness.refreshed, []);
});

test('unrelated working states leave compaction ownership untouched', (t) => {
  const harness = createHarness();
  t.after(() => harness.watchdogs.clearAll());
  harness.live.pendingSends.push('keep queued');

  assert.equal(
    handleCompactionNotification(harness.host, harness.primaryTarget, {
      params: {
        notification: { type: 'droid_working_state_changed', newState: 'thinking' },
      },
    }),
    false,
  );

  assert.equal(harness.live.autoCompacting, false);
  assert.equal(harness.watchdogs.isArmed('app-1'), false);
  assert.deepEqual(harness.live.pendingSends, ['keep queued']);
  assert.deepEqual(harness.statuses, []);
  assert.deepEqual(harness.patches, []);
  assert.deepEqual(harness.refreshed, []);
  assert.deepEqual(harness.settledPrimary, []);
});

test('late primary and worker completion notifications are inert once settled', (t) => {
  const harness = createHarness();
  t.after(() => harness.watchdogs.clearAll());

  const targets: NotificationTarget[] = [harness.primaryTarget, harness.childTarget];
  for (const target of targets) {
    handleCompactionNotification(harness.host, target, startedNotification());
    handleCompactionNotification(harness.host, target, idleNotification());
  }
  const statusesBeforeLateCompletion = [...harness.statuses];
  const settlementsBeforeLateCompletion = [...harness.settledPrimary];
  const pausedBeforeLateCompletion = [...harness.paused];

  assert.equal(
    handleCompactionNotification(harness.host, harness.primaryTarget, completedNotification()),
    true,
  );
  assert.equal(
    handleCompactionNotification(harness.host, harness.childTarget, completedNotification()),
    true,
  );

  assert.deepEqual(harness.statuses, statusesBeforeLateCompletion);
  assert.deepEqual(harness.settledPrimary, settlementsBeforeLateCompletion);
  assert.deepEqual(harness.paused, pausedBeforeLateCompletion);
  assert.deepEqual(harness.patches, []);
  assert.equal(harness.host.childSessionCompactions.size, 0);
  assert.deepEqual(harness.refreshed, []);
  assert.equal(harness.live.summary.autoCompactions, 0);
});

test('deferred worker close resolves the child-map key when the transport id differs', (t) => {
  const harness = createHarness('worker-close-key', 'worker-close-key', 'worker-live-id');
  t.after(() => harness.watchdogs.clearAll());
  harness.child.autoCompacting = true;
  harness.child.closeWhenIdle = true;
  harness.watchdogs.arm('worker-close-key', 60_000);

  assert.equal(
    handleCompactionNotification(harness.host, harness.childTarget, completedNotification()),
    true,
  );

  assert.equal(harness.childSession.id, 'worker-live-id');
  assert.deepEqual(harness.closed, [
    { appSessionId: 'app-1', providerSessionId: 'worker-close-key' },
  ]);
  assert.deepEqual(harness.driven, []);
  assert.deepEqual(harness.paused, []);
  assert.equal(harness.host.childSessionCompactions.get('worker-close-key'), 1);
  assert.deepEqual(harness.refreshed, [
    { providerSessionId: 'worker-close-key', session: harness.childSession },
  ]);
});
