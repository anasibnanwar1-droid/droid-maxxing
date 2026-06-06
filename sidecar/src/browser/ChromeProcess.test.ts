import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChromeProcess, chromeLaunchArgs } from './ChromeProcess.js';

test('chromeLaunchArgs uses local CDP and viewport dimensions', () => {
  assert.deepEqual(chromeLaunchArgs({
    port: 9333,
    profileDir: '/tmp/profile',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  }), [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9333',
    '--user-data-dir=/tmp/profile',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,800',
    'about:blank',
  ]);
});

test('ChromeProcess launches with explicit path, port, and profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'droid-chrome-test-'));
  const chromePath = join(dir, 'Chrome');
  await writeFile(chromePath, '');
  const calls: { command: string; args: string[] }[] = [];
  let killed = false;
  const process = new ChromeProcess({
    sessionId: 'session-a',
    viewport: { width: 1000, height: 700, deviceScaleFactor: 1 },
    chromePath,
    profileDir: join(dir, 'profile'),
    port: 9444,
    spawnChrome: (command, args) => {
      calls.push({ command, args });
      return {
        killed,
        kill: () => {
          killed = true;
          return true;
        },
        once: () => ({}) as never,
      };
    },
    readVersion: async (port) => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }),
  });

  const handle = await process.launch();

  assert.equal(handle.port, 9444);
  assert.equal(handle.version.webSocketDebuggerUrl, 'ws://127.0.0.1:9444/devtools/browser/test');
  assert.equal(calls[0].command, chromePath);
  assert.ok(calls[0].args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(calls[0].args.includes('--window-size=1000,700'));
  await rm(dir, { recursive: true, force: true });
});
