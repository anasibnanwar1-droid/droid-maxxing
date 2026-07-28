import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptEvent, reducer, initialState } from './useStore';
import type { AppState } from './useStore';

test('CHILD_HISTORY_LOADING sets and clears the per-child loading flag', () => {
  let state = initialState as AppState;
  state = reducer(state, { type: 'CHILD_HISTORY_LOADING', providerSessionId: 'w1', loading: true });
  assert.equal(state.childHistoryLoading.w1, true);

  state = reducer(state, {
    type: 'CHILD_HISTORY_LOADING',
    providerSessionId: 'w1',
    loading: false,
  });
  assert.equal(state.childHistoryLoading.w1, false);
});

test('CHILD_HISTORY_LOADING is a no-op when the flag is unchanged', () => {
  let state = initialState as AppState;
  state = reducer(state, { type: 'CHILD_HISTORY_LOADING', providerSessionId: 'w1', loading: true });
  const same = reducer(state, {
    type: 'CHILD_HISTORY_LOADING',
    providerSessionId: 'w1',
    loading: true,
  });
  assert.equal(same, state);
});

test("CHILD_UPDATED status 'opened' clears a pending loading flag", () => {
  let state = initialState as AppState;
  state = reducer(state, { type: 'CHILD_HISTORY_LOADING', providerSessionId: 'w1', loading: true });
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'm1',
    childSessionId: 'w1',
    role: 'worker',
    status: 'opened',
  });
  assert.equal(state.childHistoryLoading.w1, false);
});

test("CHILD_UPDATED non-'opened' status leaves the loading flag untouched", () => {
  let state = initialState as AppState;
  state = reducer(state, { type: 'CHILD_HISTORY_LOADING', providerSessionId: 'w1', loading: true });
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'm1',
    childSessionId: 'w1',
    role: 'worker',
    status: 'running',
  });
  assert.equal(state.childHistoryLoading.w1, true);
});

test('exact child settings stay disabled until the canonical success acknowledgement', () => {
  let state = reducer(initialState, {
    type: 'CHILD_SETTINGS_READINESS',
    parentAppSessionId: 'm1',
    childSessionId: 'w1',
    status: 'opening',
  });
  assert.equal(state.childSettingsReadiness.m1?.w1, 'opening');

  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'm1',
    childSessionId: 'w1',
    role: 'worker',
    status: 'opened',
  });
  assert.equal(state.childSettingsReadiness.m1?.w1, 'failed');

  state = reducer(state, {
    type: 'CHILD_SETTINGS_READINESS',
    parentAppSessionId: 'm1',
    childSessionId: 'w1',
    status: 'opening',
  });
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'm1',
    childSessionId: 'w1',
    role: 'worker',
    status: 'opened',
    settingsReady: true,
  });
  assert.equal(state.childSettingsReadiness.m1?.w1, 'ready');
});

test('child readiness is isolated by parent and logical child identity', () => {
  let state = reducer(initialState, {
    type: 'CHILD_SETTINGS_READINESS',
    parentAppSessionId: 'm1',
    childSessionId: 'same-child',
    status: 'opening',
  });
  state = reducer(state, {
    type: 'CHILD_SETTINGS_READINESS',
    parentAppSessionId: 'm2',
    childSessionId: 'same-child',
    status: 'opening',
  });
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'm1',
    childSessionId: 'same-child',
    role: 'validator',
    status: 'opened',
    settingsReady: true,
  });

  assert.equal(state.childSettingsReadiness.m1?.['same-child'], 'ready');
  assert.equal(state.childSettingsReadiness.m2?.['same-child'], 'opening');
});

test('a completed child can no longer retain settings readiness', () => {
  let state = reducer(initialState, {
    type: 'CHILD_SETTINGS_READINESS',
    parentAppSessionId: 'm1',
    childSessionId: 'w1',
    status: 'ready',
  });
  state = reducer(state, {
    type: 'CHILD_UPDATED',
    parentAppSessionId: 'm1',
    childSessionId: 'w1',
    role: 'worker',
    status: 'completed',
  });

  assert.equal(state.childSettingsReadiness.m1?.w1, 'failed');
});

test('canonical child events adapt without relabeling childSessionId as providerSessionId', () => {
  assert.deepEqual(
    adaptEvent({
      type: 'child.updated',
      parentAppSessionId: 'm1',
      childSessionId: 'logical-child',
      role: 'worker',
      status: 'opened',
      settingsReady: true,
    }),
    {
      type: 'CHILD_UPDATED',
      parentAppSessionId: 'm1',
      childSessionId: 'logical-child',
      role: 'worker',
      status: 'opened',
      settingsReady: true,
    },
  );
});

test('canonical child settings events update the exact child model', () => {
  const action = adaptEvent({
    type: 'session.child',
    parentAppSessionId: 'm1',
    event: 'updated',
    childSessionId: 'logical-child',
    modelId: 'model-new',
    reasoningEffort: 'high',
  });
  assert.ok(action);
  const state = reducer(initialState, action);

  assert.equal(state.childSessions.m1?.length, 1);
  assert.equal(state.childSessions.m1?.[0]?.providerSessionId, 'logical-child');
  assert.equal(state.childSessions.m1?.[0]?.modelId, 'model-new');
  assert.equal(state.childSessions.m1?.[0]?.reasoningEffort, 'high');
});
