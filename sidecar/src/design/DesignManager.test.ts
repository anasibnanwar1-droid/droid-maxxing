import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BrowserState } from '../browser/types.js';
import type { ServerEvent } from '../protocol.js';
import { DesignManager, type DesignManagerOptions } from './DesignManager.js';
import { writeDnaFile } from './dnaFiles.js';
import { PreviewServer } from './previewServer.js';
import { serializeTokenBlock } from './tokens.js';
import type { DesignTokens } from './types.js';
import { writeValidatorConfig } from './validator/config.js';

const TOKENS: DesignTokens = {
  colors: { background: '#ffffff', text: '#111111' },
  fonts: { sans: 'Inter, sans-serif' },
  typeScale: [12, 14, 16],
  spacing: [4, 8, 12],
  radii: [4, 8],
};

test('configured post-prompt validation runs and publishes a report', async (t) => {
  const cwd = temporaryProject(t);
  writeDnaFile(cwd, 'design', serializeTokenBlock(TOKENS));
  writeValidatorConfig(cwd, {
    pages: [{ id: 'home', url: 'http://127.0.0.1:4173' }],
    viewports: ['desktop'],
    runAfterDesignPrompt: true,
  });
  const events: ServerEvent[] = [];
  const openedUrls: string[] = [];
  const manager = createManager(t, events, openedUrls);

  await manager.afterDesignPrompt(cwd, 'design-session');

  assert.deepEqual(openedUrls, ['http://127.0.0.1:4173']);
  assert.equal(
    events.some((event) => event.type === 'design.validator.report'),
    true,
  );
  assert.equal(
    events.some((event) => event.type === 'design.validator.status' && event.status === 'done'),
    true,
  );
});

test('disabled post-prompt validation does not touch the browser', async (t) => {
  const cwd = temporaryProject(t);
  const openedUrls: string[] = [];
  const manager = createManager(t, [], openedUrls);

  await manager.afterDesignPrompt(cwd, 'design-session');

  assert.deepEqual(openedUrls, []);
});

test('unknown design commands emit an actionable error', async (t) => {
  const events: ServerEvent[] = [];
  const manager = createManager(t, events, []);

  await Reflect.apply(manager.handle, manager, [{ type: 'design.unknown' }]);

  const error = events.find(
    (event): event is Extract<ServerEvent, { type: 'design.error' }> =>
      event.type === 'design.error',
  );
  assert.equal(error?.message, 'Unsupported design command: design.unknown');
});

function createManager(
  t: test.TestContext,
  events: ServerEvent[],
  openedUrls: string[],
): DesignManager {
  const previewServer = new PreviewServer();
  t.after(() => previewServer.close());
  const state = (url: string): BrowserState => ({
    browserSessionId: 'browser-design-session',
    appSessionId: 'design-session',
    url,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    viewportMode: 'desktop',
    scroll: { x: 0, y: 0 },
    refs: [],
  });
  const browsers: DesignManagerOptions['browsers'] = {
    referenceDetail: () => undefined,
    open: (input) => {
      openedUrls.push(input.url);
      return Promise.resolve(state(input.url));
    },
    resizeViewport: () => Promise.resolve(state('http://127.0.0.1:4173')),
    audit: () => Promise.resolve([]),
  };
  return new DesignManager({
    emit: (event) => events.push(event),
    browsers,
    sendPrompt: () => Promise.resolve(),
    previewServer,
  });
}

function temporaryProject(t: test.TestContext): string {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-design-manager-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
