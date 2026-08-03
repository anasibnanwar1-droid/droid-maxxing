const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSidecarSupervisor } = require('./sidecar.cjs');

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function harness(children) {
  const calls = [];
  const supervisor = createSidecarSupervisor({
    entryPath: () => '/app/sidecar.mjs',
    cwd: () => '/app',
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      const child = children.shift();
      assert.ok(child);
      return child;
    },
  });
  return { supervisor, calls };
}

test('sidecar binds an OS-assigned port and shares one concurrent startup', async () => {
  const child = fakeChild();
  const { supervisor, calls } = harness([child]);
  const first = supervisor.getBridgeInfo();
  const second = supervisor.getBridgeInfo();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ['/app/sidecar.mjs']);
  assert.equal(calls[0].options.env.BRIDGE_PORT, '0');
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.match(calls[0].options.env.BRIDGE_TOKEN, /^[a-f0-9]{64}$/);
  assert.match(calls[0].options.env.BROWSER_ASSET_TOKEN, /^[a-f0-9]{64}$/);
  assert.notEqual(calls[0].options.env.BROWSER_ASSET_TOKEN, calls[0].options.env.BRIDGE_TOKEN);

  child.stdout.write('SIDECAR_READY 43123\n');
  assert.deepEqual(await first, await second);
  assert.equal((await first).port, 43123);
});

test('sidecar startup reports stderr when the child exits before ready', async () => {
  const child = fakeChild();
  const { supervisor } = harness([child]);
  const pending = supervisor.start();
  child.stderr.write('listen EADDRINUSE\n');
  child.emit('exit', 1, null);
  await assert.rejects(pending, /Sidecar exited before ready/);
});

test('stopping allows a later renderer to start a fresh sidecar', async () => {
  const firstChild = fakeChild();
  const secondChild = fakeChild();
  const { supervisor, calls } = harness([firstChild, secondChild]);
  const first = supervisor.start();
  firstChild.stdout.write('SIDECAR_READY 43001\n');
  await first;

  supervisor.stop();
  assert.equal(firstChild.killed, true);

  const second = supervisor.start();
  secondChild.stdout.write('SIDECAR_READY 43002\n');
  assert.equal((await second).port, 43002);
  assert.equal(calls.length, 2);
});

test('stop during startup invalidates the old child before an immediate restart', async () => {
  const firstChild = fakeChild();
  const secondChild = fakeChild();
  const { supervisor, calls } = harness([firstChild, secondChild]);
  const first = supervisor.start();

  supervisor.stop();
  const second = supervisor.start();

  firstChild.stdout.write('SIDECAR_READY 43001\n');
  firstChild.emit('exit', null, 'SIGTERM');
  secondChild.stdout.write('SIDECAR_READY 43002\n');

  await assert.rejects(first, /cancelled/);
  assert.equal((await second).port, 43002);
  assert.equal((await supervisor.getBridgeInfo()).port, 43002);
  assert.equal(calls.length, 2);
});

test('intentional shutdown is not reported as a crash', async () => {
  const child = fakeChild();
  const stderr = new PassThrough();
  let diagnostics = '';
  stderr.on('data', (chunk) => {
    diagnostics += String(chunk);
  });
  const supervisor = createSidecarSupervisor({
    entryPath: () => '/app/sidecar.mjs',
    cwd: () => '/app',
    stdout: new PassThrough(),
    stderr,
    spawnProcess: () => child,
  });
  const started = supervisor.start();
  child.stdout.write('SIDECAR_READY 43001\n');
  await started;

  supervisor.stop();
  child.emit('exit', null, 'SIGTERM');

  assert.equal(diagnostics, '');
});
