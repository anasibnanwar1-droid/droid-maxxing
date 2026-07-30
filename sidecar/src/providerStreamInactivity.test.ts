import assert from 'node:assert/strict';
import test from 'node:test';
import {
  guardProviderStream,
  ProviderStreamInactivityError,
  type ScheduleInactivityTimer,
} from './providerStreamInactivity.js';

interface ScheduledTimer {
  callback: () => void;
  cancelled: boolean;
}

function createTimerHarness() {
  const timers: ScheduledTimer[] = [];
  const scheduleTimer: ScheduleInactivityTimer = (callback) => {
    const timer = { callback, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return {
    timers,
    scheduleTimer,
    fire(index: number) {
      const timer = timers[index];
      assert.ok(timer);
      if (!timer.cancelled) timer.callback();
    },
  };
}

test('an inactive provider stream aborts and releases the waiting turn', async () => {
  const timers = createTimerHarness();
  let providerSignal: AbortSignal | undefined;
  let releaseInterrupt = (): void => undefined;
  const interruptSettlement = new Promise<void>((resolve) => {
    releaseInterrupt = resolve;
  });
  let releaseProvider = (): void => undefined;
  const providerSettlement = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  let interruptStarted = false;
  const stream = guardProviderStream(
    async function* (abortSignal) {
      providerSignal = abortSignal;
      await providerSettlement;
      yield undefined;
    },
    new AbortController().signal,
    {
      timeoutMs: 120_000,
      scheduleTimer: timers.scheduleTimer,
      settleInactivity: () => {
        interruptStarted = true;
        return interruptSettlement.then(() => {
          releaseProvider();
        });
      },
    },
  );

  const waiting = stream.next();
  assert.equal(timers.timers.length, 1);
  timers.fire(0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(interruptStarted, true);
  assert.equal(providerSignal?.aborted, false);
  releaseInterrupt();
  await assert.rejects(waiting, ProviderStreamInactivityError);
  assert.equal(providerSignal?.aborted, false);
  assert.equal(timers.timers[0]?.cancelled, true);
});

test('failed inactivity settlement aborts locally and propagates the recovery failure', async () => {
  const timers = createTimerHarness();
  let providerSignal: AbortSignal | undefined;
  const stream = guardProviderStream(
    async function* (abortSignal) {
      providerSignal = abortSignal;
      await new Promise<void>(() => undefined);
      yield undefined;
    },
    new AbortController().signal,
    {
      timeoutMs: 120_000,
      scheduleTimer: timers.scheduleTimer,
      settleInactivity: () => Promise.reject(new Error('interrupt failed')),
    },
  );

  const waiting = stream.next();
  timers.fire(0);

  await assert.rejects(waiting, /interrupt failed/);
  assert.equal(providerSignal?.aborted, true);
});

test('each provider event replaces the previous inactivity deadline', async () => {
  const timers = createTimerHarness();
  let releaseSecond = (): void => undefined;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const stream = guardProviderStream(
    async function* () {
      yield 'first';
      await secondGate;
      yield 'second';
    },
    new AbortController().signal,
    { timeoutMs: 120_000, scheduleTimer: timers.scheduleTimer },
  );

  assert.deepEqual(await stream.next(), { done: false, value: 'first' });
  assert.equal(timers.timers[0]?.cancelled, true);
  const second = stream.next();
  assert.equal(timers.timers.length, 2);
  timers.fire(0);
  releaseSecond();
  assert.deepEqual(await second, { done: false, value: 'second' });
  assert.equal(timers.timers[1]?.cancelled, true);
  assert.deepEqual(await stream.next(), { done: true, value: undefined });
  assert.equal(timers.timers[2]?.cancelled, true);
});

test('a parent Stop abort is forwarded without waiting for the watchdog', async () => {
  const timers = createTimerHarness();
  const parentAbortController = new AbortController();
  let providerSignal: AbortSignal | undefined;
  const stream = guardProviderStream(
    async function* (abortSignal) {
      providerSignal = abortSignal;
      await new Promise<void>(() => undefined);
      yield undefined;
    },
    parentAbortController.signal,
    { timeoutMs: 120_000, scheduleTimer: timers.scheduleTimer },
  );

  const waiting = stream.next();
  const stopped = new Error('user stopped');
  parentAbortController.abort(stopped);

  await assert.rejects(waiting, stopped);
  assert.equal(providerSignal?.reason, stopped);
  assert.equal(timers.timers[0]?.cancelled, true);
});

test('consumer exit aborts and closes the owned provider iterator', async () => {
  const timers = createTimerHarness();
  let providerSignal: AbortSignal | undefined;
  let providerClosed = false;
  const stream = guardProviderStream(
    async function* (abortSignal) {
      providerSignal = abortSignal;
      try {
        yield 'event';
        await new Promise<void>(() => undefined);
      } finally {
        providerClosed = true;
      }
    },
    new AbortController().signal,
    { timeoutMs: 120_000, scheduleTimer: timers.scheduleTimer },
  );

  assert.deepEqual(await stream.next(), { done: false, value: 'event' });
  await stream.return();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(providerSignal?.aborted, true);
  assert.equal(providerClosed, true);
});
