import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BrowserSessionManager,
  type BrowserRuntime,
  type BrowserSessionManagerOptions,
} from './BrowserSessionManager.js';
import type {
  BrowserBox,
  BrowserElementRef,
  BrowserScreenshotOptions,
  BrowserState,
  BrowserViewport,
  DesignAnchor,
  DesignAnchorDetail,
  ScrollDirection,
} from './types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'droid-browser-test-'));

function createManager(options: BrowserSessionManagerOptions = {}): BrowserSessionManager {
  return new BrowserSessionManager({
    browserDataDir: dataDir,
    runtimeFactory: (_id, viewport) => new FakeRuntime(viewport),
    ...options,
  });
}

class FakeRuntime implements BrowserRuntime {
  clicks: { x: number; y: number; selector?: string }[] = [];
  hovers: { x: number; y: number; selector?: string }[] = [];
  refs: BrowserElementRef[] = [buttonRef()];
  selections: { selector: string; value: string }[] = [];
  screenshots: BrowserScreenshotOptions[] = [];
  captures: (BrowserBox | undefined)[] = [];
  viewport: BrowserViewport;
  openedUrls: string[] = [];
  reloads = 0;
  history: ('back' | 'forward')[] = [];
  canGoBack = false;
  canGoForward = false;
  omitHistory = false;
  snapshotRequests = 0;
  clickError?: Error;
  viewportError?: Error;

  constructor(viewport: BrowserViewport) {
    this.viewport = viewport;
  }

  async open(url: string) {
    this.openedUrls.push(url);
    return this.stateSnapshot(url);
  }

  async reload() {
    this.reloads += 1;
    return this.stateSnapshot('https://example.com/reloaded');
  }

  async goBack() {
    this.history.push('back');
    return this.stateSnapshot('https://example.com/back');
  }

  async goForward() {
    this.history.push('forward');
    return this.stateSnapshot('https://example.com/forward');
  }

  async setViewport(viewport: BrowserViewport): Promise<void> {
    if (this.viewportError) throw this.viewportError;
    this.viewport = viewport;
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<string> {
    this.screenshots.push(options);
    return Buffer.from('full-screenshot').toString('base64');
  }

  async capture(box?: BrowserBox): Promise<string> {
    this.captures.push(box);
    return Buffer.from('crop').toString('base64');
  }

  async snapshot(url = 'http://127.0.0.1:1420/') {
    this.snapshotRequests += 1;
    return this.stateSnapshot(url);
  }

  private stateSnapshot(url = 'http://127.0.0.1:1420/') {
    return {
      url,
      title: 'Droid Control',
      scroll: { x: 0, y: 0 },
      refs: this.refs,
      ...(this.omitHistory ? {} : { canGoBack: this.canGoBack, canGoForward: this.canGoForward }),
    };
  }

  async click(x: number, y: number, selector?: string) {
    this.clicks.push({ x, y, selector });
    if (this.clickError) throw this.clickError;
    return this.stateSnapshot();
  }

  async hover(x: number, y: number, selector?: string) {
    this.hovers.push({ x, y, selector });
    return this.stateSnapshot();
  }

  async selectOption(selector: string, value: string) {
    this.selections.push({ selector, value });
    return this.stateSnapshot();
  }
  async type() {
    return this.stateSnapshot();
  }
  async keypress() {
    return this.stateSnapshot();
  }
  async scroll(_direction: ScrollDirection) {
    return this.stateSnapshot();
  }
  async inspect(selector: string) {
    const ref = this.refs.find((item) => item.selector === selector);
    if (!ref) throw new Error('Element not found');
    return {
      selector,
      tagName: ref.tagName,
      role: ref.role,
      name: ref.name,
      text: ref.text,
      attributes: ref.attributes ?? {},
      box: ref.box,
      html: '<button>Save</button>',
    };
  }
  async network() {
    return [];
  }
  async console() {
    return [];
  }
  async close(): Promise<void> {}
}

test('runtime snapshots propagate navigation history state', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      runtime.canGoBack = true;
      return runtime;
    },
  });

  const opened = await manager.open({
    missionId: 'm1',
    url: 'http://127.0.0.1:1420/',
  });
  assert.equal(opened.canGoBack, true);
  assert.equal(opened.canGoForward, false);

  runtime.canGoForward = true;
  const reloaded = await manager.reload('m1');
  assert.equal(reloaded.canGoBack, true);
  assert.equal(reloaded.canGoForward, true);
});

