import assert from 'node:assert/strict';
import test from 'node:test';
import { PrimaryPromptDelivery } from './PrimaryPromptDelivery.js';
import { PrimaryPromptQueue, type PrimaryQueuedPrompt } from './PrimaryPromptQueue.js';
import type { SessionSummary } from './protocol.js';
import type { LiveSession } from './SessionLifecycle.js';
import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';

test('a stale turn cannot settle or update its replacement session', async () => {
  const oldSession = liveSession('app-1', 'provider-old');
  const replacement = liveSession('app-1', 'provider-new');
  let current = oldSession;
  const summaryUpdates: Partial<SessionSummary>[] = [];
  const redelivered: PrimaryQueuedPrompt[][] = [];
  let releaseTurn = (): void => {
    throw new Error('The old turn did not start.');
  };
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const delivery = new PrimaryPromptDelivery({
    registry: {
      getLive: () => current,
      updateSummary: (_appSessionId, patch) => {
        summaryUpdates.push(patch);
        return { ...current.summary, ...patch };
      },
    },
    runPrimaryTurn: () => turnGate,
    afterAutomaticCompactionTurn: () => undefined,
    redeliverQueuedPrompts: (_appSessionId, prompts) => {
      redelivered.push(prompts);
      return Promise.resolve();
    },
    isShutdownStarted: () => false,
    emitStatus: () => undefined,
    emitError: () => undefined,
  });

  const turning = delivery.send(oldSession, 'old turn');
  await Promise.resolve();
  await delivery.send(oldSession, 'queued for replacement');
  current = replacement;
  const updatesBeforeReplacement = summaryUpdates.length;
  releaseTurn();
  await turning;
  await Promise.resolve();

  assert.equal(summaryUpdates.length, updatesBeforeReplacement);
  assert.equal(replacement.streaming, false);
  assert.deepEqual(redelivered, [[{ text: 'queued for replacement', priority: 'queue' }]]);
});

function liveSession(appSessionId: string, providerSessionId: string): LiveSession {
  return {
    summary: summary(appSessionId, providerSessionId),
    session: new FakeFactorySession(providerSessionId, {}, []),
    streaming: false,
    autoCompacting: false,
    promptQueue: new PrimaryPromptQueue(),
    mcpServers: [],
    mcpConfigs: [],
  };
}

function summary(appSessionId: string, providerSessionId: string): SessionSummary {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: 'Session',
    goal: '',
    cwd: '',
    workspaceKind: 'none',
    autonomy: 'low',
    phase: 'paused',
    streaming: false,
    compacting: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}
