import assert from 'node:assert/strict';
import test from 'node:test';
import { previewFrameActions } from './usePreviewFrames';

const preview = {
  id: 'generated-checkout',
  name: 'Checkout',
  url: 'http://127.0.0.1:4173/preview',
  kind: 'page' as const,
  source: { type: 'workspace-html' as const, relativePath: 'preview/checkout.html' },
};

test('new generated previews are added and focused as a readable showcase', () => {
  const actions = previewFrameActions(preview, false, 0);
  assert.deepEqual(actions, [
    {
      type: 'ADD_FRAME',
      frame: {
        id: 'generated-checkout',
        name: 'Checkout',
        url: 'http://127.0.0.1:4173/preview',
        source: { type: 'workspace-html', relativePath: 'preview/checkout.html' },
        mode: 'custom',
        width: 1200,
        height: 3200,
        kind: 'showcase',
      },
    },
    { type: 'REQUEST_FRAME_FOCUS', id: 'generated-checkout' },
  ]);
});

test('regenerated previews reload in place and request focus again', () => {
  const actions = previewFrameActions(preview, true, 3);
  assert.deepEqual(actions, [
    {
      type: 'UPDATE_FRAME',
      id: 'generated-checkout',
      patch: {
        url: 'http://127.0.0.1:4173/preview?v=3',
        source: { type: 'workspace-html', relativePath: 'preview/checkout.html' },
        status: 'loading',
      },
    },
    { type: 'REQUEST_FRAME_FOCUS', id: 'generated-checkout' },
  ]);
});

test('a restored preview can synchronize without stealing the current canvas view', () => {
  const actions = previewFrameActions(preview, true, 1, false);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, 'UPDATE_FRAME');
});
