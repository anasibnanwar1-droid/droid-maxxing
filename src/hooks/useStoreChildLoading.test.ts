import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
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
    appSessionId: 'm1',
    providerSessionId: 'w1',
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
    appSessionId: 'm1',
    providerSessionId: 'w1',
    role: 'worker',
    status: 'running',
  });
  assert.equal(state.childHistoryLoading.w1, true);
});
