import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserMcpServer } from './browserMcpServer.js';
import type { BrowserSessionManager } from './BrowserSessionManager.js';

test('browser MCP server exposes agent-facing names and typed inputs', () => {
  const server = createBrowserMcpServer({} as BrowserSessionManager, () => 'm1');

  assert.equal(server.name, 'droidmaxx-browser');
  assert.deepEqual(
    server.tools.map((tool) => tool.name),
    [
      'browser_open',
      'browser_snapshot',
      'browser_reload',
      'browser_back',
      'browser_forward',
      'browser_screenshot',
      'browser_click',
      'browser_hover',
      'browser_select',
      'browser_type',
      'browser_keypress',
      'browser_resize',
      'browser_scroll',
      'browser_wait',
      'browser_fill_login',
      'design-mode',
      'design_reference',
    ],
  );
  assert.ok(server.tools.find((tool) => tool.name === 'browser_open')?.inputSchema?.url);
  assert.ok(
    server.tools.find((tool) => tool.name === 'browser_screenshot')?.inputSchema?.deviceScaleFactor,
  );
  assert.match(
    server.tools.find((tool) => tool.name === 'browser_open')?.description ?? '',
    /Do not ask the user for a URL/,
  );
});

test('browser MCP handlers return visible tool errors', async () => {
  const manager = {
    designContext() {
      throw new Error('Browser session is not open yet.');
    },
  } as unknown as BrowserSessionManager;
  const server = createBrowserMcpServer(manager, () => 'm1');
  const designMode = server.tools.find((tool) => tool.name === 'design-mode');

  const result = await designMode?.handler({});

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(result), /Browser session is not open yet/);
});

test('browser_open keeps high-detail viewport scale by default', async () => {
  let openedViewport: { width: number; height: number; deviceScaleFactor?: number } | undefined;
  const manager = {
    async open(input: {
      viewport?: { width: number; height: number; deviceScaleFactor?: number };
    }) {
      openedViewport = input.viewport;
      return {
        url: 'https://example.com',
        viewport: input.viewport,
        viewportMode: 'custom',
        scroll: { x: 0, y: 0 },
        refs: [],
      };
    },
  } as unknown as BrowserSessionManager;
  const server = createBrowserMcpServer(manager, () => 'm1');
  const browserOpen = server.tools.find((tool) => tool.name === 'browser_open');

  const result = await browserOpen?.handler({
    url: 'https://example.com',
    viewport: { width: 1000, height: 700 },
    viewportMode: 'custom',
  });

  assert.equal(openedViewport?.deviceScaleFactor, 2);
  assert.match(String(result), /Opened the live Droid Control browser/);
});

test('browser_reload returns a fresh browser state', async () => {
  const manager = {
    async reload() {
      return {
        url: 'https://example.com',
        viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
        viewportMode: 'fit',
        scroll: { x: 0, y: 0 },
        refs: [],
      };
    },
  } as unknown as BrowserSessionManager;
  const server = createBrowserMcpServer(manager, () => 'm1');
  const browserReload = server.tools.find((tool) => tool.name === 'browser_reload');

  const result = await browserReload?.handler({});

  assert.match(String(result), /https:\/\/example.com/);
});

test('browser history tools return the resulting page state', async () => {
  const calls: string[] = [];
  const state = {
    url: 'https://example.com/history',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    viewportMode: 'fit' as const,
    scroll: { x: 0, y: 0 },
    refs: [],
  };
  const manager = {
    async goBack() {
      calls.push('back');
      return state;
    },
    async goForward() {
      calls.push('forward');
      return state;
    },
  } as unknown as BrowserSessionManager;
  const server = createBrowserMcpServer(manager, () => 'm1');

  await server.tools.find((tool) => tool.name === 'browser_back')?.handler({});
  await server.tools.find((tool) => tool.name === 'browser_forward')?.handler({});

  assert.deepEqual(calls, ['back', 'forward']);
});
