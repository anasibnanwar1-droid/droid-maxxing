import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import {
  createSessionManagerTestContext,
  type SessionManagerTestContext,
} from './testing/sessionManagerTestContext.js';

interface ObservedTimer {
  timer: ReturnType<typeof setTimeout>;
  clears: number;
}

function observeTimers() {
  type TimerCallback = (...args: unknown[]) => void;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const intervals: ObservedTimer[] = [];
  const timeouts: ObservedTimer[] = [];

  Reflect.set(
    globalThis,
    'setInterval',
    (callback: TimerCallback, delay?: number, ...args: unknown[]) => {
      const timer = originalSetInterval(callback, delay, ...args);
      intervals.push({ timer, clears: 0 });
      return timer;
    },
  );
  Reflect.set(globalThis, 'clearInterval', (timer: ReturnType<typeof setInterval> | undefined) => {
    const observed = intervals.find((item) => item.timer === timer);
    if (observed) observed.clears += 1;
    originalClearInterval(timer);
  });
  Reflect.set(
    globalThis,
    'setTimeout',
    (callback: TimerCallback, delay?: number, ...args: unknown[]) => {
      const timer = originalSetTimeout(callback, delay, ...args);
      timeouts.push({ timer, clears: 0 });
      return timer;
    },
  );
  Reflect.set(globalThis, 'clearTimeout', (timer: ReturnType<typeof setTimeout> | undefined) => {
    const observed = timeouts.find((item) => item.timer === timer);
    if (observed) observed.clears += 1;
    originalClearTimeout(timer);
  });

  return {
    counts: () => [intervals.length, timeouts.length],
    restore: () => {
      Reflect.set(globalThis, 'setInterval', originalSetInterval);
      Reflect.set(globalThis, 'clearInterval', originalClearInterval);
      Reflect.set(globalThis, 'setTimeout', originalSetTimeout);
      Reflect.set(globalThis, 'clearTimeout', originalClearTimeout);
    },
  };
}

function notifyCompactionStarted(h: SessionManagerTestContext, providerSessionId: string): void {
  h.provider.emitNotification(providerSessionId, {
    jsonrpc: '2.0',
    method: 'droid.session_notification',
    params: {
      notification: {
        type: 'droid_working_state_changed',
        newState: 'compacting_conversation',
      },
    },
  });
}

async function createMissionWithChild(h: SessionManagerTestContext): Promise<FakeFactorySession> {
  await h.create({
    sessionPurpose: 'mission-control',
    clientRef: 'teardown',
    title: 'Teardown',
    goal: 'go',
    interactionMode: 'agi',
    autonomy: 'low',
  });
  await h.waitForIdle();
  const child = new FakeFactorySession('child-backend', {}, h.calls);
  h.history.seedChildSessions([
    {
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-logical',
      providerSessionId: 'child-backend',
      role: 'worker',
      status: 'paused',
      modelId: 'model-default',
      transcriptAvailable: true,
      updatedAt: Date.now(),
    },
  ]);
  h.runtime.loadQueue.set('child-backend', [child]);
  await h.handle({
    type: 'child.open',
    parentAppSessionId: 'provider-1',
    childSessionId: 'child-logical',
    requestId: 'open-child-logical',
  });
  return child;
}

async function exerciseLateChildUnwind(mode: 'close' | 'shutdown'): Promise<void> {
  const h = createSessionManagerTestContext();
  const timers = observeTimers();
  try {
    const child = await createMissionWithChild(h);
    const streamGate = child.deferNextStream();
    const contextGate = child.deferNextContextStats();
    const running = h.handle({
      type: 'child.send',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-logical',
      text: 'running',
    });
    await child.waitForPrompts(1);
    notifyCompactionStarted(h, 'child-backend');
    await h.handle({
      type: 'child.send',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-logical',
      text: 'must not drain',
    });

    if (mode === 'close') await h.handle({ type: 'session.close', appSessionId: 'provider-1' });
    else await h.shutdown();
    const timerCountsAfterTeardown = timers.counts();
    const eventCountAfterTeardown = h.events.length;
    const cleanupCountAfterTeardown = h.calls.filter(
      (call) =>
        call.target === 'cleanup' &&
        call.method === 'session.close' &&
        call.args[0] === 'child-backend',
    ).length;

    contextGate.resolve();
    streamGate.resolve();
    await running;
    await h.waitForIdle();

    assert.deepEqual(child.prompts, ['running']);
    assert.deepEqual(timers.counts(), timerCountsAfterTeardown);
    assert.equal(h.events.length, eventCountAfterTeardown);
    assert.equal(
      h.calls.filter(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'session.close' &&
          call.args[0] === 'child-backend',
      ).length,
      cleanupCountAfterTeardown,
    );
    assert.equal(cleanupCountAfterTeardown, 1);

    if (mode === 'shutdown') {
      await assert.rejects(h.handle({ type: 'sessions.list' }), /Session manager is shutting down/);
    }
  } finally {
    timers.restore();
    await h.dispose().catch(() => undefined);
  }
}

