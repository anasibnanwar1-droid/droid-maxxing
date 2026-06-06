import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { MacChromeCdpRuntime, type CdpLike } from './MacChromeCdpRuntime.js';

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
