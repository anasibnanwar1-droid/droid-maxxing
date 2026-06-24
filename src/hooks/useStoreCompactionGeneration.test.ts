import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
import type { AppState } from './useStore';
import type { TranscriptEvent } from '../types/bridge';

function compaction(id: string, agentSessionId: string) {
  return {
    type: 'MISSION_TRANSCRIPT',
    event: {
      id,
      missionId: 'app-1',
      agentSessionId,
      role: 'worker',
      kind: 'compaction',
      removedCount: 3,
      ts: Date.now(),
    } as TranscriptEvent,
  } as const;
}

test('a worker compaction divider bumps that session generation (resets the worker meter)', () => {
  // Regression guard for #18: a worker auto-compacts in place under the same
  // session id, so the meter needs a per-session generation bump (the worker has
  // no persisted summary.compactionCount) to drop its stabilized high-water mark.
  let state = initialState as AppState;
  assert.equal(state.compactionGenerations['worker-1'] ?? 0, 0);
  state = reducer(state, compaction('c1', 'worker-1'));
  assert.equal(state.compactionGenerations['worker-1'], 1);
  state = reducer(state, compaction('c2', 'worker-1'));
  assert.equal(state.compactionGenerations['worker-1'], 2);
});

test('a duplicate compaction divider does not double-count the generation', () => {
  let state = initialState as AppState;
  state = reducer(state, compaction('c1', 'worker-1'));
  state = reducer(state, compaction('c1', 'worker-1'));
  assert.equal(state.compactionGenerations['worker-1'], 1);
});

test('compaction generations are scoped per agent session id', () => {
  let state = initialState as AppState;
  state = reducer(state, compaction('c1', 'worker-1'));
  state = reducer(state, compaction('c2', 'worker-2'));
  assert.equal(state.compactionGenerations['worker-1'], 1);
  assert.equal(state.compactionGenerations['worker-2'], 1);
});

test('a non-compaction transcript event leaves compaction generations untouched', () => {
  let state = initialState as AppState;
  state = reducer(state, {
    type: 'MISSION_TRANSCRIPT',
    event: {
      id: 't1',
      missionId: 'app-1',
      agentSessionId: 'worker-1',
      role: 'worker',
      kind: 'text',
      text: 'hi',
      ts: Date.now(),
    } as TranscriptEvent,
  });
  assert.equal(state.compactionGenerations['worker-1'] ?? 0, 0);
});
