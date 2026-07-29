import { ProgressLogEntryType } from '@factory/droid-sdk';

import { FakeFactorySession } from './fakeFactoryRuntime.js';
import {
  createSessionManagerTestContext,
  type SessionManagerTestContext,
} from './sessionManagerTestContext.js';

function daemonCompactionNotification(kind: 'started' | 'completed'): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'droid.session_notification',
    params: {
      notification:
        kind === 'started'
          ? { type: 'droid_working_state_changed', newState: 'compacting_conversation' }
          : {
              type: 'session_compacted',
              summaryId: 'summary-1',
              removedCount: 1,
              visibleBoundaryMessageId: null,
            },
    },
  };
}

function notifyCompaction(
  h: SessionManagerTestContext,
  sessionId: string,
  kind: 'started' | 'completed',
): void {
  h.provider.emitNotification(sessionId, daemonCompactionNotification(kind));
}

export function seedInitModel(session: FakeFactorySession, modelId: string): void {
  session.setInitModel(modelId);
}

function seedChild(
  h: SessionManagerTestContext,
  parentAppSessionId: string,
  childSessionId: string,
  providerSessionId: string,
): void {
  h.history.seedChildSessions([
    {
      parentAppSessionId,
      childSessionId,
      providerSessionId,
      role: 'worker',
      status: 'paused',
      modelId: 'model-default',
      spawnLink: { kind: 'spawn', id: `spawn-${childSessionId}` },
      transcriptAvailable: true,
      updatedAt: Date.now(),
    },
  ]);
}

interface ObservedWatchdog {
  timer: ReturnType<typeof setTimeout>;
  callback: (...args: unknown[]) => void;
  clears: number;
}

