import assert from 'node:assert/strict';
import test from 'node:test';

import { adaptEvent, initialState, reducer, type AppState } from './useStore';
import type { ChildSessionSummary, SessionSummary } from '../types/bridge';

const child = (parentAppSessionId: string, childSessionId: string): ChildSessionSummary => ({
  parentAppSessionId,
  childSessionId,
  role: 'worker',
  status: 'paused',
  modelId: 'model-default',
  transcriptAvailable: true,
});

const session = (appSessionId: string): SessionSummary => ({
  appSessionId,
  providerSessionId: `provider-${appSessionId}`,
  sessionPurpose: 'chat',
  interactionMode: 'auto',
  role: 'primary',
  title: appSessionId,
  goal: appSessionId,
  cwd: '/workspace',
  autonomy: 'low',
  phase: 'paused',
  features: [],
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  createdAt: 1,
  updatedAt: 1,
});

function select(
  state: AppState,
  parentAppSessionId: string,
  childSessionId: string,
  requestId: string,
): AppState {
  const withParent = {
    ...state,
    activeAppSessionId: parentAppSessionId,
    childSessions: {
      ...state.childSessions,
      [parentAppSessionId]: {
        ...(state.childSessions[parentAppSessionId] ?? {}),
        [childSessionId]: child(parentAppSessionId, childSessionId),
      },
    },
  };
  return reducer(withParent, {
    type: 'SELECT_CHILD',
    selection: { parentAppSessionId, childSessionId },
    requestId,
  });
}

test('ready and history acknowledgements preserve their discriminated access state', () => {
  let ready = select(initialState, 'parent-a', 'child-a', 'request-ready');
  ready = reducer(ready, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-ready',
    access: 'ready',
    runtimeGeneration: 3,
  });
  assert.deepEqual(ready.childAccess['parent-a']?.['child-a'], {
    state: 'ready',
    requestId: 'request-ready',
    runtimeGeneration: 3,
  });

  let history = select(initialState, 'parent-a', 'child-a', 'request-history');
  history = reducer(history, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-history',
    access: 'history',
  });
  assert.deepEqual(history.childAccess['parent-a']?.['child-a'], {
    state: 'history',
    requestId: 'request-history',
  });
});

test('a stale open result cannot resurrect readiness after selection changes', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(
    {
      ...state,
      childSessions: {
        'parent-a': {
          'child-a': child('parent-a', 'child-a'),
          'child-b': child('parent-a', 'child-b'),
        },
      },
    },
    {
      type: 'SELECT_CHILD',
      selection: { parentAppSessionId: 'parent-a', childSessionId: 'child-b' },
      requestId: 'request-b',
    },
  );
  const afterStale = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 1,
  });

  assert.equal(afterStale, state);
  assert.deepEqual(afterStale.selectedChild, {
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-b',
  });
  assert.deepEqual(afterStale.childAccess['parent-a']?.['child-b'], {
    state: 'opening',
    requestId: 'request-b',
  });
});

test('same child IDs under different parents cannot cross-settle', () => {
  let state = select(initialState, 'parent-a', 'shared-child', 'request-a');
  const afterWrongParent = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-b',
    childSessionId: 'shared-child',
    requestId: 'request-a',
    access: 'history',
  });
  assert.equal(afterWrongParent, state);
});

test('live runtime summaries advance generation and stale generations cannot roll it back', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 3,
  });
  state = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: true,
    runtimeGeneration: 4,
  });
  assert.equal(state.childAccess['parent-a']?.['child-a']?.state, 'ready');
  assert.equal(
    state.childAccess['parent-a']?.['child-a']?.state === 'ready'
      ? state.childAccess['parent-a']?.['child-a'].runtimeGeneration
      : undefined,
    4,
  );

  const stale = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: true,
    runtimeGeneration: 2,
  });
  assert.deepEqual(stale.childAccess, state.childAccess);
});

test('an unavailable runtime closes only the matching newer live generation', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 1,
  });
  state = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: false,
    runtimeGeneration: 2,
  });
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('a stale unavailable runtime cannot close a newer reopened runtime', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 4,
  });
  const stale = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: false,
    runtimeGeneration: 3,
  });
  assert.deepEqual(stale.childAccess, state.childAccess);
});

test('a late ready acknowledgement cannot resurrect a runtime closed while opening', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: true,
    runtimeGeneration: 2,
  });
  state = reducer(state, {
    type: 'SESSION_CHILD',
    child: child('parent-a', 'child-a'),
    runtimeAvailable: false,
    runtimeGeneration: 3,
  });
  const afterLateReady = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 2,
  });

  assert.deepEqual(afterLateReady.childRuntime['parent-a']?.['child-a'], {
    available: false,
    runtimeGeneration: 3,
  });
  assert.deepEqual(afterLateReady.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('leaving an opening child invalidates its request before reselection', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, { type: 'SELECT_CHILD', selection: null });
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });

  state = reducer(state, {
    type: 'SELECT_CHILD',
    selection: { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
  });
  assert.equal(state.childAccess['parent-a'], undefined);

  state = reducer(state, {
    type: 'SELECT_CHILD',
    selection: { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
    requestId: 'request-b',
  });
  const afterLateReady = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 2,
  });

  assert.deepEqual(afterLateReady.childAccess['parent-a']?.['child-a'], {
    state: 'opening',
    requestId: 'request-b',
  });
});