test('opening a new page clears stale history when its snapshot omits navigation state', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      runtime.canGoBack = true;
      runtime.canGoForward = true;
      return runtime;
    },
  });

  await manager.open({ missionId: 'm1', url: 'https://example.com/first' });
  runtime.omitHistory = true;
  const opened = await manager.open({ missionId: 'm1', url: 'https://example.com/second' });

  assert.equal(opened.canGoBack, false);
  assert.equal(opened.canGoForward, false);
});

test('click by ref uses the cached selector without a redundant pre-action snapshot', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });
  await manager.click({ missionId: 'm1', ref: '@e1' });

  assert.deepEqual(runtime.clicks[0], { x: 50, y: 35, selector: 'button' });
  assert.equal(runtime.snapshotRequests, 0);
});

test('click by missing ref fails without issuing a runtime action', async () => {
  const runtime = new FakeRuntime({ width: 1200, height: 800, deviceScaleFactor: 2 });
  runtime.refs = [];
  const manager = createManager({
    runtimeFactory: () => runtime,
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  await assert.rejects(
    manager.click({ missionId: 'm1', ref: '@e1' }),
    /Browser ref @e1 is not available/,
  );
  assert.deepEqual(runtime.clicks, []);
});

test('inspect resolves a current ref to its selector', async () => {
  const manager = createManager();
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const inspection = await manager.inspect('m1', { ref: '@e1' });

  assert.equal(inspection.selector, 'button');
  assert.equal(inspection.html, '<button>Save</button>');
});

test('resize clears stale refs without requesting a snapshot', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const state = await manager.resizeViewport({
    missionId: 'm1',
    viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    viewportMode: 'mobile',
  });

  assert.deepEqual(state.refs, []);
  assert.equal(runtime.snapshotRequests, 0);
});

test('failed resize preserves the previous viewport and emits no optimistic update', async () => {
  const updates: BrowserState[] = [];
  const runtime = new FakeRuntime({ width: 1200, height: 800, deviceScaleFactor: 2 });
  const manager = createManager({
    runtimeFactory: () => runtime,
    emit: (event) => {
      if (event.type === 'browser.updated') updates.push(event.state);
    },
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });
  const updateCount = updates.length;
  runtime.viewportError = new Error('resize failed');

  await assert.rejects(
    manager.resizeViewport({
      missionId: 'm1',
      viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
      viewportMode: 'mobile',
    }),
    /resize failed/,
  );

  assert.equal(updates.length, updateCount);
  assert.deepEqual(manager.state('m1')?.viewport, {
    width: 1200,
    height: 800,
    deviceScaleFactor: 2,
  });
});

test('agent click updates the visible agent cursor', async () => {
  const manager = createManager();
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const state = await manager.click({ missionId: 'm1', ref: '@e1' });

  assert.deepEqual(state.agentCursor, { x: 50, y: 35 });
});

test('failed agent click still emits the attempted cursor position', async () => {
  const updates: BrowserState[] = [];
  const runtime = new FakeRuntime({ width: 1200, height: 800, deviceScaleFactor: 2 });
  const manager = createManager({
    runtimeFactory: () => runtime,
    emit: (event) => {
      if (event.type === 'browser.updated') updates.push(event.state);
    },
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });
  const updateCount = updates.length;
  runtime.clickError = new Error('click failed');

  await assert.rejects(manager.click({ missionId: 'm1', ref: '@e1' }), /click failed/);

  assert.equal(updates.length, updateCount + 1);
  assert.deepEqual(updates.at(-1)?.agentCursor, { x: 50, y: 35 });
});

test('user click does not move the visible agent cursor', async () => {
  const manager = createManager();
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const state = await manager.click({ missionId: 'm1', ref: '@e1', source: 'user' });

  assert.equal(state.agentCursor, undefined);
});

test('hover and select target current snapshot refs', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  await manager.hover({ missionId: 'm1', ref: '@e1' });
  await manager.selectOption('m1', '@e1', 'active');

  assert.deepEqual(runtime.hovers, [{ x: 50, y: 35, selector: 'button' }]);
  assert.deepEqual(runtime.selections, [{ selector: 'button', value: 'active' }]);
});

test('addReference captures an anchor crop and current browser context', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const reference = await manager.addReference('m1', { anchor: buttonAnchor() });

  assert.equal(reference.url, 'http://127.0.0.1:1420/');
  assert.equal(reference.viewport.width, 1200);
  assert.equal(reference.anchor.id, reference.id);
  assert.ok(reference.anchor.screenshotPath, 'expected an auto-captured crop path');
  assert.deepEqual(runtime.captures.at(-1), buttonAnchor().box);
});