function observeCompactionTimers() {
  type TimerCallback = (...args: unknown[]) => void;
  const intervals = new Map<ReturnType<typeof setInterval>, number>();
  const watchdogs: ObservedWatchdog[] = [];
  const setInterval = globalThis.setInterval;
  const clearInterval = globalThis.clearInterval;
  const setTimeout = globalThis.setTimeout;
  const clearTimeout = globalThis.clearTimeout;

  Reflect.set(
    globalThis,
    'setInterval',
    (callback: TimerCallback, delay?: number, ...args: unknown[]) => {
      const timer = setInterval(callback, delay, ...args);
      intervals.set(timer, 0);
      return timer;
    },
  );
  Reflect.set(globalThis, 'clearInterval', (timer: ReturnType<typeof setInterval> | undefined) => {
    if (timer !== undefined && intervals.has(timer))
      intervals.set(timer, (intervals.get(timer) ?? 0) + 1);
    clearInterval(timer);
  });
  Reflect.set(
    globalThis,
    'setTimeout',
    (callback: TimerCallback, delay?: number, ...args: unknown[]) => {
      const timer = setTimeout(callback, delay, ...args);
      watchdogs.push({ timer, callback, clears: 0 });
      return timer;
    },
  );
  Reflect.set(globalThis, 'clearTimeout', (timer: ReturnType<typeof setTimeout> | undefined) => {
    const watchdog = watchdogs.find((record) => record.timer === timer);
    if (watchdog) watchdog.clears += 1;
    clearTimeout(timer);
  });

  return {
    counts: () => [intervals.size, watchdogs.length],
    latestInterval: () => [...intervals.keys()].at(-1),
    latestWatchdog: () => watchdogs.at(-1),
    intervalClears: (timer: ReturnType<typeof setInterval>) => intervals.get(timer),
    fire: (watchdog: ObservedWatchdog) => {
      clearTimeout(watchdog.timer);
      watchdog.callback();
    },
    restore: () => {
      Reflect.set(globalThis, 'setInterval', setInterval);
      Reflect.set(globalThis, 'clearInterval', clearInterval);
      Reflect.set(globalThis, 'setTimeout', setTimeout);
      Reflect.set(globalThis, 'clearTimeout', clearTimeout);
    },
  };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

export function contextUpdateCount(h: SessionManagerTestContext, sessionId: string): number {
  return h.events.filter(
    (event) => event.type === 'context.updated' && event.sourceSessionId === sessionId,
  ).length;
}

export async function runAutoCompactionScenario(h: SessionManagerTestContext) {
  const parent = new FakeFactorySession('provider-1', {}, h.calls);
  h.runtime.createQueue.push(parent);
  await h.create({
    sessionPurpose: 'mission-control',
    clientRef: 'c4',
    title: 'C4',
    goal: 'go',
    interactionMode: 'agi',
    autonomy: 'low',
  });
  await h.waitForIdle();
  seedChild(h, 'provider-1', 'child-c4', 'worker-c4');
  await h.handle({
    type: 'child.open',
    parentAppSessionId: 'provider-1',
    childSessionId: 'child-c4',
    requestId: 'open-child-c4',
  });
  notifyCompaction(h, 'provider-1', 'started');
  notifyCompaction(h, 'worker-c4', 'started');
  await h.handle({ type: 'session.interrupt', appSessionId: 'provider-1' });
  await h.handle({
    type: 'child.interrupt',
    parentAppSessionId: 'provider-1',
    childSessionId: 'child-c4',
  });
  const interruptCounts = () => [
    h.calls.filter(
      (call) =>
        call.target === 'provider' && call.method === 'interrupt' && call.args[0] === 'provider-1',
    ).length,
    h.calls.filter(
      (call) =>
        call.target === 'provider' && call.method === 'interrupt' && call.args[0] === 'worker-c4',
    ).length,
  ];
  const interruptsAfterExplicitCommands = interruptCounts();
  const parentGate = h.provider.deferNextStream('provider-1');
  const parentRun = h.handle({
    type: 'session.send',
    appSessionId: 'provider-1',
    text: 'parent running',
  });
  await h.provider.waitForPrompts('provider-1', 2);
  const parentSteerGate = h.provider.deferNextStream('provider-1');
  const parentQueuedGate = h.provider.deferNextStream('provider-1');
  const workerGate = h.provider.deferNextStream('worker-c4');
  const workerRun = h.handle({
    type: 'child.send',
    parentAppSessionId: 'provider-1',
    childSessionId: 'child-c4',
    text: 'worker running',
  });
  await h.provider.waitForPrompts('worker-c4', 1);
  parent.queueStreamEvents([
    {
      type: 'mission_progress_entry',
      progressLog: [
        {
          type: ProgressLogEntryType.WorkerStarted,
          timestamp: '2026-07-29T00:00:00.000Z',
          workerSessionId: 'worker-c4',
          spawnId: 'spawn-child-c4',
        },
      ],
    },
    { type: 'mission_worker_completed', workerSessionId: 'worker-c4', exitCode: 0 },
  ]);
  const workerSteerGate = h.provider.deferNextStream('worker-c4');
  const workerQueuedGate = h.provider.deferNextStream('worker-c4');
  notifyCompaction(h, 'provider-1', 'started');
  notifyCompaction(h, 'worker-c4', 'started');
  await h.handle({ type: 'session.send', appSessionId: 'provider-1', text: 'parent queued' });
  await h.handle({
    type: 'child.send',
    parentAppSessionId: 'provider-1',
    childSessionId: 'child-c4',
    text: 'worker queued',
  });
  await h.handle({ type: 'session.sendNow', appSessionId: 'provider-1', text: 'parent steer' });
  await h.handle({
    type: 'child.sendNow',
    parentAppSessionId: 'provider-1',
    childSessionId: 'child-c4',
    text: 'worker steer',
  });
  const contextsBefore = [contextUpdateCount(h, 'provider-1'), contextUpdateCount(h, 'child-c4')];
  notifyCompaction(h, 'provider-1', 'completed');
  notifyCompaction(h, 'worker-c4', 'completed');
  const countClose = () =>
    h.calls.filter(
      (call) =>
        call.target === 'cleanup' &&
        call.method === 'session.close' &&
        call.args[0] === 'worker-c4',
    ).length;
  const closeCounts = [countClose()];
  parentGate.resolve();
  await parentRun;
  await h.provider.waitForPrompts('provider-1', 3);
  closeCounts.push(countClose());
  parentSteerGate.resolve();
  await h.provider.waitForPrompts('provider-1', 4);
  parentQueuedGate.resolve();
  workerGate.resolve();
  await workerRun;
  await h.provider.waitForPrompts('worker-c4', 2);
  closeCounts.push(countClose());
  workerSteerGate.resolve();
  await h.provider.waitForPrompts('worker-c4', 3);
  workerQueuedGate.resolve();
  await h.waitForIdle();
  return {
    closeCounts,
    contextsBefore,
    interruptsAfterExplicitCommands,
    interruptsAfterSteering: interruptCounts(),
  };
}

function liveCleanupCounts(
  h: SessionManagerTestContext,
  parentProviderSessionId: string,
  childSessionId: string,
): number[] {
  const count = (method: string, sessionId: string) =>
    h.calls.filter(
      (call) => call.target === 'cleanup' && call.method === method && call.args[0] === sessionId,
    ).length;
  return [
    count('session.close', parentProviderSessionId),
    count('session.close', childSessionId),
    count('unsubscribe', parentProviderSessionId),
    count('unsubscribe', childSessionId),
    h.mcpServerCloseCalls,
  ];
}

const cleanupMethodCount = (h: SessionManagerTestContext, method: string) =>
  h.calls.filter((call) => call.target === 'cleanup' && call.method === method).length;

export async function runCloseCleanupScenario() {
  const h = createSessionManagerTestContext();
  const timers = observeCompactionTimers();
  let disposed = false;
  const parentKey = 'provider-1';
  const workerKey = 'worker-c6-key';
  const workerLogical = 'child-c6';
  const workerLive = 'worker-c6-live';
  const parentGate = h.runtime.deferNextCreateStream(parentKey);
  h.runtime.loadQueue.set(workerKey, [new FakeFactorySession(workerLive, {}, h.calls)]);
  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'c6',
      title: 'C6',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await h.provider.waitForPrompts(parentKey, 1);
    const initialParentPoller = required(timers.latestInterval(), 'initial parent poller');
    seedChild(h, parentKey, workerLogical, workerKey);
    await h.handle({
      type: 'child.open',
      parentAppSessionId: parentKey,
      childSessionId: workerLogical,
      requestId: 'open-child-c6',
    });
    const workerGate = h.provider.deferNextStream(workerLive);
    void h.handle({
      type: 'child.send',
      parentAppSessionId: parentKey,
      childSessionId: workerLogical,
      text: 'worker running',
    });
    await h.provider.waitForPrompts(workerLive, 1);
    const initialWorkerPoller = required(timers.latestInterval(), 'initial worker poller');
    notifyCompaction(h, parentKey, 'started');
    const parentStart = required(timers.latestWatchdog(), 'parent watchdog');
    notifyCompaction(h, workerLive, 'started');
    const workerStart = required(timers.latestWatchdog(), 'worker watchdog');
    const parentStartUntouchedByWorkerStart = parentStart.clears === 0;
    const watchdogHandlesDistinct = parentStart.timer !== workerStart.timer;
    await h.handle({ type: 'session.send', appSessionId: parentKey, text: 'parent buffered' });
    await h.handle({
      type: 'child.send',
      parentAppSessionId: parentKey,
      childSessionId: workerLogical,
      text: 'worker buffered',
    });

    parentGate.resolve();
    await h.waitForIdle();
    const parentRearm = required(timers.latestWatchdog(), 'parent rearm');
    workerGate.resolve();
    await h.waitForIdle();
    const workerRearm = required(timers.latestWatchdog(), 'worker rearm');
    const initialClearState = [
      parentStart.clears,
      workerStart.clears,
      timers.intervalClears(initialParentPoller),
      timers.intervalClears(initialWorkerPoller),
    ];

    h.provider.deferNextStream(parentKey);
    h.provider.deferNextStream(workerLive);
    timers.fire(parentRearm);
    await h.provider.waitForPrompts(parentKey, 2);
    const parentClosePoller = required(timers.latestInterval(), 'replacement parent poller');
    timers.fire(workerRearm);
    await h.provider.waitForPrompts(workerLive, 2);
    const workerClosePoller = required(timers.latestInterval(), 'replacement worker poller');
    notifyCompaction(h, parentKey, 'started');
    const parentCloseWatchdog = required(timers.latestWatchdog(), 'close parent watchdog');
    notifyCompaction(h, workerLive, 'started');
    const workerCloseWatchdog = required(timers.latestWatchdog(), 'close worker watchdog');
    const watchdogsActiveAtClose = [parentCloseWatchdog.clears, workerCloseWatchdog.clears];

    await h.handle({ type: 'session.close', appSessionId: parentKey });
    const cleanupAtClose = liveCleanupCounts(h, parentKey, workerLive);
    const closeTimerState = [
      timers.intervalClears(parentClosePoller),
      timers.intervalClears(workerClosePoller),
      parentCloseWatchdog.clears,
      workerCloseWatchdog.clears,
    ];
    // Leave these gates held: post-close worker stream unwind is a Refactor PR 5 regression.
    await h.dispose();
    disposed = true;
    return {
      browserClose: cleanupMethodCount(h, 'browser.close'),
      browserCloseAll: cleanupMethodCount(h, 'browser.closeAll'),
      cleanupAfterShutdown: liveCleanupCounts(h, parentKey, workerLive),
      cleanupAtClose,
      historyClose: cleanupMethodCount(h, 'history.close'),
      initialPollersDistinct: initialParentPoller !== initialWorkerPoller,
      initialClearState,
      parentStartUntouchedByWorkerStart,
      watchdogHandlesDistinct,
      replacementPollersDistinct: parentClosePoller !== workerClosePoller,
      watchdogsActiveAtClose,
      closeTimerState,
    };
  } finally {
    if (!disposed) await h.dispose();
    timers.restore();
  }
}

