import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
import type { AppState } from './useStore';
import type { MissionSummary, TranscriptEvent } from '../types/bridge';

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
  // Regression guard for #18: a worker has no persisted summary.compactionCount,
  // so the meter needs a per-session generation bump from its compaction divider
  // to drop the stabilized high-water mark.
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

test('over-window live token estimates do not overwrite the visible context meter', () => {
  const now = Date.now();
  const mission: MissionSummary = {
    id: 'app-1',
    sessionId: 'droid-1',
    kind: 'chat',
    role: 'orchestrator',
    title: 'Test',
    goal: '',
    cwd: '',
    autonomy: 'medium',
    phase: 'running',
    features: [],
    tokensIn: 1,
    tokensOut: 2,
    contextTokens: 93_000,
    maxContextTokens: 100_000,
    createdAt: now,
    updatedAt: now,
  };
  const state = reducer(
    {
      ...(initialState as AppState),
      missions: { 'app-1': mission },
    },
    {
      type: 'MISSION_TOKENS',
      missionId: 'app-1',
      tokensIn: 10,
      tokensOut: 20,
      contextTokens: 200_000,
      maxContextTokens: 100_000,
    },
  );

  assert.equal(state.missions['app-1'].tokensIn, 10);
  assert.equal(state.missions['app-1'].tokensOut, 20);
  assert.equal(state.missions['app-1'].contextTokens, 93_000);
  assert.equal(state.missions['app-1'].maxContextTokens, 100_000);
});

test('stale over-window estimates are clamped back to the selected context window', () => {
  const now = Date.now();
  const mission: MissionSummary = {
    id: 'app-1',
    sessionId: 'droid-1',
    kind: 'chat',
    role: 'orchestrator',
    title: 'Test',
    goal: '',
    cwd: '',
    autonomy: 'medium',
    phase: 'running',
    features: [],
    tokensIn: 1,
    tokensOut: 2,
    contextTokens: 200_000,
    maxContextTokens: 100_000,
    contextAccuracy: 'estimated',
    createdAt: now,
    updatedAt: now,
  };
  const state = reducer(
    {
      ...(initialState as AppState),
      missions: { 'app-1': mission },
    },
    {
      type: 'MISSION_TOKENS',
      missionId: 'app-1',
      tokensIn: 10,
      tokensOut: 20,
      contextTokens: 200_000,
      maxContextTokens: 100_000,
    },
  );

  assert.equal(state.missions['app-1'].contextTokens, 100_000);
  assert.equal(state.missions['app-1'].maxContextTokens, 100_000);
});

test('exact over-window context stats survive live token updates', () => {
  const now = Date.now();
  const mission: MissionSummary = {
    id: 'app-1',
    sessionId: 'droid-1',
    kind: 'chat',
    role: 'orchestrator',
    title: 'Test',
    goal: '',
    cwd: '',
    autonomy: 'medium',
    phase: 'running',
    features: [],
    tokensIn: 1,
    tokensOut: 2,
    contextTokens: 120_000,
    maxContextTokens: 100_000,
    contextAccuracy: 'exact',
    createdAt: now,
    updatedAt: now,
  };
  const state = reducer(
    {
      ...(initialState as AppState),
      missions: { 'app-1': mission },
    },
    {
      type: 'MISSION_TOKENS',
      missionId: 'app-1',
      tokensIn: 10,
      tokensOut: 20,
      contextTokens: 200_000,
      maxContextTokens: 100_000,
    },
  );

  assert.equal(state.missions['app-1'].contextTokens, 120_000);
  assert.equal(state.missions['app-1'].maxContextTokens, 100_000);
});