test('referenceDetail returns the stored reference with detail', async () => {
  const manager = createManager();
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  const reference = await manager.addReference('m1', {
    anchor: buttonAnchor(),
    detail: buttonDetail(),
  });
  const fetched = manager.referenceDetail('m1', reference.id);

  assert.equal(fetched?.detail?.selector, 'button');
  assert.equal(fetched?.detail?.id, reference.id);
});

test('designPrompt writes selected references and trims the instruction', async () => {
  let writtenInstruction = '';
  let writtenReferenceCount = 0;
  const manager = createManager({
    writePack: async (options) => {
      writtenInstruction = options.instruction;
      writtenReferenceCount = options.references.length;
      return {
        path: '/tmp/droid/pack.json',
        pack: {
          missionId: options.missionId,
          browserSessionId: options.browserSessionId,
          createdAt: '2026-06-07T00:00:00.000Z',
          instruction: options.instruction,
          references: options.references,
        },
      };
    },
  });
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });
  const reference = await manager.addReference('m1', { anchor: buttonAnchor() });

  const result = await manager.designPrompt({
    missionId: 'm1',
    instruction: '  Make the button clearer  ',
    referenceIds: [reference.id],
  });

  assert.equal(writtenInstruction, 'Make the button clearer');
  assert.equal(writtenReferenceCount, 1);
  assert.match(result.prompt, /Make the button clearer/);
});

test('designPrompt requires a selected or sketched reference', async () => {
  const manager = createManager();
  await manager.open({ missionId: 'm1', url: 'http://127.0.0.1:1420/' });

  await assert.rejects(
    () =>
      manager.designPrompt({ missionId: 'm1', instruction: 'Make this clearer', referenceIds: [] }),
    /Select or sketch at least one browser reference/,
  );
});

test('screenshot forwards high-detail capture options', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
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
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({
    missionId: 'm1',
    url: 'https://example.com',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
  });

  const state = await manager.open({
    missionId: 'm1',
    url: 'https://example.com',
    viewport: { width: 524, height: 898, deviceScaleFactor: 2 },
    viewportMode: 'fit',
  });

  assert.deepEqual(runtime.viewport, { width: 524, height: 898, deviceScaleFactor: 2 });
  assert.deepEqual(state.viewport, { width: 524, height: 898, deviceScaleFactor: 2 });
});

test('open preserves existing viewport when agent omits viewport', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({
    missionId: 'm1',
    url: 'https://example.com',
    viewport: { width: 820, height: 620, deviceScaleFactor: 2 },
    viewportMode: 'custom',
  });

  const state = await manager.open({ missionId: 'm1', url: 'https://example.org' });

  assert.deepEqual(runtime.viewport, { width: 820, height: 620, deviceScaleFactor: 2 });
  assert.deepEqual(state.viewport, { width: 820, height: 620, deviceScaleFactor: 2 });
  assert.equal(state.viewportMode, 'custom');
});

test('open normalizes bare domains before the native runtime sees them', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });

  const state = await manager.open({ missionId: 'm1', url: 'skeina.tech' });

  assert.equal(runtime.openedUrls[0], 'https://skeina.tech');
  assert.equal(state.url, 'https://skeina.tech');
});

test('reload updates the managed browser state from the runtime snapshot', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ missionId: 'm1', url: 'https://example.com' });

  const state = await manager.reload('m1');

  assert.equal(runtime.reloads, 1);
  assert.equal(state.url, 'https://example.com/reloaded');
});

test('history navigation updates browser state through the runtime', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });
  await manager.open({ missionId: 'm1', url: 'https://example.com' });

  const back = await manager.goBack('m1');
  const forward = await manager.goForward('m1');

  assert.deepEqual(runtime.history, ['back', 'forward']);
  assert.equal(back.url, 'https://example.com/back');
  assert.equal(forward.url, 'https://example.com/forward');
});

test('open and refresh do not force screenshot capture', async () => {
  let runtime!: FakeRuntime;
  const manager = createManager({
    runtimeFactory: (_id, viewport) => {
      runtime = new FakeRuntime(viewport);
      return runtime;
    },
  });

  await manager.open({ missionId: 'm1', url: 'https://example.com' });
  await manager.refresh('m1');

  assert.equal(runtime.screenshots.length, 0);
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

function buttonAnchor(): DesignAnchor {
  return {
    id: '@live-button',
    kind: 'element',
    label: 'Save',
    tag: 'button',
    role: 'button',
    name: 'Save',
    text: 'Save',
    box: { x: 10, y: 20, width: 80, height: 30 },
  };
}

function buttonDetail(): DesignAnchorDetail {
  return {
    id: '@live-button',
    selector: 'button',
    selectorVerified: true,
    attributes: {},
    styles: {},
    ancestors: [],
  };
}
