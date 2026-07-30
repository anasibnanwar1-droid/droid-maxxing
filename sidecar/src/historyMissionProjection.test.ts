import assert from 'node:assert/strict';
import test from 'node:test';

import { projectMissionProgress, type PersistedChildSession } from './history.js';

const workerA: PersistedChildSession = {
  parentAppSessionId: 'parent-a',
  childSessionId: 'child-a',
  providerSessionId: 'provider-current-a',
  role: 'worker',
  status: 'completed',
  modelId: 'model',
  spawnLink: { kind: 'spawn', id: 'spawn-a' },
  transcriptAvailable: true,
  updatedAt: 1,
};

test('projects historical Mission progress through the exact persisted spawn link', () => {
  const progress = projectMissionProgress(
    [
      {
        type: 'worker_started',
        timestamp: '1',
        workerProviderSessionId: 'provider-old-a',
        spawnId: 'spawn-a',
      },
      {
        type: 'worker_selected_feature',
        timestamp: '2',
        workerProviderSessionId: 'provider-old-a',
        featureId: 'feature-a',
      },
      {
        type: 'worker_failed',
        timestamp: '3',
        spawnId: 'spawn-a',
        message: 'failed',
      },
      {
        type: 'worker_started',
        timestamp: '4',
        workerProviderSessionId: 'provider-current-a',
        spawnId: 'spawn-a',
      },
      {
        type: 'worker_started',
        timestamp: '5',
        workerProviderSessionId: 'provider-old-a',
        spawnId: 'spawn-a',
      },
      {
        type: 'worker_failed',
        timestamp: '6',
        workerProviderSessionId: 'provider-old-a',
        spawnId: 'spawn-a',
        message: 'stale failure',
      },
    ],
    [workerA],
  );

  assert.deepEqual(progress, [
    {
      type: 'worker_started',
      timestamp: '1',
      workerChildSessionId: 'child-a',
    },
    {
      type: 'worker_selected_feature',
      timestamp: '2',
      featureId: 'feature-a',
      workerChildSessionId: 'child-a',
    },
    {
      type: 'worker_failed',
      timestamp: '3',
      message: 'failed',
      workerChildSessionId: 'child-a',
    },
    {
      type: 'worker_started',
      timestamp: '4',
      workerChildSessionId: 'child-a',
    },
    {
      type: 'worker_started',
      timestamp: '5',
    },
    {
      type: 'worker_failed',
      timestamp: '6',
      message: 'stale failure',
    },
  ]);
  assert.equal(JSON.stringify(progress).includes('provider-old-a'), false);
  assert.equal(JSON.stringify(progress).includes('spawn-a'), false);
});

test('does not cross-resolve identical child IDs or provider names under another parent', () => {
  const foreign: PersistedChildSession = {
    ...workerA,
    parentAppSessionId: 'parent-b',
    spawnLink: { kind: 'spawn', id: 'spawn-b' },
  };
  const progress = projectMissionProgress(
    [
      {
        type: 'worker_started',
        timestamp: '1',
        workerProviderSessionId: 'provider-old-a',
        spawnId: 'spawn-a',
      },
    ],
    [foreign],
  );

  assert.deepEqual(progress, [{ type: 'worker_started', timestamp: '1' }]);
});

test('does not infer child membership from provider identity without WorkerStarted spawn proof', () => {
  const progress = projectMissionProgress(
    [
      {
        type: 'worker_selected_feature',
        timestamp: '1',
        workerProviderSessionId: 'provider-current-a',
        featureId: 'feature-a',
      },
    ],
    [workerA],
  );

  assert.deepEqual(progress, [
    {
      type: 'worker_selected_feature',
      timestamp: '1',
      featureId: 'feature-a',
    },
  ]);
});

test('rejects a historical provider being rebound to a different persisted spawn', () => {
  const workerB: PersistedChildSession = {
    ...workerA,
    childSessionId: 'child-b',
    providerSessionId: 'provider-current-b',
    spawnLink: { kind: 'spawn', id: 'spawn-b' },
  };
  const progress = projectMissionProgress(
    [
      {
        type: 'worker_started',
        timestamp: '1',
        workerProviderSessionId: 'provider-shared',
        spawnId: 'spawn-a',
      },
      {
        type: 'worker_started',
        timestamp: '2',
        workerProviderSessionId: 'provider-shared',
        spawnId: 'spawn-b',
      },
    ],
    [workerA, workerB],
  );

  assert.deepEqual(
    progress.map((entry) => entry.workerChildSessionId),
    ['child-a', undefined],
  );
});
