import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerEvent } from '../types/bridge';

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

  message(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }
}

test('[R1] Renderer command round trip', { concurrency: false }, async () => {
  const oldWindow = globalThis.window;
  const OldWebSocket = globalThis.WebSocket;
  try {
    Object.assign(globalThis, {
      window: {
        droidControl: {
          bridgeInfo: async () => ({ port: 43123, token: 'r1-token' }),
        },
      },
      WebSocket: FakeWebSocket,
    });
    const { createSession, openChild, updateChildSettings } = await import('./commands.js');
    const { bridge } = await import('./bridge.js');
    const seen: ServerEvent[] = [];
    const unsubscribe = bridge.subscribe((event) => seen.push(event));

    createSession({
      clientRef: 'r1-create',
      title: 'R1',
      goal: 'hello',
      sessionPurpose: 'chat',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    updateChildSettings({
      parentAppSessionId: 'r1',
      childSessionId: 'worker-r1',
      modelId: 'model-r1',
      reasoningEffort: 'high',
    });
    openChild('r1', 'validator-r1', 'validator');
    await bridge.start();
    const socket = FakeWebSocket.instances.at(-1)!;

    assert.equal(socket.url, 'ws://127.0.0.1:43123?token=r1-token');
    assert.deepEqual(socket.sent, []);
    socket.open();
    assert.equal(socket.sent.length, 3);
    assert.deepEqual(JSON.parse(socket.sent[0]), {
      type: 'session.create',
      clientRef: 'r1-create',
      title: 'R1',
      goal: 'hello',
      sessionPurpose: 'chat',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    assert.deepEqual(JSON.parse(socket.sent[1]), {
      type: 'child.updateSettings',
      parentAppSessionId: 'r1',
      childSessionId: 'worker-r1',
      modelId: 'model-r1',
      reasoningEffort: 'high',
    });
    assert.deepEqual(JSON.parse(socket.sent[2]), {
      type: 'child.open',
      appSessionId: 'r1',
      providerSessionId: 'validator-r1',
      role: 'validator',
    });
    const session = {
      appSessionId: 'r1',
      providerSessionId: 'provider-r1',
      sessionPurpose: 'chat',
      interactionMode: 'auto',
      role: 'primary',
      title: 'R1',
      goal: 'hello',
      cwd: '',
      autonomy: 'low',
      phase: 'intake',
      features: [],
      tokensIn: 0,
      tokensOut: 0,
      contextTokens: 0,
      createdAt: 0,
      updatedAt: 0,
    } as const;

    socket.message({ type: 'session.created', clientRef: 'r1-create', session });
    assert.equal(seen.length, 1);
    unsubscribe();
    socket.message({ type: 'session.updated', session });
    assert.equal(seen.length, 1);
    assert.equal(FakeWebSocket.instances.length, 1);
  } finally {
    Object.assign(globalThis, { window: oldWindow, WebSocket: OldWebSocket });
  }
});
