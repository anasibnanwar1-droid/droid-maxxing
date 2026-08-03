import assert from 'node:assert/strict';
import test from 'node:test';
import { Bridge } from './bridge';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

test('listeners registered together on a ready socket bootstrap in order', async () => {
  const oldWindow = globalThis.window;
  const OldWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  try {
    Object.assign(globalThis, {
      window: {
        droidControl: {
          bridgeInfo: async () => ({ port: 43129, token: 'listener-token' }),
        },
      },
      WebSocket: FakeWebSocket,
    });
    const bridge = new Bridge();
    await bridge.start();
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.open();
    await nextTask();

    bridge.subscribeOpen(() => [{ type: 'connect', apiKey: 'first' }]);
    bridge.subscribeOpen(() => [{ type: 'sessions.list', includePlainChats: true }]);
    assert.equal(bridge.isOpen(), false);
    await nextTask();

    assert.equal(bridge.isOpen(), true);
    assert.deepEqual(socket.sent.map(parseCommand), [
      { type: 'connect', apiKey: 'first' },
      { type: 'sessions.list', includePlainChats: true },
    ]);
  } finally {
    Object.assign(globalThis, { window: oldWindow, WebSocket: OldWebSocket });
  }
});

test('reconnect handshakes run before commands queued while disconnected', async () => {
  const oldWindow = globalThis.window;
  const OldWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  try {
    Object.assign(globalThis, {
      window: {
        droidControl: {
          bridgeInfo: async () => ({ port: 43124, token: 'reconnect-token' }),
        },
      },
      WebSocket: FakeWebSocket,
    });
    const bridge = new Bridge((action) => {
      action();
    });
    let opens = 0;
    bridge.subscribeOpen(() => {
      opens += 1;
      return [{ type: 'connect', apiKey: `key-${String(opens)}` }];
    });

    await bridge.start();
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.open();
    await nextTask();
    assert.deepEqual(first.sent.map(parseCommand), [{ type: 'connect', apiKey: 'key-1' }]);

    first.close();
    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    bridge.send({ type: 'sessions.list', includePlainChats: true });
    second.open();
    await nextTask();

    assert.equal(opens, 2);
    assert.deepEqual(second.sent.map(parseCommand), [
      { type: 'connect', apiKey: 'key-2' },
      { type: 'sessions.list', includePlainChats: true },
    ]);
  } finally {
    Object.assign(globalThis, { window: oldWindow, WebSocket: OldWebSocket });
  }
});

test('native reset replay waits for the next bridge-ready socket', async () => {
  const oldWindow = globalThis.window;
  const OldWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  try {
    Object.assign(globalThis, {
      window: {
        droidControl: {
          bridgeInfo: async () => ({ port: 43127, token: 'reset-token' }),
        },
      },
      WebSocket: FakeWebSocket,
    });
    const bridge = new Bridge((action) => {
      action();
    });
    bridge.subscribeOpen(() => [{ type: 'connect', apiKey: 'reconnect-key' }]);

    await bridge.start();
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.open();
    await nextTask();

    bridge.sendOnNextOpen({
      type: 'browser.open',
      appSessionId: 'browser-session',
      url: 'http://127.0.0.1:3000',
    });
    assert.deepEqual(first.sent.map(parseCommand), [{ type: 'connect', apiKey: 'reconnect-key' }]);

    first.close();
    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    second.open();
    await nextTask();

    assert.deepEqual(second.sent.map(parseCommand), [
      { type: 'connect', apiKey: 'reconnect-key' },
      {
        type: 'browser.open',
        appSessionId: 'browser-session',
        url: 'http://127.0.0.1:3000',
      },
    ]);
  } finally {
    Object.assign(globalThis, { window: oldWindow, WebSocket: OldWebSocket });
  }
});

