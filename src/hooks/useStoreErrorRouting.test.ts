import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptEvent, initialState, reducer } from './useStore';
import type { SessionSummary } from '../types/bridge';

const session: SessionSummary = {
  appSessionId: 'app-1',
  providerSessionId: 'provider-1',
  sessionPurpose: 'chat',
  interactionMode: 'auto',
  role: 'primary',
  title: 'Chat',
  goal: '',
  cwd: '',
  workspaceKind: 'none',
  autonomy: 'low',
  phase: 'running',
  features: [],
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  createdAt: 1,
  updatedAt: 1,
};

test('a primary error with a provider identity fails the session and settles child loading', () => {
  const action = adaptEvent({
    type: 'error',
    appSessionId: 'app-1',
    providerSessionId: 'provider-1',
    message: 'resume failed',
  });
  assert.ok(action);

  const state = {
    ...initialState,
    sessions: { 'app-1': session },
    childHistoryLoading: { 'provider-1': true },
  };
  const next = reducer(state, action);

  assert.equal(next.sessions['app-1']?.phase, 'failed');
  assert.equal(next.childHistoryLoading['provider-1'], false);
});

test('a direct child error settles loading without failing the parent session', () => {
  const action = adaptEvent({
    type: 'error',
    code: 'child.open_failed',
    appSessionId: 'app-1',
    providerSessionId: 'child-1',
    message: 'child failed to open',
  });
  assert.ok(action);

  const state = {
    ...initialState,
    sessions: { 'app-1': session },
    childHistoryLoading: { 'child-1': true },
  };
  const next = reducer(state, action);

  assert.equal(next.sessions['app-1']?.phase, 'running');
  assert.equal(next.childHistoryLoading['child-1'], false);
});
