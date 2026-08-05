import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reducer, type AppState } from './useStore';
import type { ContextStatsSnapshot, SessionSummary, TranscriptEvent } from '../types/bridge';

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

test('restored compaction history advances the meter generation and clears stale usage', () => {
  const restored = (id: string, ts: number): TranscriptEvent => ({
    id,
    appSessionId: 'm1',
    sourceSessionId: 'primary',
    role: 'primary',
    ts,
    kind: 'compaction',
  });
  const start: AppState = {
    ...initialState,
    sessions: { m1: session() },
    contextStats: { primary: { m1: snapshot(100_000) }, child: {} },
  };

  const next = reducer(start, {
    type: 'SESSION_HISTORY',
    appSessionId: 'm1',
    progress: [],
    transcripts: [restored('compact-1', 1), restored('compact-2', 2)],
    mode: 'replace',
    olderCursor: undefined,
    hasMore: false,
  });

  assert.equal(next.sessions.m1.autoCompactions, 2);
  assert.equal(next.sessions.m1.contextTokens, 0);
  assert.equal(next.contextStats.primary.m1, undefined);
});

test('live and provider-history dividers restore as one compaction generation', () => {
  const restored = (id: string, role: TranscriptEvent['role'] = 'primary'): TranscriptEvent => ({
    id,
    appSessionId: 'm1',
    sourceSessionId: role === 'primary' ? 'primary' : 'worker-1',
    role,
    ts: 1,
    kind: 'compaction',
  });
  const start: AppState = {
    ...initialState,
    sessions: { m1: session() },
    contextStats: { primary: { m1: snapshot(100_000) }, child: {} },
  };

  const next = reducer(start, {
    type: 'SESSION_HISTORY',
    appSessionId: 'm1',
    progress: [],
    transcripts: [
      restored('compaction-m1-summary-1'),
      restored('provider-session:compaction'),
      restored('compaction-worker-1-summary-1', 'worker'),
    ],
    mode: 'replace',
    olderCursor: undefined,
    hasMore: false,
  });

  assert.equal(next.sessions.m1.autoCompactions, 1);
  assert.equal(next.sessions.m1.contextTokens, 0);
  assert.equal(next.contextStats.primary.m1, undefined);
});

test('a delayed session summary cannot roll back a restored compaction generation', () => {
  const restored = {
    ...session(4),
    contextTokens: 25_000,
    contextRemainingTokens: 75_000,
    contextAccuracy: 'estimated' as const,
    contextUpdatedAt: '2026-08-05T08:00:00.000Z',
  };
  const start: AppState = {
    ...initialState,
    sessions: { m1: restored },
  };

  const next = reducer(start, { type: 'SESSION_UPDATED', session: session(0) });

  assert.equal(next.sessions.m1.autoCompactions, 4);
  assert.equal(next.sessions.m1.contextTokens, 25_000);
  assert.equal(next.sessions.m1.contextRemainingTokens, 75_000);
  assert.equal(next.sessions.m1.contextAccuracy, 'estimated');
  assert.equal(next.sessions.m1.contextUpdatedAt, '2026-08-05T08:00:00.000Z');
});

test('child runtime replacement clears only the prior exact-child context snapshot', () => {
  const start: AppState = {
    ...initialState,
    childSessions: {
      parent: {
        child: {
          parentAppSessionId: 'parent',
          childSessionId: 'child',
          role: 'worker',
          status: 'running',
          modelId: 'model-child',
          transcriptAvailable: true,
        },
      },
    },
    childRuntime: {
      parent: {
        child: { available: true, runtimeGeneration: 3 },
      },
    },
    contextStats: {
      primary: {},
      child: {
        parent: {
          child: snapshot(80_000),
          sibling: snapshot(20_000),
        },
        other: { child: snapshot(30_000) },
      },
    },
  };

  const next = reducer(start, {
    type: 'SESSION_CHILD',
    child: start.childSessions.parent.child,
    runtimeAvailable: true,
    runtimeGeneration: 4,
  });

  assert.equal(next.contextStats.child.parent?.child, undefined);
  assert.equal(next.contextStats.child.parent?.sibling?.used, 20_000);
  assert.equal(next.contextStats.child.other?.child?.used, 30_000);
});

test('child runtime unavailability clears a same-generation context snapshot', () => {
  const child = {
    parentAppSessionId: 'parent',
    childSessionId: 'child',
    role: 'worker' as const,
    status: 'paused' as const,
    modelId: 'model-child',
    transcriptAvailable: true,
  };
  const start: AppState = {
    ...initialState,
    childSessions: { parent: { child } },
    childRuntime: {
      parent: {
        child: { available: true, runtimeGeneration: 5 },
      },
    },
    childAccess: {
      parent: {
        child: { state: 'ready', requestId: 'open-child', runtimeGeneration: 5 },
      },
    },
    contextStats: {
      primary: {},
      child: { parent: { child: snapshot(70_000) } },
    },
  };

  const next = reducer(start, {
    type: 'SESSION_CHILD',
    child,
    runtimeAvailable: false,
    runtimeGeneration: 5,
  });

  assert.equal(next.contextStats.child.parent?.child, undefined);
  assert.deepEqual(next.childRuntime.parent?.child, {
    available: false,
    runtimeGeneration: 5,
  });
  assert.deepEqual(next.childAccess.parent?.child, {
    state: 'closed',
    requestId: null,
  });
});
