import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DroidClient,
  DroidSession,
  InitializeSessionResultSchema,
  ReasoningEffort,
} from '@factory/droid-sdk';
import { createFactorySession, createInitializeSessionParams } from './DroidRuntime.js';

test('passes compaction settings when initializing a session', () => {
  const params = createInitializeSessionParams({
    cwd: '/tmp/project',
    interactionMode: 'auto',
    modelId: 'main-model',
    compactionModel: 'summary-model',
    compactionTokenLimit: 400_000,
  });

  assert.equal(params.compactionModel, 'summary-model');
  assert.equal(params.compactionTokenLimit, 400_000);
});

test('passes current-model compaction sentinel when initializing a session', () => {
  const params = createInitializeSessionParams({
    cwd: '/tmp/project',
    interactionMode: 'auto',
    modelId: 'main-model',
    compactionModel: 'current-model',
  });

  assert.equal(params.compactionModel, 'current-model');
});

test('factory sessions preserve the SDK closed-session guard for native steering', async () => {
  let addUserMessageCalls = 0;
  const client = {
    addUserMessage: async () => {
      addUserMessageCalls += 1;
      return {};
    },
    closeSession: async () => ({}),
    close: async () => undefined,
  } as unknown as DroidClient;
  const init = InitializeSessionResultSchema.parse({
    sessionId: 'provider-closed',
    session: {},
    settings: {
      modelId: 'model-default',
      reasoningEffort: ReasoningEffort.Medium,
    },
  });
  const session = createFactorySession(new DroidSession(client, init.sessionId, init), client);

  await session.close();
  await assert.rejects(session.send('late steer'), /closed/i);
  assert.equal(addUserMessageCalls, 0);
});
