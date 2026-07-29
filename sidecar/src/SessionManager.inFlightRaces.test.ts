import assert from 'node:assert/strict';
import test from 'node:test';
import type { DroidStreamEvent, MessageOptions } from '@factory/droid-sdk';

import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import {
  createSessionManagerTestContext,
  type SessionManagerTestContext,
} from './testing/sessionManagerTestContext.js';

class DirectPrimaryFailureSession extends FakeFactorySession {
  readonly streamStarted: Promise<void>;
  private resolveStreamStarted = (): void => undefined;
  private rejectNext = (error: unknown): void => {
    void error;
  };
  private readonly nextResult: Promise<IteratorResult<DroidStreamEvent, void>>;

  constructor(sessionId: string, h: SessionManagerTestContext) {
    super(sessionId, {}, h.calls);
    this.streamStarted = new Promise((resolve) => {
      this.resolveStreamStarted = resolve;
    });
    this.nextResult = new Promise((_resolve, reject) => {
      this.rejectNext = reject;
    });
  }

  override stream(
    prompt: string,
    _options: MessageOptions & { includePartialMessages: true },
  ): AsyncGenerator<DroidStreamEvent, void, undefined> {
    void _options;
    this.prompts.push(prompt);
    this.resolveStreamStarted();
    const events: DroidStreamEvent[] = [];
    const stream = (async function* (): AsyncGenerator<DroidStreamEvent, void, undefined> {
      for (const event of events) yield event;
    })();
    stream.next = () => this.nextResult;
    return stream;
  }

  rejectStream(error: unknown): void {
    this.rejectNext(error);
  }
}

test('shutdown admission immediately suppresses a queued primary stream failure', async () => {
  const h = createSessionManagerTestContext();
  try {
    const provider = new DirectPrimaryFailureSession('primary-shutdown-race', h);
    h.runtime.createQueue.push(provider);
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'primary-shutdown-race',
      title: 'Primary shutdown race',
      goal: 'wait',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await provider.streamStarted;

    provider.rejectStream(new Error('queued before shutdown'));
    const shutdown = h.shutdown();
    const eventsAtShutdownAdmission = h.events.length;
    await shutdown;
    await h.waitForIdle();

    assert.deepEqual(
      h.events.slice(eventsAtShutdownAdmission).map((event) => event.type),
      ['sessions.list'],
    );
  } finally {
    await h.dispose().catch(() => undefined);
  }
});

test('shutdown abandons a child open before map insertion and readiness', async () => {
  const h = createSessionManagerTestContext();
  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'open-race',
      title: 'Open race',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await h.waitForIdle();
    const child = new FakeFactorySession('opening-backend', {}, h.calls);
    const armGate = child.deferNextUpdateSettings();
    h.runtime.loadQueue.set('opening-logical', [child]);
    const opening = h.handle({
      type: 'child.open',
      appSessionId: 'provider-1',
      providerSessionId: 'opening-logical',
      role: 'validator',
    });
    await h.waitForIdle();

    await h.shutdown();
    armGate.resolve();
    await opening;

    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.updated' &&
          'childSessionId' in event &&
          event.childSessionId === 'opening-logical' &&
          event.settingsReady,
      ),
      false,
    );
    assert.equal(
      h.calls.filter(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'session.close' &&
          call.args[0] === 'opening-backend',
      ).length,
      1,
    );
  } finally {
    await h.dispose().catch(() => undefined);
  }
});

test('pending settings completion after close cannot publish or re-arm', async () => {
  const h = createSessionManagerTestContext();
  try {
    await h.handle({
      type: 'settings.agent.update',
      appSessionId: 'provider-1',
      agent: 'primary',
      modelId: 'pending-model',
    });
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'pending-settings-race',
      title: 'Pending settings race',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.waitForIdle();

    const provider = h.provider.session('provider-1');
    const updateGate = provider.deferNextUpdateSettings();
    const sending = h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'must not send',
    });
    await h.waitForIdle();
    await h.handle({ type: 'session.close', appSessionId: 'provider-1' });
    const eventsAfterClose = h.events.length;
    const settingsWritesAfterClose = provider.settings.length;

    updateGate.resolve();
    await sending;
    await h.waitForIdle();

    assert.deepEqual(provider.prompts, ['go']);
    assert.equal(h.events.length, eventsAfterClose);
    assert.equal(provider.settings.length, settingsWritesAfterClose);
  } finally {
    await h.dispose().catch(() => undefined);
  }
});

test('a child send waits for the shared parent-owned open attempt', async () => {
  const h = createSessionManagerTestContext();
  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'open-once',
      title: 'Open once',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await h.waitForIdle();
    const child = new FakeFactorySession('same-backend', {}, h.calls);
    const armGate = child.deferNextUpdateSettings();
    h.runtime.loadQueue.set('same-logical', [child]);
    const command = {
      type: 'child.open' as const,
      appSessionId: 'provider-1',
      providerSessionId: 'same-logical',
      role: 'worker' as const,
    };

    const opening = h.handle(command);
    await h.waitForIdle();
    const sending = h.handle({
      type: 'child.send',
      appSessionId: 'provider-1',
      providerSessionId: 'same-logical',
      text: 'queued during open',
    });
    await h.waitForIdle();
    assert.deepEqual(child.prompts, []);
    armGate.resolve();
    await Promise.all([opening, sending]);

    assert.equal(h.runtime.loadCalls.filter((call) => call.sessionId === 'same-logical').length, 1);
    assert.deepEqual(child.prompts, ['queued during open']);
    assert.equal(
      h.events.filter(
        (event) =>
          event.type === 'child.updated' &&
          'childSessionId' in event &&
          event.childSessionId === 'same-logical' &&
          event.settingsReady,
      ).length,
      1,
    );
  } finally {
    await h.dispose();
  }
});
