import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeBrowserAgentActionFromRequest } from './nativeBrowser';

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
