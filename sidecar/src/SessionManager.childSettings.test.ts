import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClientCommand } from './protocol.js';
import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import {
  createMission,
  exactSettingsEvents,
  latestSessionList,
  openChild,
} from './testing/childSettingsTestSupport.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

test(
  'exact child settings target only the resolved worker or validator backend',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await createMission(h, {
        workerModel: 'worker-role-default',
        validatorModel: 'validator-role-default',
      });
      const workerA = await openChild(
        h,
        'worker-logical-a',
        'worker-backend-a',
        'worker',
        'worker-old-a',
      );
      const workerB = await openChild(
        h,
        'worker-logical-b',
        'worker-backend-b',
        'worker',
        'worker-old-b',
      );
      const validator = await openChild(
        h,
        'validator-logical',
        'validator-backend',
        'validator',
        'validator-old',
      );
      await h.handle({
        type: 'settings.compaction.update',
        compactionTokenLimit: 700,
        compactionTokenLimitPerModel: {
          'worker-new': 211,
          'validator-new': 311,
        },
      });
      const parentProvider = h.provider.session('provider-1');
      const before = [
        workerA.settings.length,
        workerB.settings.length,
        validator.settings.length,
        parentProvider.settings.length,
      ];

      await h.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-logical-a',
        modelId: 'worker-new',
        reasoningEffort: 'high',
      });

      assert.deepEqual(
        workerA.settings.slice(before[0]).map((settings) => ({
          modelId: settings['modelId'],
          reasoningEffort: settings['reasoningEffort'],
          limit: settings['compactionTokenLimit'],
        })),
        [
          { modelId: 'worker-new', reasoningEffort: 'high', limit: undefined },
          { modelId: undefined, reasoningEffort: undefined, limit: 211 },
        ],
      );
      assert.equal(workerB.settings.length, before[1]);
      assert.equal(validator.settings.length, before[2]);
      assert.equal(parentProvider.settings.length, before[3]);
      const workerEvent = exactSettingsEvents(h.events, 'worker-logical-a').at(-1);
      assert.ok(workerEvent);
      assert.equal(workerEvent.parentAppSessionId, 'provider-1');
      assert.equal(workerEvent.modelId, 'worker-new');
      assert.equal('providerSessionId' in workerEvent, false);

      await h.handle({
        type: 'settings.compaction.update',
        compactionTokenLimit: 700,
        compactionTokenLimitPerModel: {
          'worker-new': 411,
          'validator-new': 311,
        },
      });
      assert.equal(workerA.settings.at(-1)?.['compactionTokenLimit'], 411);

      const validatorBefore = validator.settings.length;
      const parentBeforeValidator = parentProvider.settings.length;
      await h.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'validator-logical',
        modelId: 'validator-new',
      });
      assert.deepEqual(
        validator.settings.slice(validatorBefore).map((settings) => ({
          modelId: settings['modelId'],
          limit: settings['compactionTokenLimit'],
        })),
        [
          { modelId: 'validator-new', limit: undefined },
          { modelId: undefined, limit: 311 },
        ],
      );
      assert.equal(parentProvider.settings.length, parentBeforeValidator);

      await h.handle({ type: 'sessions.list' });
      const parent = latestSessionList(h.events).find(
        (session) => session.appSessionId === 'provider-1',
      );
      assert.equal(parent?.workerModelId, 'worker-role-default');
      assert.equal(parent?.validatorModelId, 'validator-role-default');
    } finally {
      await h.dispose();
    }
  },
);

test(
  'child default reset prefers the parent role model then the validated Factory role default',
  { concurrency: false },
  async () => {
    const explicit = createSessionManagerTestContext();
    try {
      await createMission(explicit, { workerModel: 'worker-role-default' });
      const child = await openChild(
        explicit,
        'worker-logical',
        'worker-backend',
        'worker',
        'worker-old',
      );
      await explicit.handle({
        type: 'settings.compaction.update',
        compactionTokenLimit: 700,
        compactionTokenLimitPerModel: {
          'worker-role-default': 271,
          'worker-old': 171,
        },
      });
      await explicit.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-logical',
        modelId: null,
      });
      assert.equal(child.settings.at(-2)?.['modelId'], 'worker-role-default');
      assert.equal(child.settings.at(-1)?.['compactionTokenLimit'], 271);
    } finally {
      await explicit.dispose();
    }

    const fallback = createSessionManagerTestContext();
    try {
      await createMission(fallback);
      const child = await openChild(
        fallback,
        'validator-logical',
        'validator-backend',
        'validator',
        'validator-old',
      );
      await fallback.handle({
        type: 'settings.compaction.update',
        compactionTokenLimit: 700,
        compactionTokenLimitPerModel: {
          'model-default': 381,
          'validator-old': 181,
        },
      });
      await fallback.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'validator-logical',
        modelId: null,
      });
      assert.equal(child.settings.at(-2)?.['modelId'], 'model-default');
      assert.equal(child.settings.at(-1)?.['compactionTokenLimit'], 381);
    } finally {
      await fallback.dispose();
    }
  },
);

