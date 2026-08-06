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
    snapshotSessionIds: ['stale', 'kept'],
  };
}

test('the first SESSION_LIST prunes hydrated rows the sidecar does not confirm', () => {
  const next = reducer(hydratedState(), {
    type: 'SESSION_LIST',
    sessions: [summary('kept', 3), summary('fresh', 4)],
  });
  assert.deepEqual(Object.keys(next.sessions).sort(), ['fresh', 'kept']);
  assert.deepEqual(next.sessionOrder, ['fresh', 'kept']);
  assert.equal(next.snapshotSessionIds, null);
});

test('locally created sessions survive the confirming SESSION_LIST', () => {
  const created = reducer(hydratedState(), {
    type: 'SESSION_CREATED',
    clientRef: 'ref-1',
    session: summary('optimistic', 5),
  });
  const next = reducer(created, { type: 'SESSION_LIST', sessions: [summary('kept', 3)] });
  assert.deepEqual(Object.keys(next.sessions).sort(), ['kept', 'optimistic']);
  assert.equal(next.snapshotSessionIds, null);
});

test('later SESSION_LIST merges keep unlisted sessions once the snapshot is confirmed', () => {
  const confirmed = reducer(hydratedState(), {
    type: 'SESSION_LIST',
    sessions: [summary('kept', 3)],
  });
  // No snapshot marker anymore: an empty list no longer prunes, matching the
  // merge behavior sessions created this run rely on.
  const next = reducer(confirmed, { type: 'SESSION_LIST', sessions: [] });
  assert.deepEqual(Object.keys(next.sessions), ['kept']);
  assert.equal(next.sessions.kept?.updatedAt, 3);
});

test('without a snapshot the SESSION_LIST merge behavior is unchanged', () => {
  const state: AppState = {
    ...(initialState as unknown as AppState),
    sessions: { local: summary('local', 1) },
    sessionOrder: ['local'],
    snapshotSessionIds: null,
  };
  const next = reducer(state, { type: 'SESSION_LIST', sessions: [summary('server', 2)] });
  assert.deepEqual(Object.keys(next.sessions).sort(), ['local', 'server']);
});
