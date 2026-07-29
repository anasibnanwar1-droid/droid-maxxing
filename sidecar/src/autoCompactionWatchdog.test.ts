import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoCompactionWatchdogs } from './autoCompactionWatchdog.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('fires once after the deadline and forgets the timer', async () => {
  const fired: string[] = [];
  const dogs = new AutoCompactionWatchdogs<string>(
    (key) => key,
    (key) => fired.push(key),
  );
  dogs.arm('s1', 10);
  await tick(30);
  assert.deepEqual(fired, ['s1']);
});

test('re-arming replaces the previous deadline instead of stacking timers', async () => {
  const fired: string[] = [];
  const dogs = new AutoCompactionWatchdogs<string>(
    (key) => key,
    (key) => fired.push(key),
  );
  dogs.arm('s1', 10);
  dogs.arm('s1', 40);
  await tick(25);
  assert.deepEqual(fired, []);
  await tick(40);
  assert.deepEqual(fired, ['s1']);
});

test('clear and clearAll cancel pending watchdogs', async () => {
  const fired: string[] = [];
  const dogs = new AutoCompactionWatchdogs<string>(
    (key) => key,
    (key) => fired.push(key),
  );
  dogs.arm('s1', 10);
  dogs.clear('s1');
  dogs.arm('s2', 10);
  dogs.arm('s3', 10);
  dogs.clearAll();
  await tick(30);
  assert.deepEqual(fired, []);
});

test('a queued stale callback cannot expire or delete a replacement watchdog', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [
    originalSetTimeout(() => undefined, 60_000),
    originalSetTimeout(() => undefined, 60_000),
  ];
  for (const timer of timers) originalClearTimeout(timer);
  const queuedCallbacks: (() => void)[] = [];
  Reflect.set(globalThis, 'setTimeout', (callback: () => void) => {
    queuedCallbacks.push(callback);
    return timers[queuedCallbacks.length - 1];
  });
  Reflect.set(globalThis, 'clearTimeout', () => undefined);
  try {
    const fired: string[] = [];
    const dogs = new AutoCompactionWatchdogs<string>(
      (key) => key,
      (key) => fired.push(key),
    );
    dogs.arm('queued', 10);
    dogs.clearAll();
    dogs.arm('queued', 10);
    queuedCallbacks[0]?.();
    assert.deepEqual(fired, []);
    assert.equal(dogs.isArmed('queued'), true);
    queuedCallbacks[1]?.();
    assert.deepEqual(fired, ['queued']);
    assert.equal(dogs.isArmed('queued'), false);
  } finally {
    Reflect.set(globalThis, 'setTimeout', originalSetTimeout);
    Reflect.set(globalThis, 'clearTimeout', originalClearTimeout);
  }
});
