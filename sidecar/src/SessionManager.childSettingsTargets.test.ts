import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgressLogEntryType } from '@factory/droid-sdk';

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
      event.type === 'child.error' &&
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
        type: 'mission_progress_entry',
        progressLog: [
          {
            type: ProgressLogEntryType.WorkerStarted,
            timestamp: '2026-07-29T00:00:00.000Z',
            workerSessionId: 'worker-backend',
            spawnId: 'spawn-worker-logical',
          },
        ],
      },
      {
        type: 'mission_worker_completed',
        workerSessionId: 'worker-backend',
        exitCode: 0,
      },
    ]);
    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'settle worker',
    });
    const writes = child.settings.length;
    const errors = invalidTargetErrors(h.events, 'provider-1', 'worker-logical');

    await h.handle({
      type: 'child.updateSettings',
      parentAppSessionId: 'provider-1',
      childSessionId: 'worker-logical',
      modelId: 'must-not-apply',
    });

    assert.equal(child.settings.length, writes);
    assert.equal(invalidTargetErrors(h.events, 'provider-1', 'worker-logical'), errors + 1);
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

test('an unknown child cannot enter the parent-owned child map', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createMission(h);
    const loads = h.runtime.loadCalls.length;

    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'unknown-child',
      requestId: 'open-unknown-child',
    });

    assert.equal(h.runtime.loadCalls.length, loads);
    assert.equal(
      h.events.some(
        (event) => event.type === 'child.updated' && event.childSessionId === 'unknown-child',
      ),
      false,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.error' &&
          event.code === 'child.not_in_session' &&
          event.parentAppSessionId === 'provider-1' &&
          event.childSessionId === 'unknown-child',
      ),
      true,
    );

    await h.handle({
      type: 'child.updateSettings',
      parentAppSessionId: 'provider-1',
      childSessionId: 'unknown-child',
      modelId: 'must-not-apply',
    });
    assert.equal(invalidTargetErrors(h.events, 'provider-1', 'unknown-child'), 1);
  } finally {
    await h.dispose();
  }
});
