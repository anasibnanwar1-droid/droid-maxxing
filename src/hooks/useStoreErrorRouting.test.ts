import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptEvent, initialState, reducer, toastMessageForEvent } from './useStore';
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

test('non-open child command failures are routed to user-visible toast feedback', () => {
  const failure = {
    type: 'child.error' as const,
    code: 'child.settings_update_failed',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
    requestId: null,
    operation: 'settings' as const,
    message: 'Could not update child settings: provider rejected',
  };

  assert.equal(toastMessageForEvent(failure), failure.message);
  assert.deepEqual(adaptEvent(failure), {
    type: 'CHILD_ERROR',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
    requestId: null,
    operation: 'settings',
    message: failure.message,
  });
  assert.equal(
    toastMessageForEvent({
      ...failure,
      code: 'child.settings_target_invalid',
    }),
    failure.message,
  );
  assert.equal(
    toastMessageForEvent({
      ...failure,
      code: 'child.send_failed',
      operation: 'send',
    }),
    failure.message,
  );
  assert.equal(
    toastMessageForEvent({
      ...failure,
      code: 'child.open_failed',
      operation: 'open',
    }),
    undefined,
  );
});

test('a primary error fails only the primary session', () => {
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
  };
  const next = reducer(state, action);

  assert.equal(next.sessions['app-1']?.phase, 'failed');
});

test('a matching child-open error settles access without failing the parent session', () => {
  const action = adaptEvent({
    type: 'child.error',
    code: 'child.open_failed',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
    requestId: 'request-1',
    operation: 'open',
    message: 'child failed to open',
  });
  assert.ok(action);

  const state = {
    ...initialState,
    sessions: { 'app-1': session },
    activeAppSessionId: 'app-1',
    selectedChild: { parentAppSessionId: 'app-1', childSessionId: 'child-1' },
    childAccess: { 'app-1': { 'child-1': { state: 'opening', requestId: 'request-1' } } },
  };
  const next = reducer(state, action);

  assert.equal(next.sessions['app-1']?.phase, 'running');
  assert.deepEqual(next.childAccess['app-1']?.['child-1'], {
    state: 'failed',
    requestId: 'request-1',
  });
});

test('a recoverable parent error stays out of reducer state', () => {
  const action = adaptEvent({
    type: 'error',
    appSessionId: 'app-1',
    providerSessionId: 'provider-1',
    message: 'history restore failed',
    recoverable: true,
  });
  assert.equal(action, null);
});
