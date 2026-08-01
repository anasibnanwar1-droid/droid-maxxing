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

test('a stop requested by failure handling cancels the scheduled restart', () => {
  let supervisor;
  const harness = createHarness({
    onUnexpectedExit: () => supervisor.stop(),
  });
  supervisor = harness.createSupervisor();

  supervisor.start();
  harness.children[0].emit('exit', 1, null);

  assert.deepEqual(harness.timerDelays(), []);
  assert.equal(harness.children.length, 1);
});

test('only a stable runtime resets restart backoff', () => {
  const signaled = createHarness();
  const signaledSupervisor = signaled.createSupervisor();
  signaledSupervisor.start();
  signaled.children[0].emit('exit', 1, null);
  signaled.fireTimer(10);
  signaled.children[1].stdout.emit('data', 'SIDECAR_');
  signaled.children[1].stdout.emit('data', 'READY 8765\n');
  assert.deepEqual(signaled.timerDelays(), [100]);
  signaled.children[1].emit('exit', 1, null);
  assert.deepEqual(signaled.timerDelays(), [20]);

  const stable = createHarness();
  const stableSupervisor = stable.createSupervisor();
  stableSupervisor.start();
  stable.children[0].emit('exit', 1, null);
  stable.fireTimer(10);
  stable.fireTimer(100);
  stable.children[1].emit('exit', 1, null);
  assert.deepEqual(stable.timerDelays(), [10]);
});

test('repeated ready-then-crash cycles still trip the circuit breaker', () => {
  const harness = createHarness({ maxConsecutiveFailures: 3 });
  const supervisor = harness.createSupervisor();

  supervisor.start();
  for (const [index, delayMs] of [10, 20].entries()) {
    harness.children[index].stdout.emit('data', 'SIDECAR_READY 8765\n');
    harness.children[index].emit('exit', 1, null);
    assert.deepEqual(harness.timerDelays(), [delayMs]);
    harness.fireTimer(delayMs);
  }
  harness.children[2].stdout.emit('data', 'SIDECAR_READY 8765\n');
  harness.children[2].emit('exit', 1, null);

  assert.deepEqual(harness.timerDelays(), []);
  assert.equal(harness.terminalFailures[0].failureCount, 3);
});

test('consecutive startup failures trip once and require an explicit restart', () => {
  const harness = createHarness({ maxConsecutiveFailures: 3 });
  const supervisor = harness.createSupervisor();

  supervisor.start();
  harness.children[0].emit('exit', 1, null);
  assert.deepEqual(harness.timerDelays(), [10]);
  assert.equal(harness.unexpectedExits[0].failureCount, 1);

  harness.fireTimer(10);
  harness.children[1].emit('exit', 2, null);
  assert.deepEqual(harness.timerDelays(), [20]);
  assert.equal(harness.unexpectedExits[1].failureCount, 2);

  harness.fireTimer(20);
  harness.children[2].emit('exit', 3, null);
  harness.children[2].emit('error', new Error('duplicate terminal signal'));

  assert.deepEqual(harness.timerDelays(), []);
  assert.equal(harness.children.length, 3);
  assert.deepEqual(harness.terminalFailures, [{ code: 3, signal: null, failureCount: 3 }]);

  supervisor.start();
  assert.equal(harness.children.length, 4, 'an explicit start rearms the supervisor');
  harness.children[3].emit('exit', 4, null);
  assert.deepEqual(harness.timerDelays(), [10]);
  assert.equal(harness.unexpectedExits.at(-1).failureCount, 1);
});

test('synchronous spawn failures use the same terminal failure ceiling', () => {
  const harness = createHarness({ maxConsecutiveFailures: 2, spawnFailures: 2 });
  const supervisor = harness.createSupervisor();

  supervisor.start();
  assert.deepEqual(harness.timerDelays(), [10]);
  harness.fireTimer(10);

  assert.deepEqual(harness.timerDelays(), []);
  assert.equal(harness.terminalFailures.length, 1);
  assert.match(harness.terminalFailures[0].error.message, /spawn failure 2/);
  assert.equal(harness.terminalFailures[0].failureCount, 2);
});

function createHarness(options = {}) {
  const children = [];
  const timers = new Map();
  const unexpectedExits = [];
  const terminalFailures = [];
  let timerId = 0;
  let spawnAttempts = 0;

  return {
    children,
    unexpectedExits,
    terminalFailures,
    createSupervisor: () =>
      createSidecarSupervisor({
        spawnProcess: () => {
          spawnAttempts += 1;
          if (spawnAttempts <= (options.spawnFailures ?? 0)) {
            throw new Error(`spawn failure ${spawnAttempts}`);
          }
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
        maxConsecutiveFailures: options.maxConsecutiveFailures ?? 5,
        onUnexpectedExit: (details) => {
          unexpectedExits.push(details);
          options.onUnexpectedExit?.(details);
        },
        onTerminalFailure: (details) => terminalFailures.push(details),
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
