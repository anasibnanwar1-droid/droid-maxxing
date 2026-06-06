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
      'browser_screenshot',
      'browser_click',
      'browser_type',
      'browser_keypress',
      'browser_scroll',
      'design_mode',
    ],
  );
  assert.ok(server.tools.find((tool) => tool.name === 'browser_open')?.inputSchema?.url);
  assert.ok(server.tools.find((tool) => tool.name === 'browser_screenshot')?.inputSchema?.deviceScaleFactor);
});

test('browser MCP handlers return visible tool errors', async () => {
  const manager = {
    designContext() {
      throw new Error('Browser session is not open yet.');
    },
  } as unknown as BrowserSessionManager;
  const server = createBrowserMcpServer(manager, () => 'm1');
  const designMode = server.tools.find((tool) => tool.name === 'design_mode');

  const result = await designMode?.handler({});

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(result), /Browser session is not open yet/);
});

test('browser_open keeps high-detail viewport scale by default', async () => {
  let openedViewport: { width: number; height: number; deviceScaleFactor?: number } | undefined;
  const manager = {
    async open(input: { viewport?: { width: number; height: number; deviceScaleFactor?: number } }) {
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

  await browserOpen?.handler({
    url: 'https://example.com',
    viewport: { width: 1000, height: 700 },
    viewportMode: 'custom',
  });

  assert.equal(openedViewport?.deviceScaleFactor, 2);
});
