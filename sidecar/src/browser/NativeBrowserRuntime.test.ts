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
  await runtime.goBack();
  await runtime.goForward();
  await runtime.click(12, 34, '#submit');
  await runtime.hover(56, 78, '#account');
  await runtime.selectOption('#country', 'Canada');

  assert.equal(snapshot.url, 'https://example.com/');
  assert.deepEqual(
    requests.map((request) => request.action),
    ['open', 'reload', 'goBack', 'goForward', 'click', 'hover', 'selectOption'],
  );
  assert.equal(requests[0].missionId, 'mission-one');
  assert.equal(requests[0].sessionId, 'browser-one');
  assert.deepEqual(requests[0].viewport, { width: 900, height: 700, deviceScaleFactor: 2 });
  assert.deepEqual(
    { x: requests[4].x, y: requests[4].y, selector: requests[4].selector },
    { x: 12, y: 34, selector: '#submit' },
  );
  assert.deepEqual(
    { x: requests[5].x, y: requests[5].y, selector: requests[5].selector },
    { x: 56, y: 78, selector: '#account' },
  );
  assert.deepEqual(
    { selector: requests[6].selector, text: requests[6].text },
    { selector: '#country', text: 'Canada' },
  );
});

test('open remains usable when navigation succeeds before a DOM snapshot is ready', async () => {
  const runtime = new NativeBrowserRuntime({
    missionId: 'mission-one',
    sessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    request: async (request) => ({
      requestId: request.requestId,
      missionId: request.missionId,
      ok: true,
    }),
  });

  const snapshot = await runtime.open('https://example.com/');
  assert.deepEqual(snapshot, {
    url: 'https://example.com/',
    scroll: { x: 0, y: 0 },
    refs: [],
  });
});

test('reload and snapshot actions never reuse a stale page snapshot', async () => {
  const runtime = new NativeBrowserRuntime({
    missionId: 'mission-one',
    sessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    request: async (request) => ({
      requestId: request.requestId,
      missionId: request.missionId,
      ok: true,
      snapshot:
        request.action === 'open'
          ? {
              url: 'https://example.com/current',
              scroll: { x: 0, y: 0 },
              refs: [],
            }
          : undefined,
    }),
  });

  await runtime.open('https://example.com/current');
  await assert.rejects(runtime.reload(), /navigation completed without a fresh page snapshot/);
  await assert.rejects(runtime.snapshot(), /action completed without a fresh page snapshot/);
  await assert.rejects(runtime.fillCredentials(), /action completed without a fresh page snapshot/);
});

test('history navigation never reuses a stale page snapshot', async () => {
  const runtime = new NativeBrowserRuntime({
    missionId: 'mission-one',
    sessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    request: async (request) => ({
      requestId: request.requestId,
      missionId: request.missionId,
      ok: true,
      snapshot:
        request.action === 'open'
          ? {
              url: 'https://example.com/current',
              scroll: { x: 0, y: 0 },
              refs: [
                {
                  ref: '@b-current',
                  selector: '#current',
                  tagName: 'main',
                  box: { x: 0, y: 0, width: 100, height: 100 },
                },
              ],
            }
          : undefined,
    }),
  });

  await runtime.open('https://example.com/current');
  await assert.rejects(runtime.goBack(), /navigation completed without a fresh page snapshot/);
});
