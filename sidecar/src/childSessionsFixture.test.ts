import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const fixturePath = fileURLToPath(
  new URL('../test-fixtures/childSessionsSidecar.mjs', import.meta.url),
);

async function startFixture(
  logPath: string,
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
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolveReady, reject) => {
    let output = '';
    const fail = (error: unknown) => {
      child.kill();
      reject(error);
    };
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Fixture exited before ready (${code}).`)));
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const match = output.match(/SIDECAR_READY (\d+)/);
      if (!match) return;
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
  const first = await startFixture(`${directory}/first.jsonl`);
  const second = await startFixture(`${directory}/second.jsonl`);
  t.after(() => {
    first.process.kill();
    second.process.kill();
    rmSync(directory, { recursive: true, force: true });
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
