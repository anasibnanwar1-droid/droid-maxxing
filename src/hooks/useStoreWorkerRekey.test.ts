import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
import type { AppState } from './useStore';

test('MISSION_WORKER_REKEY remaps worker list, transcript events, context stats, and selection', () => {
  const start = {
    ...initialState,
    workers: { m1: [{ sessionId: 'w-old', status: 'running', startedAt: 1 }] },
    transcripts: {
      m1: [
        { id: 't1', missionId: 'm1', agentSessionId: 'w-old', kind: 'text', text: 'hi', ts: 1 },
        { id: 't2', missionId: 'm1', agentSessionId: 'orchestrator', kind: 'text', text: 'orch', ts: 2 },
      ],
    },
    contextStats: { 'w-old': { used: 10, remaining: 90, limit: 100, accuracy: 'estimated', updatedAt: 'x' } },
    selectedAgentSessionId: 'w-old',
  } as unknown as AppState;

  const next = reducer(start, { type: 'MISSION_WORKER_REKEY', missionId: 'm1', oldSessionId: 'w-old', newSessionId: 'w-new' });

  assert.equal(next.workers.m1[0].sessionId, 'w-new');
  // Only the worker's own transcript events move; the orchestrator's stay put.
  assert.equal(next.transcripts.m1[0].agentSessionId, 'w-new');
  assert.equal(next.transcripts.m1[1].agentSessionId, 'orchestrator');
  assert.equal(next.contextStats['w-old'], undefined);
  assert.deepEqual(next.contextStats['w-new'], { used: 10, remaining: 90, limit: 100, accuracy: 'estimated', updatedAt: 'x' });
  assert.equal(next.selectedAgentSessionId, 'w-new');
});

test('MISSION_WORKER_REKEY keeps fresh new-id context stats instead of clobbering with old', () => {
  // The backend refreshes context for the new id (post-compaction, lower usage)
  // before the rekey event, so fresh new-id stats already exist in the store.
  const start = {
    ...initialState,
    workers: { m1: [{ sessionId: 'w-old', status: 'running', startedAt: 1 }] },
    contextStats: {
      'w-old': { used: 95, remaining: 5, limit: 100, accuracy: 'estimated', updatedAt: 'old' },
      'w-new': { used: 12, remaining: 88, limit: 100, accuracy: 'estimated', updatedAt: 'new' },
    },
  } as unknown as AppState;

  const next = reducer(start, { type: 'MISSION_WORKER_REKEY', missionId: 'm1', oldSessionId: 'w-old', newSessionId: 'w-new' });

  assert.equal(next.contextStats['w-old'], undefined);
  // Fresh post-compaction stats survive; the stale old snapshot is dropped.
  assert.equal(next.contextStats['w-new'].used, 12);
  assert.equal(next.contextStats['w-new'].updatedAt, 'new');
});

test('MISSION_WORKER_REKEY migrates old stats when the new id has none yet', () => {
  const start = {
    ...initialState,
    workers: { m1: [{ sessionId: 'w-old', status: 'running', startedAt: 1 }] },
    contextStats: { 'w-old': { used: 40, remaining: 60, limit: 100, accuracy: 'estimated', updatedAt: 'old' } },
  } as unknown as AppState;

  const next = reducer(start, { type: 'MISSION_WORKER_REKEY', missionId: 'm1', oldSessionId: 'w-old', newSessionId: 'w-new' });

  assert.equal(next.contextStats['w-old'], undefined);
  assert.equal(next.contextStats['w-new'].used, 40);
});

test('MISSION_WORKER_REKEY leaves a non-selected worker selection untouched', () => {
  const start = {
    ...initialState,
    workers: { m1: [{ sessionId: 'w-old', status: 'running', startedAt: 1 }] },
    selectedAgentSessionId: 'orchestrator',
  } as unknown as AppState;

  const next = reducer(start, { type: 'MISSION_WORKER_REKEY', missionId: 'm1', oldSessionId: 'w-old', newSessionId: 'w-new' });

  assert.equal(next.workers.m1[0].sessionId, 'w-new');
  assert.equal(next.selectedAgentSessionId, 'orchestrator');
});

test('MISSION_WORKER_REKEY is a no-op when the id is unchanged', () => {
  const start = { ...initialState, selectedAgentSessionId: 'w' } as unknown as AppState;
  const next = reducer(start, { type: 'MISSION_WORKER_REKEY', missionId: 'm1', oldSessionId: 'w', newSessionId: 'w' });
  assert.equal(next, start);
});

test('MISSION_WORKER_REKEY records the old->new mapping so local views can follow it', () => {
  const start = { ...initialState, workers: { m1: [{ sessionId: 'w-old', status: 'running', startedAt: 1 }] } } as unknown as AppState;
  const once = reducer(start, { type: 'MISSION_WORKER_REKEY', missionId: 'm1', oldSessionId: 'w-old', newSessionId: 'w-a' });
  assert.equal(once.workerRekeys['w-old'], 'w-a');
  // A second compaction chains: both hops remain resolvable across renders.
  const twice = reducer(once, { type: 'MISSION_WORKER_REKEY', missionId: 'm1', oldSessionId: 'w-a', newSessionId: 'w-b' });
  assert.equal(twice.workerRekeys['w-old'], 'w-a');
  assert.equal(twice.workerRekeys['w-a'], 'w-b');
});

test('MISSION_WORKER_REKEY remaps mission feature worker ids and progress entries', () => {
  const start = {
    ...initialState,
    missions: {
      m1: {
        id: 'm1',
        features: [
          {
            id: 'f1',
            workerSessionIds: ['w-old', 'w-other'],
            currentWorkerSessionId: 'w-old',
            completedWorkerSessionId: null,
          },
          {
            id: 'f2',
            workerSessionIds: ['w-other'],
            currentWorkerSessionId: null,
            completedWorkerSessionId: 'w-old',
          },
        ],
      },
    },
    progress: {
      m1: [
        { type: 'worker_started', timestamp: '1', workerSessionId: 'w-old' },
        { type: 'worker_started', timestamp: '2', workerSessionId: 'w-other' },
      ],
    },
  } as unknown as AppState;

  const next = reducer(start, { type: 'MISSION_WORKER_REKEY', missionId: 'm1', oldSessionId: 'w-old', newSessionId: 'w-new' });

  const f1 = next.missions.m1.features[0];
  assert.deepEqual(f1.workerSessionIds, ['w-new', 'w-other']);
  assert.equal(f1.currentWorkerSessionId, 'w-new');
  const f2 = next.missions.m1.features[1];
  assert.equal(f2.completedWorkerSessionId, 'w-new');
  assert.deepEqual(f2.workerSessionIds, ['w-other']);
  assert.equal(next.progress.m1[0].workerSessionId, 'w-new');
  assert.equal(next.progress.m1[1].workerSessionId, 'w-other');
});
