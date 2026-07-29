import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMission,
  openChild,
  openChildForParent,
} from './testing/childSettingsTestSupport.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

function invalidTargetErrors(
  events: ReturnType<typeof createSessionManagerTestContext>['events'],
  parentAppSessionId: string,
  childSessionId: string,
): number {
  return events.filter(
    (event) =>
      event.type === 'error' &&
      event.code === 'child.settings_target_invalid' &&
      event.parentAppSessionId === parentAppSessionId &&
      event.childSessionId === childSessionId,
  ).length;
}

test('a completed child is not an exact settings target', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createMission(h);
    const parent = h.provider.session('provider-1');
    const child = await openChild(h, 'worker-logical', 'worker-backend', 'worker', 'worker-old');
    parent.queueStreamEvents([
      {
        type: 'mission_worker_completed',
        workerSessionId: 'worker-logical',
        exitCode: 0,
      },
    ]);
    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'settle worker',
    });
    const writes = child.settings.length;

    await h.handle({
      type: 'child.updateSettings',
      parentAppSessionId: 'provider-1',
      childSessionId: 'worker-logical',
      modelId: 'must-not-apply',
    });

    assert.equal(child.settings.length, writes);
    assert.equal(invalidTargetErrors(h.events, 'provider-1', 'worker-logical'), 1);
  } finally {
    await h.dispose();
  }
});

test('a closing parent rejects exact child settings before provider issue', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createMission(h);
    const parent = h.provider.session('provider-1');
    const child = await openChild(h, 'worker-logical', 'worker-backend', 'worker', 'worker-old');
    const closeGate = parent.deferNextClose();
    const closing = h.handle({ type: 'session.close', appSessionId: 'provider-1' });
    await h.waitForIdle();
    const writes = child.settings.length;

    await h.handle({
      type: 'child.updateSettings',
      parentAppSessionId: 'provider-1',
      childSessionId: 'worker-logical',
      modelId: 'must-not-apply',
    });

    assert.equal(child.settings.length, writes);
    assert.equal(invalidTargetErrors(h.events, 'provider-1', 'worker-logical'), 1);
    closeGate.resolve();
    await closing;
  } finally {
    await h.dispose().catch(() => undefined);
  }
});

test('the same child identity under another parent is not interchangeable', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createMission(h);
    await createMission(h);
    const child = await openChildForParent(h, 'provider-1', {
      childSessionId: 'shared-logical',
      providerSessionId: 'worker-backend',
      role: 'worker',
      modelId: 'worker-old',
    });
    const writes = child.settings.length;

    await h.handle({
      type: 'child.updateSettings',
      parentAppSessionId: 'provider-2',
      childSessionId: 'shared-logical',
      modelId: 'must-not-apply',
    });

    assert.equal(child.settings.length, writes);
    assert.equal(invalidTargetErrors(h.events, 'provider-2', 'shared-logical'), 1);
  } finally {
    await h.dispose();
  }
});

test('a primary role cannot enter the parent-owned child map', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createMission(h);
    const loads = h.runtime.loadCalls.length;

    await h.handle({
      type: 'child.open',
      appSessionId: 'provider-1',
      providerSessionId: 'invalid-primary-child',
      role: 'primary',
    });

    assert.equal(h.runtime.loadCalls.length, loads);
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.updated' &&
          ('childSessionId' in event
            ? event.childSessionId === 'invalid-primary-child'
            : event.providerSessionId === 'invalid-primary-child'),
      ),
      false,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' &&
          event.code === 'child.open_failed' &&
          event.parentAppSessionId === 'provider-1' &&
          event.childSessionId === 'invalid-primary-child' &&
          !event.providerSessionId,
      ),
      true,
    );

    await h.handle({
      type: 'child.updateSettings',
      parentAppSessionId: 'provider-1',
      childSessionId: 'invalid-primary-child',
      modelId: 'must-not-apply',
    });
    assert.equal(invalidTargetErrors(h.events, 'provider-1', 'invalid-primary-child'), 1);
  } finally {
    await h.dispose();
  }
});
