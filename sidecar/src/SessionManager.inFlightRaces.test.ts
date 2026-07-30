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
      ['session.closed', 'sessions.list'],
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
    child.deferNextUpdateSettings();
    h.history.seedChildSessions([
      {
        parentAppSessionId: 'provider-1',
        childSessionId: 'opening-logical',
        providerSessionId: 'opening-backend',
        role: 'validator',
        status: 'paused',
        modelId: 'model-default',
        transcriptAvailable: true,
        updatedAt: Date.now(),
      },
    ]);
    h.runtime.loadQueue.set('opening-backend', [child]);
    const opening = h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'opening-logical',
      requestId: 'open-opening-logical',
    });
    await h.waitForIdle();

    await h.shutdown();
    await opening;

    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.updated' &&
          event.childSessionId === 'opening-logical' &&
          event.access === 'ready',
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
    h.history.seedChildSessions([
      {
        parentAppSessionId: 'provider-1',
        childSessionId: 'same-logical',
        providerSessionId: 'same-backend',
        role: 'worker',
        status: 'paused',
        modelId: 'model-default',
        transcriptAvailable: true,
        updatedAt: Date.now(),
      },
    ]);
    h.runtime.loadQueue.set('same-backend', [child]);
    const command = {
      type: 'child.open' as const,
      parentAppSessionId: 'provider-1',
      childSessionId: 'same-logical',
      requestId: 'open-same-logical',
    };

    const opening = h.handle(command);
    await h.waitForIdle();
    const sending = h.handle({
      type: 'child.send',
      parentAppSessionId: 'provider-1',
      childSessionId: 'same-logical',
      text: 'queued during open',
    });
    await h.waitForIdle();
    assert.deepEqual(child.prompts, []);
    armGate.resolve();
    await Promise.all([opening, sending]);

    assert.equal(h.runtime.loadCalls.filter((call) => call.sessionId === 'same-backend').length, 1);
    assert.deepEqual(child.prompts, ['queued during open']);
    assert.equal(
      h.events.filter(
        (event) =>
          event.type === 'child.updated' &&
          event.childSessionId === 'same-logical' &&
          event.access === 'ready',
      ).length,
      1,
    );
  } finally {
    await h.dispose();
  }
});

test('joined child opens cannot settle after the parent closes', async () => {
  const h = createSessionManagerTestContext();
  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'joined-open-close',
      title: 'Joined open close',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await h.provider.waitForPrompts('provider-1', 1);
    await h.waitForIdle();
    const child = new FakeFactorySession('joined-backend', {}, h.calls);
    child.deferNextUpdateSettings();
    h.history.seedChildSessions([
      {
        parentAppSessionId: 'provider-1',
        childSessionId: 'joined-logical',
        providerSessionId: 'joined-backend',
        role: 'worker',
        status: 'paused',
        modelId: 'model-default',
        transcriptAvailable: true,
        updatedAt: Date.now(),
      },
    ]);
    h.runtime.loadQueue.set('joined-backend', [child]);

    const first = h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'joined-logical',
      requestId: 'joined-open-1',
    });
    await h.waitForIdle();
    const second = h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'joined-logical',
      requestId: 'joined-open-2',
    });
    await h.waitForIdle();
    await h.handle({ type: 'session.close', appSessionId: 'provider-1' });
    const eventsAfterClose = h.events.length;

    await Promise.all([first, second]);
    await h.waitForIdle();

    assert.equal(h.events.length, eventsAfterClose);
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.updated' &&
          (event.requestId === 'joined-open-1' || event.requestId === 'joined-open-2'),
      ),
      false,
    );
    assert.equal(
      h.calls.filter(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'session.close' &&
          call.args[0] === 'joined-backend',
      ).length,
      1,
    );
  } finally {
    await h.dispose().catch(() => undefined);
  }
});

test('an existing child runtime cannot acknowledge after parent close admission', async () => {
  const h = createSessionManagerTestContext();
  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'existing-open-close',
      title: 'Existing open close',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await h.provider.waitForPrompts('provider-1', 1);
    await h.waitForIdle();
    h.history.seedChildSessions([
      {
        parentAppSessionId: 'provider-1',
        childSessionId: 'existing-logical',
        providerSessionId: 'existing-backend',
        role: 'worker',
        status: 'paused',
        modelId: 'model-default',
        transcriptAvailable: true,
        updatedAt: Date.now(),
      },
    ]);
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'existing-logical',
      requestId: 'existing-open-initial',
    });
    const parent = h.provider.session('provider-1');
    const closeGate = parent.deferNextClose();
    const closing = h.handle({ type: 'session.close', appSessionId: 'provider-1' });
    await h.waitForIdle();
    const eventsAtCloseAdmission = h.events.length;

    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'existing-logical',
      requestId: 'existing-open-stale',
    });

    assert.equal(h.events.length, eventsAtCloseAdmission);
    assert.equal(
      h.events.some(
        (event) => event.type === 'child.updated' && event.requestId === 'existing-open-stale',
      ),
      false,
    );
    closeGate.resolve();
    await closing;
  } finally {
    await h.dispose().catch(() => undefined);
  }
});
