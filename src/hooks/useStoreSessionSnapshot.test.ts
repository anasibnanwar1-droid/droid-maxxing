import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
import type { AppState } from './useStore';
import type { SessionSummary } from '../types/bridge';

function summary(id: string, updatedAt = 1): SessionSummary {
  return {
    appSessionId: id,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: `Chat ${id}`,
    goal: `Chat ${id}`,
    cwd: '/repo',
    autonomy: 'low',
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}

function hydratedState(): AppState {
  return {
    ...(initialState as unknown as AppState),
    sessions: { stale: summary('stale', 1), kept: summary('kept', 2) },
    sessionOrder: ['kept', 'stale'],
    listConfirmedSessionIds: ['stale', 'kept'],
  };
}

test('the first SESSION_LIST prunes hydrated rows the sidecar does not confirm', () => {
  const next = reducer(hydratedState(), {
    type: 'SESSION_LIST',
    sessions: [summary('kept', 3), summary('fresh', 4)],
  });
  assert.deepEqual(Object.keys(next.sessions).sort(), ['fresh', 'kept']);
  assert.deepEqual(next.sessionOrder, ['fresh', 'kept']);
  assert.deepEqual(next.listConfirmedSessionIds, ['kept', 'fresh']);
});

test('locally created sessions survive the confirming SESSION_LIST', () => {
  const created = reducer(hydratedState(), {
    type: 'SESSION_CREATED',
    clientRef: 'ref-1',
    session: summary('optimistic', 5),
  });
  const next = reducer(created, { type: 'SESSION_LIST', sessions: [summary('kept', 3)] });
  assert.deepEqual(Object.keys(next.sessions).sort(), ['kept', 'optimistic']);
  assert.deepEqual(next.listConfirmedSessionIds, ['kept']);
});

test('a session updated before the first SESSION_LIST survives the prune', () => {
  // The snapshot marker set is fixed at hydration; a live update for a
  // session outside it (e.g. a background session the bridge reports before
  // the first list) must not make it prunable.
  const updated = reducer(hydratedState(), {
    type: 'SESSION_UPDATED',
    session: summary('live', 50),
  });
  const next = reducer(updated, { type: 'SESSION_LIST', sessions: [summary('kept', 3)] });
  assert.deepEqual(Object.keys(next.sessions).sort(), ['kept', 'live']);
});

test('a pruned active session clears the dangling activeAppSessionId', () => {
  const state: AppState = { ...hydratedState(), activeAppSessionId: 'stale' };
  const next = reducer(state, { type: 'SESSION_LIST', sessions: [summary('kept', 3)] });
  assert.equal(next.activeAppSessionId, null);
});

test('a confirmed active session keeps activeAppSessionId', () => {
  const state: AppState = { ...hydratedState(), activeAppSessionId: 'kept' };
  const next = reducer(state, { type: 'SESSION_LIST', sessions: [summary('kept', 3)] });
  assert.equal(next.activeAppSessionId, 'kept');
});

test('a later SESSION_LIST drops rows the previous list confirmed but it omits', () => {
  // Regression test: a session deleted outside the app (CLI, parallel
  // instance) must disappear from the sidebar when the watcher republishes,
  // not linger until a reload.
  const confirmed = reducer(hydratedState(), {
    type: 'SESSION_LIST',
    sessions: [summary('kept', 3), summary('external', 4)],
  });
  const next = reducer(confirmed, { type: 'SESSION_LIST', sessions: [summary('kept', 5)] });
  assert.deepEqual(Object.keys(next.sessions), ['kept']);
  assert.equal(next.sessions.kept?.updatedAt, 5);
  assert.deepEqual(next.listConfirmedSessionIds, ['kept']);
});

test('rows never confirmed by a list survive lists that omit them', () => {
  const state: AppState = {
    ...(initialState as unknown as AppState),
    sessions: { local: summary('local', 1) },
    sessionOrder: ['local'],
    listConfirmedSessionIds: null,
  };
  const next = reducer(state, { type: 'SESSION_LIST', sessions: [summary('server', 2)] });
  assert.deepEqual(Object.keys(next.sessions).sort(), ['local', 'server']);
});