async function exerciseRejectedSteerAfterTeardown(mode: 'close' | 'shutdown'): Promise<void> {
  const h = createSessionManagerTestContext();
  try {
    const child = await createMissionWithChild(h);
    const streamGate = child.deferNextStream();
    const interruptGate = child.deferNextInterrupt();
    const running = h.handle({
      type: 'child.send',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-logical',
      text: 'running',
    });
    await child.waitForPrompts(1);

    const steering = h.handle({
      type: 'child.sendNow',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-logical',
      text: 'must not drain',
    });
    await h.waitForIdle();
    assert.equal(
      h.calls.filter(
        (call) =>
          call.target === 'provider' &&
          call.method === 'interrupt' &&
          call.args[0] === 'child-backend',
      ).length,
      1,
    );

    if (mode === 'close') await h.handle({ type: 'session.close', appSessionId: 'provider-1' });
    else await h.shutdown();
    const eventsAfterTeardown = h.events.length;

    interruptGate.reject(new Error('interrupt completed after teardown'));
    await steering;
    streamGate.resolve();
    await running;
    await h.waitForIdle();

    assert.deepEqual(child.prompts, ['running']);
    assert.equal(h.events.length, eventsAfterTeardown);
    assert.equal(
      h.events.some(
        (event) => event.type === 'child.error' && event.code === 'child.send_now_failed',
      ),
      false,
    );
    assert.equal(
      h.calls.filter(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'session.close' &&
          call.args[0] === 'child-backend',
      ).length,
      1,
    );
  } finally {
    await h.dispose().catch(() => undefined);
  }
}

test('late active-child unwind cannot restart work after close', { concurrency: false }, () =>
  exerciseLateChildUnwind('close'),
);

test('late active-child unwind cannot restart work after shutdown', { concurrency: false }, () =>
  exerciseLateChildUnwind('shutdown'),
);

test('late rejecting child steer is silent after close', () =>
  exerciseRejectedSteerAfterTeardown('close'));

test('late rejecting child steer is silent after shutdown', () =>
  exerciseRejectedSteerAfterTeardown('shutdown'));

test('shutdown marks later parents before blocked earlier cleanup', async () => {
  const h = createSessionManagerTestContext();
  const timers = observeTimers();
  try {
    const first = new FakeFactorySession('parent-a', {}, h.calls);
    const second = new FakeFactorySession('parent-b', {}, h.calls);
    h.runtime.createQueue.push(first, second);
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'parent-a',
      title: 'Parent A',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await first.waitForPrompts(1);
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'parent-b',
      title: 'Parent B',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await second.waitForPrompts(1);
    await h.waitForIdle();

    const child = new FakeFactorySession('child-b-backend', {}, h.calls);
    h.history.seedChildSessions([
      {
        parentAppSessionId: 'parent-b',
        childSessionId: 'child-b-logical',
        providerSessionId: 'child-b-backend',
        role: 'worker',
        status: 'paused',
        modelId: 'model-default',
        transcriptAvailable: true,
        updatedAt: Date.now(),
      },
    ]);
    h.runtime.loadQueue.set('child-b-backend', [child]);
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'parent-b',
      childSessionId: 'child-b-logical',
      requestId: 'open-child-b-logical',
    });
    const streamGate = child.deferNextStream();
    const contextGate = child.deferNextContextStats();
    const running = h.handle({
      type: 'child.send',
      parentAppSessionId: 'parent-b',
      childSessionId: 'child-b-logical',
      text: 'running on B',
    });
    await child.waitForPrompts(1);
    notifyCompactionStarted(h, 'child-b-backend');

    const firstCloseGate = first.deferNextClose();
    const shutdown = h.shutdown();
    await h.waitForIdle();
    const timersWhileFirstBlocked = timers.counts();
    const eventsWhileFirstBlocked = h.events.length;

    contextGate.resolve();
    streamGate.resolve();
    await running;
    await h.waitForIdle();
    assert.deepEqual(child.prompts, ['running on B']);
    assert.deepEqual(timers.counts(), timersWhileFirstBlocked);
    assert.equal(h.events.length, eventsWhileFirstBlocked);
    assert.equal(
      h.calls.some(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'session.close' &&
          call.args[0] === 'parent-b',
      ),
      false,
    );

    firstCloseGate.resolve();
    await shutdown;
  } finally {
    timers.restore();
    await h.dispose().catch(() => undefined);
  }
});

test('shutdown is single-flight and finalizers continue after failure', async () => {
  const h = createSessionManagerTestContext();
  h.browsers.nextCloseAllError = new Error('browser closeAll failed');
  h.history.nextCloseError = new Error('history close failed');

  const results = await Promise.allSettled([h.shutdown(), h.shutdown()]);
  assert.deepEqual(
    results.map((result) => result.status),
    ['rejected', 'rejected'],
  );
  assert.equal(
    h.calls.filter((call) => call.target === 'cleanup' && call.method === 'browser.closeAll')
      .length,
    1,
  );
  assert.equal(
    h.calls.filter((call) => call.target === 'cleanup' && call.method === 'history.close').length,
    1,
  );
  assert.match(
    results[0]?.status === 'rejected' ? String(results[0].reason) : '',
    /browser closeAll failed/,
  );

  await h.dispose().catch(() => undefined);
});
