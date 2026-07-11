import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reducer, type AppState } from './useStore';
import type { ContextStatsSnapshot, MissionSummary } from '../types/bridge';

const mission = (autoCompactions = 0): MissionSummary => ({
  id: 'm1',
  sessionId: 'm1',
  kind: 'chat',
  role: 'orchestrator',
  title: 'Context test',
  goal: '',
  cwd: '/tmp',
  autonomy: 'off',
  phase: 'running',
  features: [],
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: autoCompactions ? 0 : 100_000,
  contextAccuracy: autoCompactions ? undefined : 'exact',
  maxContextTokens: 100_000,
  autoCompactions,
  createdAt: 1,
  updatedAt: autoCompactions + 1,
});

const snapshot = (used: number): ContextStatsSnapshot => ({
  used,
  remaining: 100_000 - used,
  limit: 100_000,
  accuracy: 'exact',
  updatedAt: '2026-07-11T07:49:46.824Z',
});

test('MISSION_UPDATED invalidates stale context stats when compaction generation advances', () => {
  const start: AppState = {
    ...initialState,
    missions: { m1: mission(), m2: { ...mission(), id: 'm2', sessionId: 'm2' } },
    contextStats: { m1: snapshot(100_000), m2: snapshot(20_000) },
  };

  const next = reducer(start, { type: 'MISSION_UPDATED', mission: mission(1) });

  assert.equal(next.contextStats.m1, undefined);
  assert.equal(next.contextStats.m2?.used, 20_000);
  assert.equal(next.missions.m1.contextTokens, 0);
  assert.equal(next.missions.m1.autoCompactions, 1);
});

test('post-compaction context update installs the fresh lower reading', () => {
  const start: AppState = {
    ...initialState,
    missions: { m1: mission() },
    contextStats: { m1: snapshot(100_000) },
  };
  const compacted = reducer(start, { type: 'MISSION_UPDATED', mission: mission(1) });

  const refreshed = reducer(compacted, {
    type: 'CONTEXT_UPDATED',
    sessionId: 'm1',
    stats: snapshot(35_066),
  });

  assert.equal(refreshed.contextStats.m1?.used, 35_066);
  assert.equal(refreshed.missions.m1.contextTokens, 35_066);
});

test('ordinary mission updates retain the current context snapshot', () => {
  const current = mission();
  const start: AppState = {
    ...initialState,
    missions: { m1: current },
    contextStats: { m1: snapshot(80_000) },
  };

  const next = reducer(start, {
    type: 'MISSION_UPDATED',
    mission: { ...current, title: 'Renamed', updatedAt: 2 },
  });

  assert.equal(next.contextStats.m1?.used, 80_000);
});
