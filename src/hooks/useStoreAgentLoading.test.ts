import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
import type { AppState } from './useStore';

test('AGENT_HISTORY_LOADING sets and clears the per-agent loading flag', () => {
  let state = initialState as AppState;
  state = reducer(state, { type: 'AGENT_HISTORY_LOADING', agentSessionId: 'w1', loading: true });
  assert.equal(state.agentHistoryLoading.w1, true);

  state = reducer(state, { type: 'AGENT_HISTORY_LOADING', agentSessionId: 'w1', loading: false });
  assert.equal(state.agentHistoryLoading.w1, false);
});

test('AGENT_HISTORY_LOADING is a no-op when the flag is unchanged', () => {
  let state = initialState as AppState;
  state = reducer(state, { type: 'AGENT_HISTORY_LOADING', agentSessionId: 'w1', loading: true });
  const same = reducer(state, {
    type: 'AGENT_HISTORY_LOADING',
    agentSessionId: 'w1',
    loading: true,
  });
  assert.equal(same, state);
});

test("AGENT_UPDATED status 'opened' clears a pending loading flag", () => {
  let state = initialState as AppState;
  state = reducer(state, { type: 'AGENT_HISTORY_LOADING', agentSessionId: 'w1', loading: true });
  state = reducer(state, {
    type: 'AGENT_UPDATED',
    missionId: 'm1',
    agentSessionId: 'w1',
    role: 'worker',
    status: 'opened',
  });
  assert.equal(state.agentHistoryLoading.w1, false);
});

test("AGENT_UPDATED non-'opened' status leaves the loading flag untouched", () => {
  let state = initialState as AppState;
  state = reducer(state, { type: 'AGENT_HISTORY_LOADING', agentSessionId: 'w1', loading: true });
  state = reducer(state, {
    type: 'AGENT_UPDATED',
    missionId: 'm1',
    agentSessionId: 'w1',
    role: 'worker',
    status: 'running',
  });
  assert.equal(state.agentHistoryLoading.w1, true);
});
