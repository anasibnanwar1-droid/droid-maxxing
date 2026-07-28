import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClientCommand, ServerEvent, SessionRole, SessionSummary } from './protocol.js';
import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import {
  createSessionManagerTestContext,
  type SessionManagerTestContext,
} from './testing/sessionManagerTestContext.js';

function latestSessionList(events: ServerEvent[]): SessionSummary[] {
  return events.filter((event) => event.type === 'sessions.list').at(-1)?.sessions ?? [];
}

async function createMission(
  h: SessionManagerTestContext,
  options: {
    workerModel?: string;
    validatorModel?: string;
  } = {},
): Promise<void> {
  await h.create({
    sessionPurpose: 'mission-control',
    clientRef: 'child-settings',
    title: 'Child settings',
    goal: 'go',
    interactionMode: 'agi',
    autonomy: 'low',
    ...options,
  });
  await h.waitForIdle();
}

async function openChild(
  h: SessionManagerTestContext,
  childSessionId: string,
  providerSessionId: string,
  role: Exclude<SessionRole, 'primary'>,
  modelId: string,
): Promise<FakeFactorySession> {
  const child = new FakeFactorySession(providerSessionId, {}, h.calls);
  child.setInitModel(modelId);
  h.runtime.loadQueue.set(childSessionId, [child]);
  await h.handle({
    type: 'child.open',
    appSessionId: 'provider-1',
    providerSessionId: childSessionId,
    role,
  });
  assert.equal(
    h.events.some(
      (event) =>
        event.type === 'child.updated' &&
        'parentAppSessionId' in event &&
        event.parentAppSessionId === 'provider-1' &&
        event.childSessionId === childSessionId &&
        event.role === role &&
        event.settingsReady,
    ),
    true,
  );
  return child;
}

function exactSettingsEvents(
  events: ServerEvent[],
  childSessionId: string,
): Extract<ServerEvent, { type: 'session.child' }>[] {
  return events.filter(
    (event): event is Extract<ServerEvent, { type: 'session.child' }> =>
      event.type === 'session.child' &&
      'childSessionId' in event &&
      event.childSessionId === childSessionId,
  );
}

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
      const before = [workerA.settings.length, workerB.settings.length, validator.settings.length];

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
          limit: settings['compactionTokenLimit'],
        })),
        [
          { modelId: 'worker-new', limit: undefined },
          { modelId: undefined, limit: 211 },
        ],
      );
      assert.equal(workerB.settings.length, before[1]);
      assert.equal(validator.settings.length, before[2]);
      const workerEvent = exactSettingsEvents(h.events, 'worker-logical-a').at(-1);
      assert.ok(workerEvent && 'childSessionId' in workerEvent);
      assert.equal(workerEvent.parentAppSessionId, 'provider-1');
      assert.equal(workerEvent.modelId, 'worker-new');
      assert.equal('providerSessionId' in workerEvent, false);

      const validatorBefore = validator.settings.length;
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
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'worker-logical',
        modelId: null,
      });
      assert.equal(child.settings.at(-2)?.['modelId'], 'worker-role-default');
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
        type: 'child.updateSettings',
        parentAppSessionId: 'provider-1',
        childSessionId: 'validator-logical',
        modelId: null,
      });
      assert.equal(child.settings.at(-2)?.['modelId'], 'model-default');
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
  'provider rejection commits no child success or compaction re-arm and role-default rejection stays truthful',
  { concurrency: false },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      await createMission(h, { workerModel: 'worker-accepted' });
      const child = await openChild(h, 'worker-logical', 'worker-backend', 'worker', 'worker-old');
      const successes = exactSettingsEvents(h.events, 'worker-logical').length;
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
      assert.equal(exactSettingsEvents(h.events, 'worker-logical').length, successes);
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'error' &&
            event.code === 'child.settings_update_failed' &&
            event.parentAppSessionId === 'provider-1' &&
            event.childSessionId === 'worker-logical' &&
            !event.providerSessionId,
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
      const successes = exactSettingsEvents(h.events, 'worker-logical').length;
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

      assert.equal(exactSettingsEvents(h.events, 'worker-logical').length, successes);
      assert.equal(child.settings.length, writesAfterProvider);
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
      h.runtime.loadQueue.set('worker-logical', [child]);

      const opening = h.handle({
        type: 'child.open',
        appSessionId: 'provider-1',
        providerSessionId: 'worker-logical',
        role: 'worker',
      });
      await h.waitForIdle();
      await h.handle({ type: 'session.close', appSessionId: 'provider-1' });
      gate.resolve();
      await opening;

      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'child.updated' &&
            'parentAppSessionId' in event &&
            event.childSessionId === 'worker-logical' &&
            event.settingsReady,
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
