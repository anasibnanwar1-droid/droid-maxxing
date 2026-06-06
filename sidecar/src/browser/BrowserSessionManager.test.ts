import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSessionManager, type BrowserRuntime } from './BrowserSessionManager.js';
import type { BrowserElementRef, BrowserScreenshotOptions, BrowserViewport, ScrollDirection } from './types.js';

class FakeRuntime implements BrowserRuntime {
  clicks: { x: number; y: number }[] = [];
  screenshots: BrowserScreenshotOptions[] = [];
  viewport: BrowserViewport;

  constructor(viewport: BrowserViewport) {
    this.viewport = viewport;
  }

  async open(url: string) {
    return this.snapshot(url);
  }

  async setViewport(viewport: BrowserViewport): Promise<void> {
    this.viewport = viewport;
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<string> {
    this.screenshots.push(options);
    return '/tmp/droid/shot.png';
  }

  async snapshot(url = 'http://127.0.0.1:1420/') {
    return {
      url,
      title: 'Droid Control',
      scroll: { x: 0, y: 0 },
      refs: [buttonRef()],
    };
  }

  async click(x: number, y: number): Promise<void> {
    this.clicks.push({ x, y });
  }

  async type(): Promise<void> {}
  async keypress(): Promise<void> {}
  async scroll(_direction: ScrollDirection): Promise<void> {}
  async close(): Promise<void> {}
}

test('click by ref uses the element center', async () => {
  let runtime!: FakeRuntime;
  const manager = new BrowserSessionManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  await manager.click({ missionId: 'm1', ref: '@e1' });

  assert.deepEqual(runtime.clicks[0], { x: 50, y: 35 });
});

test('agent click updates the visible agent cursor', async () => {
  const manager = new BrowserSessionManager({
    runtimeFactory: (_id, viewport) => new FakeRuntime(viewport),
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const state = await manager.click({ missionId: 'm1', ref: '@e1' });

  assert.deepEqual(state.agentCursor, { x: 50, y: 35 });
});

test('user click does not move the visible agent cursor', async () => {
  const manager = new BrowserSessionManager({
    runtimeFactory: (_id, viewport) => new FakeRuntime(viewport),
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const state = await manager.click({ missionId: 'm1', ref: '@e1', source: 'user' });

  assert.equal(state.agentCursor, undefined);
});

test('addReference captures current browser context', async () => {
  const manager = new BrowserSessionManager({
    runtimeFactory: (_id, viewport) => new FakeRuntime(viewport),
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const reference = manager.addReference('m1', { kind: 'element', element: buttonRef() });

  assert.equal(reference.url, 'http://127.0.0.1:1420/');
  assert.equal(reference.screenshotPath, '/tmp/droid/shot.png');
  assert.equal(reference.viewport.width, 1200);
});

test('screenshot forwards high-detail capture options', async () => {
  let runtime!: FakeRuntime;
  const manager = new BrowserSessionManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  await manager.screenshot('m1', { fullPage: true, deviceScaleFactor: 3 });

  assert.deepEqual(runtime.screenshots.at(-1), { fullPage: true, deviceScaleFactor: 3 });
});

test('open resizes an existing runtime before capture', async () => {
  let runtime!: FakeRuntime;
  const manager = new BrowserSessionManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ missionId: 'm1', url: 'https://example.com', viewport: { width: 1200, height: 800, deviceScaleFactor: 2 } });

  const state = await manager.open({ missionId: 'm1', url: 'https://example.com', viewport: { width: 524, height: 898, deviceScaleFactor: 2 }, viewportMode: 'fit' });

  assert.deepEqual(runtime.viewport, { width: 524, height: 898, deviceScaleFactor: 2 });
  assert.deepEqual(state.viewport, { width: 524, height: 898, deviceScaleFactor: 2 });
});

test('open preserves existing viewport when agent omits viewport', async () => {
  let runtime!: FakeRuntime;
  const manager = new BrowserSessionManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ missionId: 'm1', url: 'https://example.com', viewport: { width: 820, height: 620, deviceScaleFactor: 2 }, viewportMode: 'custom' });

  const state = await manager.open({ missionId: 'm1', url: 'https://example.org' });

  assert.deepEqual(runtime.viewport, { width: 820, height: 620, deviceScaleFactor: 2 });
  assert.deepEqual(state.viewport, { width: 820, height: 620, deviceScaleFactor: 2 });
  assert.equal(state.viewportMode, 'custom');
});

function buttonRef(): BrowserElementRef {
  return {
    ref: '@e1',
    selector: 'button',
    tagName: 'button',
    role: 'button',
    name: 'Save',
    text: 'Save',
    attributes: {},
    box: { x: 10, y: 20, width: 80, height: 30 },
    computedStyles: {},
  };
}
