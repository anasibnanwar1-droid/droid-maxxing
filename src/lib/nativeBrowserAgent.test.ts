import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserNativeRequest } from '../types/bridge';
import { performNativeBrowserRequest } from './nativeBrowserAgent';

test('native browser requests run through Electron without a mounted Browser controller', async () => {
  const requests: unknown[] = [];
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  globals.window = {
    setTimeout,
    clearTimeout,
    droidControl: {
      onNativeBrowserAgentResult: () => () => {},
      nativeBrowserAgentAction: async (request: BrowserNativeRequest) => {
        requests.push(request);
        return {
          requestId: request.requestId,
          ok: true,
          networkEvents: [
            {
              timestamp: 1,
              method: 'GET',
              url: 'https://example.com/api',
              status: 200,
            },
          ],
        };
      },
    },
  };

  try {
    const result = await performNativeBrowserRequest({
      requestId: 'request-1',
      missionId: 'mission-1',
      sessionId: 'browser-1',
      action: 'network',
    });

    assert.equal(requests.length, 1);
    assert.equal(result.ok, true);
    assert.equal(result.missionId, 'mission-1');
    assert.equal(result.networkEvents?.[0]?.status, 200);
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});
