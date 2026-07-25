const test = require('node:test');
const assert = require('node:assert/strict');
const { attachChildView, detachChildView } = require('./nativeBrowserHost.cjs');

function createHost() {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    contentView: {
      addChildView: (view) => calls.push(['add', view]),
      removeChildView: (view) => calls.push(['remove', view]),
    },
  };
}

test('attaching a browser view to its current host is idempotent', () => {
  const host = createHost();
  const view = {};
  const entry = { view, windowAttached: false, hostWindow: null };

  assert.equal(attachChildView(entry, host), true);
  assert.equal(attachChildView(entry, host), false);
  assert.deepEqual(host.calls, [['add', view]]);
});

test('moving a browser view removes it from the previous host first', () => {
  const firstHost = createHost();
  const secondHost = createHost();
  const view = {};
  const entry = { view, windowAttached: false, hostWindow: null };

  attachChildView(entry, firstHost);
  attachChildView(entry, secondHost);

  assert.deepEqual(firstHost.calls, [
    ['add', view],
    ['remove', view],
  ]);
  assert.deepEqual(secondHost.calls, [['add', view]]);
  assert.equal(entry.hostWindow, secondHost);
});

test('detaching a browser view clears ownership even when its host is gone', () => {
  const entry = {
    view: {},
    windowAttached: true,
    hostWindow: { isDestroyed: () => true },
  };

  assert.equal(detachChildView(entry), true);
  assert.equal(entry.windowAttached, false);
  assert.equal(entry.hostWindow, null);
});
