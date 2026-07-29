import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

test('failed provider identity persistence does not settle queued work', async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'compaction-persistence',
      title: 'Compaction persistence',
      goal: 'initial',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.waitForIdle();
    const compactGate = h.provider.deferNextCompaction('provider-1');
    h.provider.session('provider-1').nextCompactResult = {
      newSessionId: 'provider-9',
      removedCount: 1,
    };
    h.runtime.loadQueue.set('provider-9', [
      new Error('first adoption failed'),
      new Error('second adoption failed'),
    ]);

    const compacting = h.handle({ type: 'session.compact', appSessionId: 'provider-1' });
    await h.waitForIdle();
    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'must remain queued',
    });
    h.history.nextSyncError = new Error('history unavailable');
    compactGate.resolve();

    await assert.rejects(compacting, /history unavailable/);
    await h.waitForIdle();

    assert.deepEqual(h.provider.session('provider-1').prompts, ['initial']);
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' &&
          event.providerSessionId === 'provider-9' &&
          event.recoverable === true &&
          event.message === 'Could not persist compacted session identity: history unavailable',
      ),
      true,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' &&
          event.recoverable === true &&
          /reloading it failed/i.test(event.message),
      ),
      false,
    );
  } finally {
    await h.dispose();
  }
});
