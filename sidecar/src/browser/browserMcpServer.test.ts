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
