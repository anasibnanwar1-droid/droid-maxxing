import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeBrowserRuntime } from './NativeBrowserRuntime.js';
import type { BrowserNativeRequest } from '../protocol.js';

test('NativeBrowserRuntime sends live browser requests with mission and session context', async () => {
  const requests: BrowserNativeRequest[] = [];
  const runtime = new NativeBrowserRuntime({
    missionId: 'mission-one',
    sessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    nextRequestId: () => `req-${requests.length + 1}`,
    request: async (request) => {
      requests.push(request);
      return {
        requestId: request.requestId,
        missionId: request.missionId,
        ok: true,
        snapshot: {
          url: request.url ?? 'https://example.com/',
          title: 'Example',
          scroll: { x: 0, y: 0 },
          refs: [],
        },
      };
    },
  });

  const snapshot = await runtime.open('https://example.com/');
  await runtime.reload();
  await runtime.click(12, 34);

  assert.equal(snapshot.url, 'https://example.com/');
  assert.deepEqual(
    requests.map((request) => request.action),
    ['open', 'reload', 'click'],
  );
  assert.equal(requests[0].missionId, 'mission-one');
  assert.equal(requests[0].sessionId, 'browser-one');
  assert.deepEqual(requests[0].viewport, { width: 900, height: 700, deviceScaleFactor: 2 });
  assert.deepEqual({ x: requests[2].x, y: requests[2].y }, { x: 12, y: 34 });
});
