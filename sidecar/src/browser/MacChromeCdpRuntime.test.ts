import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import test from 'node:test';
import { createPageTarget, MacChromeCdpRuntime, type CdpLike } from './MacChromeCdpRuntime.js';

class FakeCdp implements CdpLike {
  calls: { method: string; params?: Record<string, unknown> }[] = [];

  async connect(): Promise<void> {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Runtime.evaluate') {
      const expression = params?.expression;
      if (expression === 'document.readyState') return { result: { value: 'complete' } } as T;
      return {
        result: {
          value: {
            url: 'http://127.0.0.1:1420/',
            title: 'Droid Control',
            scroll: { x: 0, y: 0 },
            refs: [],
          },
        },
      } as T;
    }
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') } as T;
    if (method === 'Page.getLayoutMetrics') return { contentSize: { width: 1200, height: 1600 } } as T;
    return {} as T;
  }

  close(): void {}
}

test('open sets viewport, navigates, and returns a normalized snapshot', async () => {
  const cdp = new FakeCdp();
  const runtime = new MacChromeCdpRuntime({
    sessionId: 'test',
    viewport: { width: 900, height: 700, deviceScaleFactor: 1 },
    cdp,
  });

  const snapshot = await runtime.open('http://127.0.0.1:1420/');

  assert.equal(snapshot.url, 'http://127.0.0.1:1420/');
  assert.deepEqual(cdp.calls.slice(0, 2).map((call) => call.method), ['Emulation.setDeviceMetricsOverride', 'Page.navigate']);
  assert.deepEqual(cdp.calls[0].params, { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
});

test('screenshot writes a PNG file and returns its path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'droid-runtime-test-'));
  const cdp = new FakeCdp();
  const runtime = new MacChromeCdpRuntime({
    sessionId: 'test',
    viewport: { width: 900, height: 700, deviceScaleFactor: 1 },
    screenshotDir: dir,
    cdp,
    now: () => 123,
  });

  const path = await runtime.screenshot();

  assert.equal(path, join(dir, 'shot-123.png'));
  assert.equal(await readFile(path, 'utf8'), 'png');
  await rm(dir, { recursive: true, force: true });
});

test('click, type, keypress, and scroll send compact input events', async () => {
  const cdp = new FakeCdp();
  const runtime = new MacChromeCdpRuntime({
    sessionId: 'test',
    viewport: { width: 900, height: 700, deviceScaleFactor: 1 },
    cdp,
  });

  await runtime.click(20, 30);
  await runtime.type('hello');
  await runtime.keypress('Enter');
  await runtime.scroll('down', 250);

  assert.deepEqual(cdp.calls.map((call) => call.method), [
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.insertText',
    'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent',
    'Input.dispatchMouseEvent',
  ]);
  assert.deepEqual(cdp.calls.at(-1)?.params, { type: 'mouseWheel', x: 450, y: 350, deltaX: 0, deltaY: 250 });
});

test('createPageTarget uses Chrome PUT target endpoint', async () => {
  let method = '';
  const server = createServer((req, res) => {
    method = req.method ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/test' }));
  });
  const port = await listen(server);

  try {
    assert.equal(await createPageTarget(port), 'ws://127.0.0.1/devtools/page/test');
    assert.equal(method, 'PUT');
  } finally {
    await close(server);
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected local test server address'));
        return;
      }
      resolve(address.port);
    });
    server.once('error', reject);
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
