const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { showDesktopNotification } = require('./notifications.cjs');

class FakeNotification extends EventEmitter {
  static latest = null;
  static supported = true;

  static isSupported() {
    return FakeNotification.supported;
  }

  constructor(options) {
    super();
    this.options = options;
    FakeNotification.latest = this;
  }

  show() {}
}

function payload(overrides = {}) {
  return {
    title: 'DROIDEX',
    body: 'Finished',
    silent: false,
    timeoutMs: 5_000,
    onActivate() {},
    ...overrides,
  };
}

test('resolves shown only after Electron emits show', async () => {
  const pending = showDesktopNotification(FakeNotification, payload());
  FakeNotification.latest.emit('show');
  assert.deepEqual(await pending, { shown: true });
});

test('returns the failed event message instead of claiming success', async () => {
  const pending = showDesktopNotification(FakeNotification, payload());
  FakeNotification.latest.emit('failed', {}, 'Notifications are disabled');
  assert.deepEqual(await pending, {
    shown: false,
    reason: 'failed',
    message: 'Notifications are disabled',
  });
});

test('reports unsupported notification APIs without constructing a banner', async () => {
  FakeNotification.supported = false;
  FakeNotification.latest = null;
  try {
    assert.deepEqual(await showDesktopNotification(FakeNotification, payload()), {
      shown: false,
      reason: 'unsupported',
    });
    assert.equal(FakeNotification.latest, null);
  } finally {
    FakeNotification.supported = true;
  }
});

test('reports a bounded timeout and activates a session at most once', async () => {
  let timeoutCallback;
  let activations = 0;
  const pending = showDesktopNotification(
    FakeNotification,
    payload({
      onActivate() {
        activations += 1;
      },
    }),
    {
      setTimer(callback) {
        timeoutCallback = callback;
        return 1;
      },
      clearTimer() {},
    },
  );
  FakeNotification.latest.emit('click');
  FakeNotification.latest.emit('action');
  timeoutCallback();

  assert.equal(activations, 1);
  assert.deepEqual(await pending, { shown: false, reason: 'timeout' });
});
