import assert from 'node:assert/strict';
import test from 'node:test';

import { AutonomyLevel } from '@factory/droid-sdk';

import type * as Protocol from './protocol.js';
import {
  createMission,
  exactSettingsEvents,
  openChild,
  openChildForParent,
} from './testing/childSettingsTestSupport.js';
import {
  createSessionManagerTestContext,
  type SessionManagerTestContext,
} from './testing/sessionManagerTestContext.js';

function createChat(h: SessionManagerTestContext, autonomy: Protocol.Autonomy): Promise<void> {
  return h.create({
    sessionPurpose: 'chat',
    clientRef: 'autonomy-chat',
    title: 'Autonomy chat',
    goal: 'go',
    interactionMode: 'auto',
    autonomy,
  });
}

function updateAutonomy(
  h: SessionManagerTestContext,
  appSessionId: string,
  autonomy: Protocol.Autonomy,
): Promise<void> {
  return h.handle({ type: 'session.updateSettings', appSessionId, autonomy });
}

function errorEvents(events: Protocol.ServerEvent[]) {
  return events.filter((event) => event.type === 'error');
}

function sessionUpdates(events: Protocol.ServerEvent[], appSessionId: string) {
  return events.flatMap((event) =>
    event.type === 'session.updated' && event.session.appSessionId === appSessionId
      ? [event.session]
      : [],
  );
}

test('session.create without autonomy fails fast without starting a provider session', async () => {
  const h = createSessionManagerTestContext();
  try {
    // A client that predates the required snapshot: the bridge must reject the
    // command before any provider session is created.
    const command = {
      type: 'session.create',
      clientRef: 'missing-autonomy',
      title: 'Missing autonomy',
      goal: 'go',
      sessionPurpose: 'chat',
      interactionMode: 'auto',
    } as unknown as Protocol.ClientCommand;
    await h.handle(command);

    const errors = errorEvents(h.events);
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? '', /requires an explicit autonomy/);
    assert.equal(
      h.events.some((event) => event.type === 'session.created'),
      false,
    );
    assert.equal(h.runtime.createCalls.length, 0);
  } finally {
    await h.dispose();
  }
});

test('live autonomy update writes the provider first and publishes the confirmed level', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createChat(h, 'low');
    await h.waitForIdle();

    await updateAutonomy(h, 'provider-1', 'high');
    await h.waitForIdle();

    assert.deepEqual(h.provider.session('provider-1').settings.at(-1), {
      autonomyLevel: AutonomyLevel.High,
    });
    assert.equal(sessionUpdates(h.events, 'provider-1').at(-1)?.autonomy, 'high');
    assert.equal(errorEvents(h.events).length, 0);
  } finally {
    await h.dispose();
  }
});

test('autonomy update to the current level is a no-op', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createChat(h, 'low');
    await h.waitForIdle();
    const writesBefore = h.provider.session('provider-1').settings.length;

    await updateAutonomy(h, 'provider-1', 'low');
    await h.waitForIdle();

    assert.equal(h.provider.session('provider-1').settings.length, writesBefore);
    assert.equal(errorEvents(h.events).length, 0);
  } finally {
    await h.dispose();
  }
});

test('provider rejection surfaces a recoverable coded error and keeps the confirmed level', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createChat(h, 'low');
    await h.waitForIdle();
    h.provider.session('provider-1').nextUpdateSettingsError = new Error('provider rejected');

    await updateAutonomy(h, 'provider-1', 'high');
    await h.waitForIdle();

    const errors = errorEvents(h.events);
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.type === 'error' ? errors[0].code : undefined,
      'session.autonomy_update_failed',
    );
    assert.equal(errors[0]?.type === 'error' ? errors[0].recoverable : undefined, true);
    assert.equal(errors[0]?.type === 'error' ? errors[0].appSessionId : undefined, 'provider-1');
    assert.match(errors[0]?.message ?? '', /Could not change autonomy/);
    assert.equal(
      sessionUpdates(h.events, 'provider-1').some((session) => session.autonomy === 'high'),
      false,
    );
  } finally {
    await h.dispose();
  }
});