test('switching parents invalidates an opening child request', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'parent-b' });

  assert.equal(state.selectedChild, null);
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('selecting the already-active parent invalidates an opening child request', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'parent-a' });

  assert.equal(state.selectedChild, null);
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('disconnect clears child selection, access, and runtime watermarks', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 2,
  });
  state = reducer(state, { type: 'SET_CONNECTION', status: 'error', message: 'closed' });

  assert.equal(state.selectedChild, null);
  assert.deepEqual(state.childAccess, {});
  assert.deepEqual(state.childRuntime, {});
});

test('starting a draft invalidates the selected child open request', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, { type: 'START_CHAT', cwd: '/workspace' });

  assert.equal(state.selectedChild, null);
  assert.equal(state.activeAppSessionId, null);
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('creating a new parent invalidates the selected child open request', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'SESSION_CREATED',
    clientRef: 'new-parent',
    session: session('parent-b'),
  });

  assert.equal(state.selectedChild, null);
  assert.equal(state.activeAppSessionId, 'parent-b');
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'closed',
    requestId: null,
  });
});

test('resuming a historical parent clears its terminal child access state', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'history',
  });
  state = reducer(state, {
    type: 'SESSION_CREATED',
    clientRef: 'resume-parent',
    session: session('parent-a'),
  });

  assert.equal(state.selectedChild, null);
  assert.equal(state.childAccess['parent-a'], undefined);
  assert.equal(state.childRuntime['parent-a'], undefined);
});

test('a stale runtime generation cannot roll back the child summary', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 4,
  });
  const stale = reducer(state, {
    type: 'SESSION_CHILD',
    child: {
      ...child('parent-a', 'child-a'),
      status: 'completed',
      modelId: 'stale-model',
    },
    runtimeAvailable: false,
    runtimeGeneration: 3,
  });

  assert.equal(stale, state);
  assert.equal(stale.childSessions['parent-a']?.['child-a']?.modelId, 'model-default');

  const sameRuntimeUpdate = reducer(state, {
    type: 'SESSION_CHILD',
    child: {
      ...child('parent-a', 'child-a'),
      modelId: 'accepted-model',
    },
    runtimeAvailable: true,
    runtimeGeneration: 4,
  });
  assert.equal(sameRuntimeUpdate.childSessions['parent-a']?.['child-a']?.modelId, 'accepted-model');
});

test('failed child access retries only after explicit reselection', () => {
  let state = select(initialState, 'parent-a', 'child-a', 'request-a');
  state = reducer(state, {
    type: 'CHILD_ERROR',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    operation: 'open',
    requestId: 'request-a',
    code: 'child.open_failed',
    message: 'failed',
  });
  assert.deepEqual(state.childAccess['parent-a']?.['child-a'], {
    state: 'failed',
    requestId: 'request-a',
  });

  state = reducer(state, {
    type: 'SELECT_CHILD',
    selection: { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
  });
  assert.equal(state.childAccess['parent-a'], undefined);

  state = reducer(state, {
    type: 'SELECT_CHILD',
    selection: { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
    requestId: 'request-b',
  });
  const afterLateReady = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    requestId: 'request-a',
    access: 'ready',
    runtimeGeneration: 2,
  });
  assert.deepEqual(afterLateReady.childAccess['parent-a']?.['child-a'], {
    state: 'opening',
    requestId: 'request-b',
  });
});

test('canonical child events adapt without provider identity aliases', () => {
  assert.deepEqual(
    adaptEvent({
      type: 'child.updated',
      parentAppSessionId: 'parent-a',
      childSessionId: 'child-a',
      requestId: 'request-a',
      access: 'ready',
      runtimeGeneration: 4,
    }),
    {
      type: 'CHILD_UPDATED',
      parentAppSessionId: 'parent-a',
      childSessionId: 'child-a',
      requestId: 'request-a',
      access: 'ready',
      runtimeGeneration: 4,
    },
  );
});

test('canonical child summaries update only the exact parent-owned child', () => {
  const action = adaptEvent({
    type: 'session.child',
    event: 'upserted',
    child: {
      ...child('parent-a', 'child-a'),
      modelId: 'model-new',
      reasoningEffort: 'high',
    },
    runtimeAvailable: false,
    runtimeGeneration: 1,
  });
  assert.ok(action);
  const state = reducer(initialState, action);

  assert.equal(state.childSessions['parent-a']?.['child-a']?.modelId, 'model-new');
  assert.equal(state.childSessions['parent-a']?.['child-a']?.reasoningEffort, 'high');
  assert.equal('providerSessionId' in state.childSessions['parent-a']!['child-a']!, false);
});
