import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nativeBrowserAgentActionFromRequest,
  nativeBrowserResultFromAgentResult,
} from './nativeBrowser';

test('native browser agent actions preserve selector and pointer fields', () => {
  const action = nativeBrowserAgentActionFromRequest({
    requestId: 'request-1',
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
    action: 'selectOption',
    selector: '#country',
    x: 120,
    y: 240,
    text: 'Canada',
    direction: 'down',
    pixels: 300,
  });

  assert.deepEqual(action, {
    requestId: 'request-1',
    browserSessionId: 'browser-1',
    action: 'selectOption',
    x: 120,
    y: 240,
    selector: '#country',
    text: 'Canada',
    key: undefined,
    direction: 'down',
    pixels: 300,
  });
});

test('native browser results preserve audit samples across the renderer bridge', () => {
  const audit = [
    {
      selector: '#submit',
      tag: 'button',
      label: 'Submit',
      box: { x: 10, y: 20, width: 100, height: 40 },
      styles: { color: 'rgb(255, 0, 0)' },
    },
  ];
  const result = nativeBrowserResultFromAgentResult(
    {
      requestId: 'request-2',
      appSessionId: 'app-1',
      browserSessionId: 'browser-1',
      action: 'audit',
    },
    { requestId: 'request-2', ok: true, audit },
  );

  assert.deepEqual(result.audit, audit);
  assert.equal(result.appSessionId, 'app-1');
  assert.equal(result.browserSessionId, 'browser-1');
});
