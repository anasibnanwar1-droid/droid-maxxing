import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgressLogEntryType } from '@factory/droid-sdk';

import type { FactoryDefaultSettings } from './protocol.js';
import {
  createMission,
  exactSettingsEvents,
  latestSessionList,
  openChild,
} from './testing/childSettingsTestSupport.js';
import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

test('concurrent child settings updates serialize so the latest selection wins', async () => {
  const h = createSessionManagerTestContext();
  try {
    await createMission(h);
    const child = await openChild(h, 'worker-logical', 'worker-backend', 'worker', 'worker-old');
    const firstGate = h.provider.deferNextUpdateSettings('worker-backend');
    const writesBefore = child.settings.length;

    const first = h.handle({
      type: 'child.updateSettings',
      parentAppSessionId: 'provider-1',
      childSessionId: 'worker-logical',
      modelId: 'worker-first',
    });
    await h.waitForIdle();
    const second = h.handle({
      type: 'child.updateSettings',
      parentAppSessionId: 'provider-1',
      childSessionId: 'worker-logical',
      modelId: 'worker-latest',
    });
    await h.waitForIdle();

    assert.deepEqual(
      child.settings
        .slice(writesBefore)
        .filter((settings) => settings['modelId'])
        .map((settings) => settings['modelId']),
      ['worker-first'],
    );

    firstGate.resolve();
    await Promise.all([first, second]);

    assert.deepEqual(
      child.settings
        .slice(writesBefore)
        .filter((settings) => settings['modelId'])
        .map((settings) => settings['modelId']),
      ['worker-first', 'worker-latest'],
    );
    assert.equal(
      exactSettingsEvents(h.events, 'provider-1', 'worker-logical').at(-1)?.modelId,
      'worker-latest',
    );
  } finally {
    await h.dispose();
  }
});

test(
  'provider rejection commits no child success or compaction re-arm and role-default rejection stays truthful',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await createMission(h, { workerModel: 'worker-accepted' });
      const child = await openChild(h, 'worker-logical', 'worker-backend', 'worker', 'worker-old');
      const successes = exactSettingsEvents(h.events, 'provider-1', 'worker-logical').length;
      const writes = child.settings.length;
      child.nextUpdateSettingsError = new Error('child provider rejected');

      await h.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-logical',
        modelId: 'worker-rejected',
      });

      assert.equal(child.settings.length, writes + 1);
      assert.equal(child.settings.at(-1)?.['modelId'], 'worker-rejected');
      assert.equal(exactSettingsEvents(h.events, 'provider-1', 'worker-logical').length, successes);
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'child.error' &&
            event.code === 'child.settings_update_failed' &&
            event.parentAppSessionId === 'provider-1' &&
            event.childSessionId === 'worker-logical',
        ),
        true,
      );

      const parent = h.provider.session('provider-1');
      parent.nextUpdateSettingsError = new Error('role default rejected');
      await h.handle({
        type: 'settings.agent.update',
        appSessionId: 'provider-1',
        agent: 'worker',
        modelId: 'worker-false-projection',
      });
      await h.handle({ type: 'sessions.list' });
      assert.equal(
        latestSessionList(h.events).find((session) => session.appSessionId === 'provider-1')
          ?.workerModelId,
        'worker-accepted',
      );
    } finally {
      await h.dispose();
    }
  },
);

test(
  'a child settings completion after parent close cannot publish or re-arm',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await createMission(h);
      const child = await openChild(h, 'worker-logical', 'worker-backend', 'worker', 'worker-old');
      const gate = h.provider.deferNextUpdateSettings('worker-backend');
      const successes = exactSettingsEvents(h.events, 'provider-1', 'worker-logical').length;
      const update = h.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-logical',
        modelId: 'worker-late',
      });
      await h.waitForIdle();
      assert.equal(child.settings.at(-1)?.['modelId'], 'worker-late');
      const writesAfterProvider = child.settings.length;

      await h.handle({ type: 'session.close', appSessionId: 'provider-1' });
      gate.resolve();
      await update;

      assert.equal(exactSettingsEvents(h.events, 'provider-1', 'worker-logical').length, successes);
      assert.equal(child.settings.length, writesAfterProvider);
    } finally {
      await h.dispose();
    }
  },
);

test(
  'a child completed during limit resolution receives no compaction write',
  { concurrency: false },
  async () => {
    const defaults: FactoryDefaultSettings = {
      modelId: 'model-default',
      workerModelId: 'worker-default',
      validatorModelId: 'validator-default',
      interactionMode: 'auto',
      autonomy: 'low',
    };
    let readDefaults = (): Promise<FactoryDefaultSettings> => Promise.resolve(defaults);
    let releaseDefaults = (): void => undefined;
    const h = createSessionManagerTestContext({
      getFactoryDefaults: () => readDefaults(),
    });
    try {
      await createMission(h);
      const parent = h.provider.session('provider-1');
      const child = await openChild(h, 'worker-logical', 'worker-backend', 'worker', 'worker-old');
      h.provider.emitNotification('worker-backend', {
        jsonrpc: '2.0',
        method: 'droid.session_notification',
        params: {
          notification: {
            type: 'droid_working_state_changed',
            newState: 'compacting_conversation',
          },
        },
      });

      const blockedDefaults = new Promise<FactoryDefaultSettings>((resolve) => {
        releaseDefaults = () => resolve(defaults);
      });
      readDefaults = () => blockedDefaults;
      const writesBefore = child.settings.length;
      const update = h.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-logical',
        modelId: 'worker-new',
      });
      await h.waitForIdle();
      assert.equal(child.settings.length, writesBefore + 1);
      assert.equal(child.settings.at(-1)?.['modelId'], 'worker-new');

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
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'session.child' &&
            event.child.childSessionId === 'worker-logical' &&
            event.child.status === 'completed',
        ),
        true,
      );
      const writesAfterCompletion = child.settings.length;

      releaseDefaults();
      await update;
      assert.equal(child.settings.length, writesAfterCompletion);
    } finally {
      releaseDefaults();
      await h.dispose();
    }
  },
);

