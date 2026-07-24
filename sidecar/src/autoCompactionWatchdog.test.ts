import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoCompactionWatchdogs } from './autoCompactionWatchdog.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('fires once after the deadline and forgets the timer', async () => {
  const fired: string[] = [];
  const dogs = new AutoCompactionWatchdogs((key) => fired.push(key));
  dogs.arm('s1', 10);
  await tick(30);
  assert.deepEqual(fired, ['s1']);
});

test('re-arming replaces the previous deadline instead of stacking timers', async () => {
  const fired: string[] = [];
  const dogs = new AutoCompactionWatchdogs((key) => fired.push(key));
  dogs.arm('s1', 10);
  dogs.arm('s1', 40);
  await tick(25);
  assert.deepEqual(fired, []);
  await tick(40);
  assert.deepEqual(fired, ['s1']);
});

test('clear and clearAll cancel pending watchdogs', async () => {
  const fired: string[] = [];
  const dogs = new AutoCompactionWatchdogs((key) => fired.push(key));
  dogs.arm('s1', 10);
  dogs.clear('s1');
  dogs.arm('s2', 10);
  dogs.arm('s3', 10);
  dogs.clearAll();
  await tick(30);
  assert.deepEqual(fired, []);
});
