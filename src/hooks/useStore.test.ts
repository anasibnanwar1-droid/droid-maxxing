import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reducer, type AppState } from './useStore';
import type { SessionSummary } from '../types/bridge';

function session(appSessionId: string, updatedAt: number): SessionSummary {
  return {
    appSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: '',
    cwd: '',
    autonomy: 'off',
    phase: 'completed',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1_000,
    updatedAt,
  };
}

test('mark all sessions read advances every current session without changing session state', () => {
  const state: AppState = {
    ...initialState,
    sessions: {
      'sess-a': session('sess-a', 3_000),
      'sess-b': session('sess-b', 7_000),
    },
    sessionOrder: ['sess-a', 'sess-b'],
    sessionLastSeen: { 'sess-a': 1_000, 'closed-session': 2_000 },
  };

  const next = reducer(state, { type: 'MARK_ALL_SESSIONS_READ', seenAt: 5_000 });

  assert.equal(next.sessionLastSeen['sess-a'], 5_000);
  assert.equal(next.sessionLastSeen['sess-b'], 7_000);
  assert.equal(next.sessionLastSeen['closed-session'], 2_000);
  assert.equal(next.sessions, state.sessions);
  assert.equal(next.sessionOrder, state.sessionOrder);
});