test(
  'child open emits no settings readiness after the parent closes',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await createMission(h);
      const child = new FakeFactorySession('worker-backend', {}, h.calls);
      child.setInitModel('worker-old');
      const gate = child.deferNextUpdateSettings();
      h.history.seedChildSessions([
        {
          parentAppSessionId: 'provider-1',
          childSessionId: 'worker-logical',
          providerSessionId: 'worker-backend',
          role: 'worker',
          status: 'paused',
          modelId: 'worker-old',
          transcriptAvailable: true,
          updatedAt: Date.now(),
        },
      ]);
      h.runtime.loadQueue.set('worker-backend', [child]);

      const opening = h.handle({
        type: 'child.open',
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-logical',
        requestId: 'open-worker-logical',
      });
      await h.waitForIdle();
      await h.handle({ type: 'session.close', appSessionId: 'provider-1' });
      gate.resolve();
      await opening;

      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'child.updated' &&
            event.childSessionId === 'worker-logical' &&
            event.access === 'ready',
        ),
        false,
      );
      assert.equal(
        h.calls.filter(
          (call) =>
            call.target === 'cleanup' &&
            call.method === 'session.close' &&
            call.args[0] === 'worker-backend',
        ).length,
        1,
      );
    } finally {
      await h.dispose();
    }
  },
);

test(
  'an evicted and replaced child cannot receive a stale settings completion',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await createMission(h);
      const original = await openChild(
        h,
        'worker-logical',
        'worker-backend-old',
        'worker',
        'worker-old',
      );
      for (let index = 1; index <= 3; index += 1) {
        await openChild(
          h,
          `filler-${String(index)}`,
          `filler-backend-${String(index)}`,
          'worker',
          'worker-old',
        );
      }
      const providerGate = original.deferNextUpdateSettings();
      const update = h.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-logical',
        modelId: 'stale-new-model',
      });
      await h.waitForIdle();
      assert.equal(original.settings.at(-1)?.['modelId'], 'stale-new-model');

      await openChild(h, 'filler-4', 'filler-backend-4', 'worker', 'worker-old');
      const replacement = await openChild(
        h,
        'worker-logical',
        'worker-backend-new',
        'worker',
        'replacement-model',
      );
      const originalWrites = original.settings.length;

      providerGate.resolve();
      await update;

      assert.equal(original.settings.length, originalWrites);
      assert.equal(
        replacement.settings.some((settings) => settings['modelId'] === 'stale-new-model'),
        false,
      );
      assert.equal(
        exactSettingsEvents(h.events, 'provider-1', 'worker-logical').some(
          (event) => event.modelId === 'stale-new-model',
        ),
        false,
      );
    } finally {
      await h.dispose();
    }
  },
);

test(
  'an exact child model acceptance invalidates a captured old-model global retune',
  { concurrency: false },
  async () => {
    const defaults: FactoryDefaultSettings = {
      modelId: 'model-default',
      workerModelId: 'worker-default',
      validatorModelId: 'validator-default',
      interactionMode: 'auto',
      autonomy: 'low',
    };
    let readDefaults = (): Promise<FactoryDefaultSettings> => Promise.resolve(defaults);
    let releaseDefaults = (): void => undefined;
    const h = createSessionManagerTestContext({
      getFactoryDefaults: () => readDefaults(),
    });
    try {
      await createMission(h);
      const child = await openChild(h, 'worker-logical', 'worker-backend', 'worker', 'old-model');
      const blockedDefaults = new Promise<FactoryDefaultSettings>((resolve) => {
        releaseDefaults = () => resolve(defaults);
      });
      readDefaults = () => blockedDefaults;
      const globalRetune = h.handle({
        type: 'settings.compaction.update',
        compactionTokenLimit: 900,
        compactionTokenLimitPerModel: {
          'old-model': 300,
          'new-model': 600,
        },
      });
      await h.waitForIdle();
      readDefaults = () => Promise.resolve(defaults);

      await h.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-logical',
        modelId: 'new-model',
      });
      const writesAfterAcceptance = child.settings.length;
      assert.deepEqual(
        child.settings.slice(-2).map((settings) => ({
          modelId: settings['modelId'],
          limit: settings['compactionTokenLimit'],
        })),
        [
          { modelId: 'new-model', limit: undefined },
          { modelId: undefined, limit: 600 },
        ],
      );

      releaseDefaults();
      await globalRetune;

      assert.equal(child.settings.length, writesAfterAcceptance);
      assert.equal(child.settings.at(-1)?.['compactionTokenLimit'], 600);
    } finally {
      releaseDefaults();
      await h.dispose();
    }
  },
);
