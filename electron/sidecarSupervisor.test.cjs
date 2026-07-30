const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createSidecarSupervisor } = require('./sidecarSupervisor.cjs');

test('unexpected exits restart once with bounded exponential backoff', () => {
  const harness = createHarness();
  const supervisor = harness.createSupervisor();

  supervisor.start();
  supervisor.start();
  assert.equal(harness.children.length, 1);

  harness.children[0].emit('exit', 1, null);
  harness.children[0].emit('exit', 1, null);
  assert.deepEqual(harness.timerDelays(), [10]);

  harness.fireTimer(10);
  assert.equal(harness.children.length, 2);
  harness.children[1].emit('exit', 1, null);
  assert.deepEqual(harness.timerDelays(), [20]);

  harness.fireTimer(20);
  harness.children[2].emit('exit', 1, null);
  assert.deepEqual(harness.timerDelays(), [40]);

  harness.fireTimer(40);
  harness.children[3].emit('exit', 1, null);
  assert.deepEqual(harness.timerDelays(), [40]);
});

test('intentional stop cancels recovery and never restarts', () => {
  const active = createHarness();
  const activeSupervisor = active.createSupervisor();
  activeSupervisor.start();
  const child = active.children[0];

  activeSupervisor.stop();
  assert.equal(child.killed, true);
  assert.deepEqual(active.timerDelays(), []);
  child.emit('exit', 0, null);
  assert.deepEqual(active.timerDelays(), []);

  const pending = createHarness();
  const pendingSupervisor = pending.createSupervisor();
  pendingSupervisor.start();
  pending.children[0].emit('exit', 1, null);
  assert.deepEqual(pending.timerDelays(), [10]);
  pendingSupervisor.stop();
  assert.deepEqual(pending.timerDelays(), []);
  assert.equal(pending.children.length, 1);
});

test('readiness output and a stable runtime reset restart backoff', () => {
  const signaled = createHarness();
  const signaledSupervisor = signaled.createSupervisor();
  signaledSupervisor.start();
  signaled.children[0].emit('exit', 1, null);
  signaled.fireTimer(10);
  signaled.children[1].stdout.emit('data', 'SIDECAR_');
  signaled.children[1].stdout.emit('data', 'READY 8765\n');
  assert.deepEqual(signaled.timerDelays(), []);
  signaled.children[1].emit('exit', 1, null);
  assert.deepEqual(signaled.timerDelays(), [10]);

  const stable = createHarness();
  const stableSupervisor = stable.createSupervisor();
  stableSupervisor.start();
  stable.children[0].emit('exit', 1, null);
  stable.fireTimer(10);
  stable.fireTimer(100);
  stable.children[1].emit('exit', 1, null);
  assert.deepEqual(stable.timerDelays(), [10]);
});

function createHarness() {
  const children = [];
  const timers = new Map();
  let timerId = 0;

  return {
    children,
    createSupervisor: () =>
      createSidecarSupervisor({
        spawnProcess: () => {
          const child = new FakeChild();
          children.push(child);
          return child;
        },
        setTimeout: (callback, delayMs) => {
          const timer = { id: ++timerId, unref: () => undefined };
          timers.set(timer, { callback, delayMs });
          return timer;
        },
        clearTimeout: (timer) => {
          timers.delete(timer);
        },
        initialRestartDelayMs: 10,
        maxRestartDelayMs: 40,
        stableReadyMs: 100,
      }),
    timerDelays: () => [...timers.values()].map((timer) => timer.delayMs),
    fireTimer: (delayMs) => {
      const match = [...timers.entries()].find(([, timer]) => timer.delayMs === delayMs);
      assert.ok(match, `missing ${delayMs}ms timer`);
      const [handle, timer] = match;
      timers.delete(handle);
      timer.callback();
    },
  };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}
