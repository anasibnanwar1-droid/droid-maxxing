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