export async function runShutdownOnlyCleanupScenario() {
  const h = createSessionManagerTestContext();
  const timers = observeCompactionTimers();
  let disposed = false;
  const parentKey = 'provider-1';
  const workerKey = 'worker-shutdown-key';
  const workerLogical = 'child-shutdown';
  const workerLive = 'worker-shutdown-live';
  h.runtime.deferNextCreateStream(parentKey);
  h.runtime.loadQueue.set(workerKey, [new FakeFactorySession(workerLive, {}, h.calls)]);
  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'c6-shutdown',
      title: 'C6 shutdown',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await h.provider.waitForPrompts(parentKey, 1);
    const parentPoller = required(timers.latestInterval(), 'shutdown parent poller');
    seedChild(h, parentKey, workerLogical, workerKey);
    await h.handle({
      type: 'child.open',
      parentAppSessionId: parentKey,
      childSessionId: workerLogical,
      requestId: 'open-child-shutdown',
    });
    h.provider.deferNextStream(workerLive);
    void h.handle({
      type: 'child.send',
      parentAppSessionId: parentKey,
      childSessionId: workerLogical,
      text: 'worker running',
    });
    await h.provider.waitForPrompts(workerLive, 1);
    const workerPoller = required(timers.latestInterval(), 'shutdown worker poller');
    notifyCompaction(h, parentKey, 'started');
    const parentWatchdog = required(timers.latestWatchdog(), 'shutdown parent watchdog');
    notifyCompaction(h, workerLive, 'started');
    const workerWatchdog = required(timers.latestWatchdog(), 'shutdown worker watchdog');

    await h.dispose();
    disposed = true;
    const cleanup = liveCleanupCounts(h, parentKey, workerLive);
    const timerClears = [
      timers.intervalClears(parentPoller),
      timers.intervalClears(workerPoller),
      parentWatchdog.clears,
      workerWatchdog.clears,
    ];
    const browserCounts = [
      cleanupMethodCount(h, 'browser.close'),
      cleanupMethodCount(h, 'browser.closeAll'),
    ];
    const historyClose = cleanupMethodCount(h, 'history.close');
    return { browserCounts, cleanup, historyClose, timerClears };
  } finally {
    if (!disposed) await h.dispose();
    timers.restore();
  }
}
