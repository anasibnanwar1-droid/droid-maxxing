import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
import type { AppState } from './useStore';
import type { ContextStatsSnapshot, MissionSummary } from '../types/bridge';

function mission(contextTokens: number, streaming: boolean): MissionSummary {
  return {
    id: 'm1',
    sessionId: 'm1',
    kind: 'chat',
    role: 'orchestrator',
    title: 'm1',
    goal: 'm1',
    cwd: '',
    workspaceKind: 'none',
    autonomy: 'low',
    phase: streaming ? 'running' : 'paused',
    streaming,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens,
    maxContextTokens: 200_000,
    createdAt: 1,
    updatedAt: 1,
  };
}

function stats(used: number): ContextStatsSnapshot {
  return {
    used,
    remaining: Math.max(0, 200_000 - used),
    limit: 200_000,
    accuracy: 'estimated',
    updatedAt: String(used),
  };
}

function exactStats(used: number): ContextStatsSnapshot {
  return { ...stats(used), accuracy: 'exact' };
}

function statsWithBreakdown(used: number, breakdownUsed: number): ContextStatsSnapshot {
  return {
    ...stats(used),
    remaining: Math.max(0, 200_000 - used),
    breakdown: {
      contextBudget: 200_000,
      usedTokens: breakdownUsed,
      freeTokens: Math.max(0, 200_000 - breakdownUsed),
      categories: [{ name: 'Messages', tokens: breakdownUsed }],
    },
  };
}

test('streaming token updates do not move context usage backward', () => {
  const start = {
    ...initialState,
    missions: { m1: mission(120_000, true) },
  } as unknown as AppState;

  const next = reducer(start, {
    type: 'MISSION_TOKENS',
    missionId: 'm1',
    tokensIn: 10,
    tokensOut: 2,
    contextTokens: 100_000,
    maxContextTokens: 200_000,
  });

  assert.equal(next.missions.m1.contextTokens, 120_000);
});

test('streaming context stats do not flicker below the current live usage', () => {
  const start = {
    ...initialState,
    missions: { m1: mission(120_000, true) },
  } as unknown as AppState;

  const next = reducer(start, { type: 'CONTEXT_UPDATED', sessionId: 'm1', stats: stats(100_000) });

  assert.equal(next.missions.m1.contextTokens, 120_000);
  assert.equal(next.contextStats.m1.used, 120_000);
  assert.equal(next.contextStats.m1.remaining, 80_000);
});

test('idle context stats can drop after compaction', () => {
  const start = {
    ...initialState,
    missions: { m1: mission(180_000, false) },
  } as unknown as AppState;

  const next = reducer(start, { type: 'CONTEXT_UPDATED', sessionId: 'm1', stats: stats(40_000) });

  assert.equal(next.missions.m1.contextTokens, 40_000);
  assert.equal(next.contextStats.m1.used, 40_000);
});

test('exact context stats replace impossible cumulative usage while streaming', () => {
  const start = {
    ...initialState,
    missions: { m1: mission(10_603_766, true) },
  } as unknown as AppState;

  const next = reducer(start, {
    type: 'CONTEXT_UPDATED',
    sessionId: 'm1',
    stats: exactStats(40_000),
  });

  assert.equal(next.missions.m1.contextTokens, 40_000);
  assert.equal(next.contextStats.m1.used, 40_000);
});

test('exact context stats can reset the meter after compaction while streaming', () => {
  const start = {
    ...initialState,
    missions: { m1: mission(120_000, true) },
  } as unknown as AppState;

  const next = reducer(start, {
    type: 'CONTEXT_UPDATED',
    sessionId: 'm1',
    stats: exactStats(40_000),
  });

  assert.equal(next.missions.m1.contextTokens, 40_000);
  assert.equal(next.contextStats.m1.used, 40_000);
  assert.equal(next.contextStats.m1.remaining, 160_000);
});

test('token updates ignore impossible context counts', () => {
  const start = {
    ...initialState,
    missions: { m1: mission(120_000, true) },
  } as unknown as AppState;

  const next = reducer(start, {
    type: 'MISSION_TOKENS',
    missionId: 'm1',
    tokensIn: 10_603_766,
    tokensOut: 78_367,
    contextTokens: 10_603_766,
    maxContextTokens: 200_000,
  });

  assert.equal(next.missions.m1.tokensIn, 10_603_766);
  assert.equal(next.missions.m1.tokensOut, 78_367);
  assert.equal(next.missions.m1.contextTokens, 120_000);
});

test('streaming estimated breakdown can correct a saturated context meter', () => {
  const start = {
    ...initialState,
    missions: { m1: mission(200_000, true) },
    contextStats: { m1: statsWithBreakdown(200_000, 200_000) },
  } as unknown as AppState;

  const next = reducer(start, {
    type: 'CONTEXT_UPDATED',
    sessionId: 'm1',
    stats: statsWithBreakdown(154_982, 154_982),
  });

  assert.equal(next.missions.m1.contextTokens, 154_982);
  assert.equal(next.contextStats.m1.used, 154_982);
  assert.equal(next.contextStats.m1.breakdown?.usedTokens, 154_982);
});