test(
  'backend provider identity is never accepted as the child command identity',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await createMission(h);
      const child = await openChild(h, 'worker-logical', 'worker-backend', 'worker', 'worker-old');
      const writes = child.settings.length;

      await h.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-backend',
        modelId: 'must-not-apply',
      });

      assert.equal(child.settings.length, writes);
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'error' &&
            event.code === 'child.settings_target_invalid' &&
            event.parentAppSessionId === 'provider-1' &&
            event.childSessionId === 'worker-backend' &&
            !event.providerSessionId,
        ),
        true,
      );
    } finally {
      await h.dispose();
    }
  },
);

test(
  'a parent provider alias is never accepted as parentAppSessionId',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await createMission(h);
      const parent = h.provider.session('provider-1');
      parent.nextCompactResult = { newSessionId: 'parent-backend', removedCount: 1 };
      h.runtime.loadQueue.set('parent-backend', [
        new FakeFactorySession('parent-backend', {}, h.calls),
      ]);
      await h.handle({ type: 'session.compact', appSessionId: 'provider-1' });
      const child = new FakeFactorySession('child-backend', {}, h.calls);
      child.setInitModel('worker-old');
      h.runtime.loadQueue.set('child-logical', [child]);
      await h.handle({
        type: 'child.open',
        appSessionId: 'provider-1',
        providerSessionId: 'child-logical',
        role: 'worker',
      });
      const writes = child.settings.length;

      await h.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'parent-backend',
        childSessionId: 'child-logical',
        modelId: 'must-not-apply',
      });
      assert.equal(child.settings.length, writes);

      await h.handle({
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'child-logical',
        modelId: 'worker-new',
      });
      assert.equal(
        child.settings.slice(writes)[0]?.['modelId'],
        'worker-new',
        JSON.stringify(h.events.filter((event) => event.type === 'error')),
      );
    } finally {
      await h.dispose();
    }
  },
);

test(
  'a valid exact child rejects a model-less command without writes or success',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await createMission(h);
      const child = await openChild(h, 'worker-logical', 'worker-backend', 'worker', 'worker-old');
      const writes = child.settings.length;
      const successes = exactSettingsEvents(h.events, 'worker-logical').length;
      const malformed = {
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-logical',
        reasoningEffort: 'high',
      } as unknown as ClientCommand;

      await h.handle(malformed);

      assert.equal(child.settings.length, writes);
      assert.equal(exactSettingsEvents(h.events, 'worker-logical').length, successes);
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'error' &&
            event.code === 'child.settings_target_invalid' &&
            event.parentAppSessionId === 'provider-1' &&
            event.childSessionId === 'worker-logical',
        ),
        true,
      );
    } finally {
      await h.dispose();
    }
  },
);

test(
  'invalid exact-child targets fail without provider writes',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await h.create({
        sessionPurpose: 'chat',
        clientRef: 'ordinary',
        title: 'Ordinary',
        goal: 'go',
        interactionMode: 'auto',
        autonomy: 'low',
      });
      await h.waitForIdle();
      const before = h.provider.session('provider-1').settings.length;
      const malformed = {
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'missing',
        reasoningEffort: 'high',
      } as unknown as ClientCommand;
      await h.handle(malformed);

      assert.equal(h.provider.session('provider-1').settings.length, before);
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'error' &&
            event.code === 'child.settings_target_invalid' &&
            event.parentAppSessionId === 'provider-1' &&
            event.childSessionId === 'missing',
        ),
        true,
      );
    } finally {
      await h.dispose();
    }
  },
);
