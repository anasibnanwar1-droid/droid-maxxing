import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reducer, type AppState } from './useStore';
import type { ContextStatsSnapshot, SessionSummary } from '../types/bridge';

const session = (autoCompactions = 0): SessionSummary => ({
  appSessionId: 'm1',
  providerSessionId: 'provider-1',
  sessionPurpose: 'chat',
  interactionMode: 'auto',
  role: 'primary',
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

test('SESSION_UPDATED invalidates stale context stats when compaction generation advances', () => {
  const start: AppState = {
    ...initialState,
    sessions: {
      m1: session(),
      m2: {
        ...session(),
        appSessionId: 'm2',
        providerSessionId: 'provider-2',
      },
    },
    contextStats: {
      primary: { m1: snapshot(100_000), m2: snapshot(20_000) },
      child: {},
    },
  };

  const next = reducer(start, { type: 'SESSION_UPDATED', session: session(1) });

  assert.equal(next.contextStats.primary.m1, undefined);
  assert.equal(next.contextStats.primary.m2?.used, 20_000);
  assert.equal(next.sessions.m1.contextTokens, 0);
  assert.equal(next.sessions.m1.autoCompactions, 1);
});

test('post-compaction context update installs the fresh lower reading', () => {
  const start: AppState = {
    ...initialState,
    sessions: { m1: session() },
    contextStats: { primary: { m1: snapshot(100_000) }, child: {} },
  };
  const compacted = reducer(start, { type: 'SESSION_UPDATED', session: session(1) });

  const refreshed = reducer(compacted, {
    type: 'CONTEXT_UPDATED',
    appSessionId: 'm1',
    sourceSessionId: 'provider-2',
    stats: snapshot(35_066),
  });

  assert.equal(refreshed.contextStats.primary.m1?.used, 35_066);
  assert.equal(refreshed.sessions.m1.contextTokens, 35_066);
});

test('ordinary session updates retain the current context snapshot', () => {
  const current = session();
  const start: AppState = {
    ...initialState,
    sessions: { m1: current },
    contextStats: { primary: { m1: snapshot(80_000) }, child: {} },
  };

  const next = reducer(start, {
    type: 'SESSION_UPDATED',
    session: { ...current, title: 'Renamed', updatedAt: 2 },
  });

  assert.equal(next.contextStats.primary.m1?.used, 80_000);
});
