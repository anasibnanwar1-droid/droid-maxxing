import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const fixturePath = fileURLToPath(
  new URL('../test-fixtures/childSessionsSidecar.mjs', import.meta.url),
);

async function startFixture(
  logPath: string,
  overrides: NodeJS.ProcessEnv = {},
  onSpawn: (child: ChildProcessWithoutNullStreams) => void = () => undefined,
): Promise<{ process: ChildProcessWithoutNullStreams; port: number }> {
  const child = spawn(process.execPath, [fixturePath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BRIDGE_PORT: '0',
      BRIDGE_TOKEN: '',
      BRIDGE_EXIT_ON_STDIN_CLOSE: '1',
      CHILD_SESSIONS_SMOKE_ALLOW_ANY_TOKEN: '1',
      CHILD_SESSIONS_SMOKE_LOG: logPath,
      ...overrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  onSpawn(child);
  return new Promise((resolveReady, reject) => {
    let output = '';
    let errorOutput = '';
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };
    child.once('error', fail);
    child.once('exit', (code) =>
      fail(
        new Error(
          `Fixture exited before ready (${code}).${errorOutput ? ` ${errorOutput.trim()}` : ''}`,
        ),
      ),
    );
    child.stderr.on('data', (chunk) => {
      errorOutput += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const match = output.match(/SIDECAR_READY (\d+)/);
      if (!match) return;
      settled = true;
      child.removeListener('error', fail);
      child.removeAllListeners('exit');
      resolveReady({ process: child, port: Number(match[1]) });
    });
  });
}

function openSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/?token=fixture`);
  return new Promise((resolveOpen, reject) => {
    socket.once('open', () => resolveOpen(socket));
    socket.once('error', reject);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolveExit());
  });
}

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out.`)), 5_000);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test('fixture binds OS-assigned ports and exits with connected clients', async (t) => {
  const directory = mkdtempSync(`${tmpdir()}/droid-child-fixture-`);
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const first = await startFixture(`${directory}/first.jsonl`);
  t.after(() => {
    first.process.kill();
  });
  const second = await startFixture(`${directory}/second.jsonl`);
  t.after(() => {
    second.process.kill();
  });
  assert.notEqual(first.port, second.port);

  const firstSocket = await openSocket(first.port);
  const secondSocket = await openSocket(second.port);
  const firstClosed = new Promise<void>((resolveClose) =>
    firstSocket.once('close', () => resolveClose()),
  );
  const secondClosed = new Promise<void>((resolveClose) =>
    secondSocket.once('close', () => resolveClose()),
  );

  first.process.stdin.end();
  second.process.stdin.end();
  await bounded(
    Promise.all([
      waitForExit(first.process),
      waitForExit(second.process),
      firstClosed,
      secondClosed,
    ]).then(() => undefined),
    'fixture shutdown',
  );
  assert.equal(firstSocket.readyState, WebSocket.CLOSED);
  assert.equal(secondSocket.readyState, WebSocket.CLOSED);
});

test('fixture rejects port 65536 with its startup diagnostic and no live process', async (t) => {
  let directory = '';
  let fixtureProcess: ChildProcessWithoutNullStreams | undefined;

  await t.test('failing first fixture setup', async (setup) => {
    directory = mkdtempSync(`${tmpdir()}/droid-child-fixture-first-failure-`);
    setup.after(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    await assert.rejects(
      startFixture(`${directory}/first.jsonl`, { BRIDGE_PORT: '65536' }, (child) => {
        fixtureProcess = child;
      }),
      /Child-session smoke fixture requires BRIDGE_PORT, bridge authentication, and log path\./,
    );
    assert.ok(fixtureProcess);
    await waitForExit(fixtureProcess);
  });

  assert.equal(existsSync(directory), false);
  assert.ok(fixtureProcess?.exitCode !== null || fixtureProcess.signalCode !== null);
});

test('second fixture startup failure cleans the first process and temporary files', async (t) => {
  let directory = '';
  let firstProcess: ChildProcessWithoutNullStreams | undefined;
  let secondProcess: ChildProcessWithoutNullStreams | undefined;

  await t.test('failing second fixture setup', async (setup) => {
    directory = mkdtempSync(`${tmpdir()}/droid-child-fixture-second-failure-`);
    setup.after(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    const first = await startFixture(`${directory}/first.jsonl`);
    firstProcess = first.process;
    setup.after(() => {
      first.process.kill();
    });
    await assert.rejects(
      startFixture(`${directory}/second.jsonl`, { BRIDGE_PORT: '65536' }, (child) => {
        secondProcess = child;
      }),
      /Child-session smoke fixture requires BRIDGE_PORT, bridge authentication, and log path\./,
    );
    assert.ok(secondProcess);
    await waitForExit(secondProcess);
  });

  assert.equal(existsSync(directory), false);
  assert.ok(firstProcess);
  await waitForExit(firstProcess);
  assert.ok(firstProcess.exitCode !== null || firstProcess.signalCode !== null);
  assert.ok(secondProcess?.exitCode !== null || secondProcess.signalCode !== null);
});