test(
  'queued autonomy updates serialize and apply in request order',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await createChat(h, 'low');
      await h.waitForIdle();
      const writes = h.provider.session('provider-1').settings;
      const writesBefore = writes.length;

      const gate = h.provider.deferNextUpdateSettings('provider-1');
      const first = updateAutonomy(h, 'provider-1', 'medium');
      await h.waitForIdle();
      const second = updateAutonomy(h, 'provider-1', 'high');
      await h.waitForIdle();

      // The second update must not reach the provider while the first is gated.
      assert.equal(writes.length, writesBefore + 1);

      gate.resolve();
      await Promise.all([first, second]);
      await h.waitForIdle();

      assert.deepEqual(writes.slice(writesBefore), [
        { autonomyLevel: AutonomyLevel.Medium },
        { autonomyLevel: AutonomyLevel.High },
      ]);
      assert.equal(sessionUpdates(h.events, 'provider-1').at(-1)?.autonomy, 'high');
    } finally {
      await h.dispose();
    }
  },
);

test(
  'an autonomy update that settles after close publishes nothing',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await createChat(h, 'low');
      await h.waitForIdle();

      const gate = h.provider.deferNextUpdateSettings('provider-1');
      const update = updateAutonomy(h, 'provider-1', 'high');
      await h.waitForIdle();
      await h.handle({ type: 'session.close', appSessionId: 'provider-1' });
      gate.resolve();
      await update;
      await h.waitForIdle();

      assert.equal(
        sessionUpdates(h.events, 'provider-1').some((session) => session.autonomy === 'high'),
        false,
      );
      assert.equal(errorEvents(h.events).length, 0);
    } finally {
      await h.dispose();
    }
  },
);

test('autonomy update on a session that is not live reports a recoverable error', async () => {
  const h = createSessionManagerTestContext();
  try {
    await updateAutonomy(h, 'missing-session', 'high');
    await h.waitForIdle();

    const errors = errorEvents(h.events);
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.type === 'error' ? errors[0].code : undefined,
      'session.autonomy_update_failed',
    );
    assert.equal(errors[0]?.type === 'error' ? errors[0].recoverable : undefined, true);
    assert.match(errors[0]?.message ?? '', /live session/);
  } finally {
    await h.dispose();
  }
});

test('child sessions publish confirmed autonomy only while their runtime is live', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createMission(h);

    await openChildForParent(h, 'provider-1', {
      childSessionId: 'worker-logical',
      providerSessionId: 'provider-worker',
      role: 'worker',
      modelId: 'worker-model',
      initAutonomy: 'medium',
    });
    const opened = exactSettingsEvents(h.events, 'provider-1', 'worker-logical').at(-1);
    assert.equal(opened?.autonomy, 'medium');

    // A child whose provider did not report autonomy publishes none.
    await openChild(h, 'validator-logical', 'provider-validator', 'validator', 'validator-model');
    const unreported = exactSettingsEvents(h.events, 'provider-1', 'validator-logical').at(-1);
    assert.equal(unreported !== undefined && 'autonomy' in unreported, false);

    // Autonomy is runtime-scoped: once the runtime closes, history carries none.
    await h.handle({ type: 'session.close', appSessionId: 'provider-1' });
    await h.handle({ type: 'session.loadHistory', appSessionId: 'provider-1' });
    const history = h.events.filter((event) => event.type === 'session.history').at(-1);
    const historical =
      history?.type === 'session.history'
        ? history.childSessions?.find((child) => child.childSessionId === 'worker-logical')
        : undefined;
    assert.equal(historical !== undefined && 'autonomy' in historical, false);
  } finally {
    await h.dispose();
  }
});