test('native reset during bootstrap never replays on the dying socket', async () => {
  const oldWindow = globalThis.window;
  const OldWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  let finishBootstrap = (): void => {
    throw new Error('Bootstrap listener did not start.');
  };
  try {
    Object.assign(globalThis, {
      window: {
        droidControl: {
          bridgeInfo: async () => ({ port: 43128, token: 'bootstrap-reset-token' }),
        },
      },
      WebSocket: FakeWebSocket,
    });
    const bridge = new Bridge((action) => action());
    bridge.subscribeOpen(
      () =>
        new Promise((resolve) => {
          finishBootstrap = () => resolve([{ type: 'connect', apiKey: 'ready-key' }]);
        }),
    );

    await bridge.start();
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.open();
    await nextTask();
    bridge.sendOnNextOpen({
      type: 'browser.open',
      appSessionId: 'browser-session',
      url: 'http://127.0.0.1:3000',
    });
    finishBootstrap();
    await nextTask();
    assert.deepEqual(first.sent.map(parseCommand), [{ type: 'connect', apiKey: 'ready-key' }]);

    first.close();
    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    second.open();
    await nextTask();
    finishBootstrap();
    await nextTask();
    assert.deepEqual(second.sent.map(parseCommand), [
      { type: 'connect', apiKey: 'ready-key' },
      {
        type: 'browser.open',
        appSessionId: 'browser-session',
        url: 'http://127.0.0.1:3000',
      },
    ]);
  } finally {
    Object.assign(globalThis, { window: oldWindow, WebSocket: OldWebSocket });
  }
});

test('commands remain queued while asynchronous reconnect bootstrap is pending', async () => {
  const oldWindow = globalThis.window;
  const OldWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  let finishBootstrap = (): void => {
    throw new Error('Bootstrap listener did not start.');
  };
  try {
    Object.assign(globalThis, {
      window: {
        droidControl: {
          bridgeInfo: async () => ({ port: 43125, token: 'pending-token' }),
        },
      },
      WebSocket: FakeWebSocket,
    });
    const bridge = new Bridge();
    bridge.subscribeOpen(
      () =>
        new Promise((resolve) => {
          finishBootstrap = resolve;
        }),
    );

    await bridge.start();
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.open();
    bridge.send({ type: 'sessions.list', includePlainChats: true });
    await nextTask();

    assert.equal(bridge.isOpen(), false);
    assert.deepEqual(socket.sent, []);

    finishBootstrap([{ type: 'connect', apiKey: 'ready-key' }]);
    await nextTask();
    assert.equal(bridge.isOpen(), true);
    assert.deepEqual(socket.sent.map(parseCommand), [
      { type: 'connect', apiKey: 'ready-key' },
      { type: 'sessions.list', includePlainChats: true },
    ]);
  } finally {
    Object.assign(globalThis, { window: oldWindow, WebSocket: OldWebSocket });
  }
});

test('failed reconnect bootstrap closes the socket without flushing queued commands', async () => {
  const oldWindow = globalThis.window;
  const OldWebSocket = globalThis.WebSocket;
  const oldConsoleError = console.error;
  FakeWebSocket.instances = [];
  const reconnects: (() => void)[] = [];
  try {
    console.error = () => undefined;
    Object.assign(globalThis, {
      window: {
        droidControl: {
          bridgeInfo: async () => ({ port: 43126, token: 'failed-token' }),
        },
      },
      WebSocket: FakeWebSocket,
    });
    const bridge = new Bridge((action) => {
      reconnects.push(action);
    });
    bridge.subscribeOpen(() => Promise.reject(new Error('authentication failed')));

    await bridge.start();
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.open();
    bridge.send({ type: 'sessions.list', includePlainChats: true });
    await nextTask();

    assert.equal(socket.readyState, 3);
    assert.equal(bridge.isOpen(), false);
    assert.deepEqual(socket.sent, []);
    assert.equal(reconnects.length, 1);
  } finally {
    console.error = oldConsoleError;
    Object.assign(globalThis, { window: oldWindow, WebSocket: OldWebSocket });
  }
});

function parseCommand(value: string): unknown {
  return JSON.parse(value);
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
