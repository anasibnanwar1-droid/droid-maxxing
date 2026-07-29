import assert from 'node:assert/strict';
import test from 'node:test';
import type { AskUserResult, RequestPermissionHandlerResult } from '@factory/droid-sdk';

import {
  SessionCompaction,
  type AutomaticCompactionTarget,
  type ChildAutomaticCompactionTarget,
  type CompactionResourceKey,
  type PrimaryAutomaticCompactionTarget,
} from './SessionCompaction.js';
import type { LiveChildSession, LiveSession } from './SessionLifecycle.js';
import { createCompactionTestLiveSession } from './testing/compactionTestSupport.js';
import {
  FakeFactoryRuntime,
  FakeFactorySession,
  type RecordedCall,
} from './testing/fakeFactoryRuntime.js';

interface ObservedTimer {
  callback: () => void;
  clears: number;
  delay: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Harness {
  calls: RecordedCall[];
  compaction: SessionCompaction;
  generations: Map<string, number>;
  targets: Map<string, AutomaticCompactionTarget>;
  trace: string[];
}

function createHarness(): Harness {
  const calls: RecordedCall[] = [];
  const generations = new Map<string, number>();
  const targets = new Map<string, AutomaticCompactionTarget>();
  const trace: string[] = [];
  const runtime = new FakeFactoryRuntime(calls);
  const compaction = new SessionCompaction({
    registry: {
      getLive: () => undefined,
      resolveSummary: () => undefined,
      replaceProvider: () => undefined,
      updateSummary: () => undefined,
    },
    context: {
      recordCompaction: (target) => {
        const id = targetId(target);
        generations.set(id, (generations.get(id) ?? 0) + 1);
        trace.push(`record:${id}`);
      },
      refresh: (target) => {
        trace.push(`refresh:${targetId(target)}`);
        return Promise.resolve();
      },
      preserveUsage: () => undefined,
    },
    timeline: {
      appendStatus: (_appSessionId, text, _compactType, sourceSessionId) => {
        trace.push(`status:${sourceSessionId}:${text}`);
      },
    },
    runtime,
    makePermissionHandler: () => () => new Promise<RequestPermissionHandlerResult>(() => undefined),
    makeAskUserHandler: () => () => new Promise<AskUserResult>(() => undefined),
    emitError: () => undefined,
    isShutdownStarted: () => false,
    getFactoryDefaults: () => Promise.resolve({}),
    maxContextTokensForModel: () => undefined,
    resolveAutomaticTarget: (key) => targets.get(resourceId(key)),
    settleAutomatic: (settlement) => {
      const resolved = targets.get(resourceId(settlement));
      const id =
        settlement.kind === 'primary'
          ? `p:${settlement.appSessionId}`
          : `c:${settlement.parentAppSessionId}/${settlement.childSessionId}`;
      const active =
        settlement.kind === 'primary'
          ? resolved?.kind === 'primary'
            ? resolved.liveSession.autoCompacting
            : undefined
          : settlement.child.autoCompacting;
      trace.push(`settle:${id}:active=${String(active)}`);
      if (settlement.kind === 'child') {
        const next = settlement.child.pendingSends.shift();
        if (next !== undefined) trace.push(`drive:${id}:${next}`);
      }
    },
  });
  return { calls, compaction, generations, targets, trace };
}

function addPrimary(
  h: Harness,
  appSessionId: string,
): {
  live: LiveSession;
  session: FakeFactorySession;
  target: PrimaryAutomaticCompactionTarget;
  setCurrent(value: boolean): void;
} {
  const session = new FakeFactorySession(`${appSessionId}-backend`, {}, h.calls);
  const live = createCompactionTestLiveSession(appSessionId, session);
  let current = true;
  const target: PrimaryAutomaticCompactionTarget = {
    kind: 'primary',
    appSessionId,
    providerSessionId: session.sessionId,
    sourceSessionId: appSessionId,
    session,
    liveSession: live,
    isCurrent: () => current && !live.closeMode && live.session === session,
  };
  h.targets.set(resourceId({ kind: 'primary', appSessionId }), target);
  return { live, session, target, setCurrent: (value) => (current = value) };
}

function addChild(
  h: Harness,
  parentAppSessionId: string,
  childSessionId: string,
): {
  child: LiveChildSession;
  parent: LiveSession;
  target: ChildAutomaticCompactionTarget;
  setCurrent(value: boolean): void;
} {
  const parentSession = new FakeFactorySession(`${parentAppSessionId}-backend`, {}, h.calls);
  const parent = createCompactionTestLiveSession(parentAppSessionId, parentSession);
  const session = new FakeFactorySession(`${parentAppSessionId}-child-backend`, {}, h.calls);
  const child: LiveChildSession = {
    session,
    childSessionId,
    runtimeGeneration: 1,
    appSessionId: parentAppSessionId,
    role: 'worker',
    lastUsedAt: 1,
    streaming: false,
    autoCompacting: false,
    pendingSends: [],
  };
  parent.childSessions.set(childSessionId, child);
  let current = true;
  const target: ChildAutomaticCompactionTarget = {
    kind: 'child',
    appSessionId: parentAppSessionId,
    parentAppSessionId,
    childSessionId,
    providerSessionId: session.sessionId,
    sourceSessionId: session.sessionId,
    session,
    role: child.role,
    child,
    isCurrent: () =>
      current &&
      !parent.closeMode &&
      parent.childSessions.get(childSessionId) === child &&
      child.session === session,
  };
  h.targets.set(resourceId({ kind: 'child', parentAppSessionId, childSessionId }), target);
  return { child, parent, target, setCurrent: (value) => (current = value) };
}

function observeTimers(trace: string[]) {
  type TimerCallback = (...args: unknown[]) => void;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const records: ObservedTimer[] = [];
  Reflect.set(
    globalThis,
    'setTimeout',
    (callback: TimerCallback, delay = 0, ...args: unknown[]) => {
      const timer = originalSetTimeout(callback, delay, ...args);
      const record = {
        callback: () => callback(...args),
        clears: 0,
        delay,
        timer,
      };
      records.push(record);
      trace.push(`watchdog:arm:${String(delay)}`);
      return timer;
    },
  );
  Reflect.set(globalThis, 'clearTimeout', (timer: ReturnType<typeof setTimeout> | undefined) => {
    const record = records.find((candidate) => candidate.timer === timer);
    if (record) {
      record.clears += 1;
      trace.push(`watchdog:clear:${String(record.delay)}`);
    }
    originalClearTimeout(timer);
  });
  return {
    records,
    fire: (record: ObservedTimer) => {
      originalClearTimeout(record.timer);
      record.callback();
    },
    restore: () => {
      for (const record of records) originalClearTimeout(record.timer);
      Reflect.set(globalThis, 'setTimeout', originalSetTimeout);
      Reflect.set(globalThis, 'clearTimeout', originalClearTimeout);
    },
  };
}

test(
  'primary and child completion preserve the exact automatic-compaction trace',
  { concurrency: false },
  (t) => {
    const h = createHarness();
    const timers = observeTimers(h.trace);
    t.after(() => {
      h.compaction.clearAll();
      timers.restore();
    });
    const primary = addPrimary(h, 'app-1');
    h.compaction.subscribePrimary(primary.target);
    primary.session.emitNotification(startedNotification());
    assert.equal(primary.live.autoCompacting, true);
    assert.deepEqual(h.trace, ['watchdog:arm:300000', 'status:app-1:Compacting conversation...']);

    h.trace.length = 0;
    primary.session.emitNotification(completedNotification());
    assert.deepEqual(h.trace, [
      'watchdog:clear:300000',
      'settle:p:app-1:active=false',
      'status:app-1:Compaction complete.',
      'record:p:app-1',
      'refresh:p:app-1',
    ]);

    const child = addChild(h, 'app-1', 'worker-1');
    child.child.pendingSends.push('next worker prompt');
    h.trace.length = 0;
    assert.equal(h.compaction.handleChildNotification(child.target, startedNotification()), true);
    assert.equal(h.compaction.handleChildNotification(child.target, completedNotification()), true);
    assert.deepEqual(h.trace, [
      'watchdog:arm:300000',
      'status:worker-1:Compacting conversation...',
      'watchdog:clear:300000',
      'settle:c:app-1/worker-1:active=false',
      'drive:c:app-1/worker-1:next worker prompt',
      'status:worker-1:Compaction complete.',
      'record:c:app-1/worker-1',
      'refresh:c:app-1/worker-1',
    ]);
  },
);

test(
  'idle, late completion, cancel, and stale notification stay effect-free',
  { concurrency: false },
  (t) => {
    const h = createHarness();
    const timers = observeTimers(h.trace);
    t.after(() => {
      h.compaction.clearAll();
      timers.restore();
    });
    const child = addChild(h, 'parent', 'worker');
    h.compaction.handleChildNotification(child.target, startedNotification());
    const firstStart = timers.records.at(-1);
    assert.ok(firstStart);
    h.trace.length = 0;
    h.compaction.handleChildNotification(child.target, startedNotification());
    assert.equal(firstStart.clears, 1);
    assert.deepEqual(h.trace, [
      'watchdog:clear:300000',
      'watchdog:arm:300000',
      'status:worker:Compacting conversation...',
    ]);
    h.trace.length = 0;

    assert.equal(h.compaction.handleChildNotification(child.target, idleNotification()), false);
    assert.deepEqual(h.trace, ['watchdog:clear:300000', 'settle:c:parent/worker:active=false']);
    h.trace.length = 0;
    assert.equal(h.compaction.handleChildNotification(child.target, completedNotification()), true);
    assert.deepEqual(h.trace, []);

    h.compaction.handleChildNotification(child.target, startedNotification());
    h.trace.length = 0;
    h.compaction.cancel(child.target);
    assert.equal(child.child.autoCompacting, false);
    assert.deepEqual(h.trace, ['watchdog:clear:300000']);

    h.trace.length = 0;
    child.setCurrent(false);
    h.compaction.clearAll();
    assert.equal(h.compaction.handleChildNotification(child.target, startedNotification()), false);
    assert.deepEqual(h.trace, []);
  },
);

test(
  'post-turn tightening, expiry, and clearAll settle only the current target',
  { concurrency: false },
  (t) => {
    const h = createHarness();
    const timers = observeTimers(h.trace);
    t.after(() => {
      h.compaction.clearAll();
      timers.restore();
    });
    const primary = addPrimary(h, 'app-1');
    h.compaction.subscribePrimary(primary.target);
    primary.session.emitNotification(startedNotification());
    h.trace.length = 0;

    h.compaction.afterTurn(primary.target);
    assert.deepEqual(h.trace, ['watchdog:clear:300000', 'watchdog:arm:60000']);
    h.trace.length = 0;
    const tightened = timers.records.at(-1);
    assert.ok(tightened);
    timers.fire(tightened);
    assert.equal(primary.live.autoCompacting, false);
    assert.deepEqual(h.trace, ['settle:p:app-1:active=false']);

    primary.session.emitNotification(startedNotification());
    const stale = timers.records.at(-1);
    assert.ok(stale);
    h.trace.length = 0;
    h.compaction.clearAll();
    timers.fire(stale);
    assert.equal(primary.live.autoCompacting, true);
    assert.deepEqual(h.trace, ['watchdog:clear:300000']);
  },
);

test(
  'same childSessionId under two parents keeps watchdogs and generations independent',
  { concurrency: false },
  (t) => {
    const h = createHarness();
    const timers = observeTimers(h.trace);
    t.after(() => {
      h.compaction.clearAll();
      timers.restore();
    });
    const childA = addChild(h, 'parent-a', 'shared-child');
    const childB = addChild(h, 'parent-b', 'shared-child');
    h.compaction.handleChildNotification(childA.target, startedNotification());
    h.compaction.handleChildNotification(childB.target, startedNotification());
    const [timerA, timerB] = timers.records;
    assert.ok(timerA);
    assert.ok(timerB);

    h.compaction.cancel(childA.target);
    assert.deepEqual([timerA.clears, timerB.clears], [1, 0]);
    assert.deepEqual([childA.child.autoCompacting, childB.child.autoCompacting], [false, true]);

    h.compaction.handleChildNotification(childA.target, startedNotification());
    h.compaction.handleChildNotification(childA.target, completedNotification());
    assert.equal(h.generations.get('c:parent-a/shared-child'), 1);
    assert.equal(h.generations.get('c:parent-b/shared-child'), undefined);
    assert.equal(childB.child.autoCompacting, true);

    h.trace.length = 0;
    timers.fire(timerB);
    assert.equal(childB.child.autoCompacting, false);
    assert.deepEqual(h.trace, ['settle:c:parent-b/shared-child:active=false']);
  },
);

function targetId(
  target:
    | { appSessionId: string }
    | { appSessionId: string; parentAppSessionId: string; childSessionId: string },
): string {
  return 'parentAppSessionId' in target
    ? `c:${target.parentAppSessionId}/${target.childSessionId}`
    : `p:${target.appSessionId}`;
}

function resourceId(key: CompactionResourceKey): string {
  return key.kind === 'primary'
    ? `p:${key.appSessionId}`
    : `c:${key.parentAppSessionId}/${key.childSessionId}`;
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
