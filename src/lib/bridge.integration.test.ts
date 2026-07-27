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
    const { createMission } = await import('./commands.js');
    const { bridge } = await import('./bridge.js');
    const seen: ServerEvent[] = [];
    const unsubscribe = bridge.subscribe((event) => seen.push(event));

    createMission({
      clientRef: 'r1-create',
      title: 'R1',
      goal: 'hello',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await bridge.start();
    const socket = FakeWebSocket.instances.at(-1)!;

    assert.equal(socket.url, 'ws://127.0.0.1:43123?token=r1-token');
    assert.deepEqual(socket.sent, []);
    socket.open();
    assert.equal(socket.sent.length, 1);
    assert.deepEqual(JSON.parse(socket.sent[0]), {
      type: 'mission.create',
      clientRef: 'r1-create',
      title: 'R1',
      goal: 'hello',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    const mission = {
      id: 'r1',
      sessionId: 'r1',
      kind: 'chat',
      role: 'orchestrator',
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

    socket.message({ type: 'mission.created', clientRef: 'r1-create', mission });
    assert.equal(seen.length, 1);
    unsubscribe();
    socket.message({ type: 'mission.updated', mission });
    assert.equal(seen.length, 1);
    assert.equal(FakeWebSocket.instances.length, 1);
  } finally {
    Object.assign(globalThis, { window: oldWindow, WebSocket: OldWebSocket });
  }
});
