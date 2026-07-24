import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer, type AppState } from './useStore';

function activeState(missionId: string): AppState {
  return {
    ...initialState,
    activeMissionId: missionId,
    rightPanelOpen: true,
    utilityPanels: {},
  };
}

test('utility tools are mission scoped and opening one hides Context', () => {
  let state = reducer(activeState('mission-a'), {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'browser',
  });
  assert.equal(state.rightPanelOpen, false);
  assert.equal(state.utilityPanels['mission-a'].open, true);
  assert.equal(state.utilityPanels['mission-a'].tabs[0].tool, 'browser');

  state = reducer(state, { type: 'SET_ACTIVE_MISSION', id: 'mission-b' });
  state = reducer(state, { type: 'OPEN_UTILITY_TOOL', tool: 'files' });
  assert.equal(state.utilityPanels['mission-b'].tabs[0].tool, 'files');
  assert.equal(state.utilityPanels['mission-a'].tabs[0].tool, 'browser');
});

test('opening Context collapses the active mission utility pane without closing tabs', () => {
  let state = reducer(activeState('mission-a'), {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'terminal',
    tabId: 'terminal-1',
  });
  state = reducer(state, { type: 'SET_RIGHT_PANEL', open: true });
  assert.equal(state.rightPanelOpen, true);
  assert.equal(state.utilityPanels['mission-a'].open, false);
  assert.equal(state.utilityPanels['mission-a'].tabs[0].id, 'terminal-1');
});

test('an explicit mission id keeps delayed tab closes scoped to their origin', () => {
  let state = reducer(activeState('mission-a'), {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'terminal',
    tabId: 'terminal-a',
  });
  state = reducer(state, { type: 'SET_ACTIVE_MISSION', id: 'mission-b' });
  state = reducer(state, {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'terminal',
    tabId: 'terminal-b',
  });

  state = reducer(state, {
    type: 'CLOSE_UTILITY_TAB',
    tabId: 'terminal-a',
    missionId: 'mission-a',
  });

  assert.equal(state.utilityPanels['mission-a'].tabs.length, 0);
  assert.equal(state.utilityPanels['mission-b'].tabs[0].id, 'terminal-b');
});

test('an explicit mission id keeps delayed tab updates scoped to their origin', () => {
  let state = reducer(activeState('mission-a'), {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'terminal',
    tabId: 'terminal-a',
  });
  state = reducer(state, { type: 'SET_ACTIVE_MISSION', id: 'mission-b' });
  state = reducer(state, {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'terminal',
    tabId: 'terminal-b',
  });

  state = reducer(state, {
    type: 'UPDATE_UTILITY_TAB',
    tabId: 'terminal-a',
    missionId: 'mission-a',
    terminalId: 'pty-a',
    label: 'zsh',
  });

  assert.equal(state.utilityPanels['mission-a'].tabs[0].terminalId, 'pty-a');
  assert.equal(state.utilityPanels['mission-a'].tabs[0].label, 'zsh');
  assert.equal(state.utilityPanels['mission-b'].tabs[0].terminalId, undefined);
});

test('legacy Review and Browser actions route through utility tabs', () => {
  let state = reducer(activeState('mission-a'), {
    type: 'SET_REVIEW_OPEN',
    open: true,
  });
  assert.equal(state.utilityPanels['mission-a'].tabs[0].tool, 'review');
  state = reducer(state, { type: 'SET_BROWSER_OPEN', open: true });
  assert.deepEqual(
    state.utilityPanels['mission-a'].tabs.map((tab) => tab.tool),
    ['review', 'browser'],
  );
  state = reducer(state, { type: 'SET_BROWSER_OPEN', open: false });
  assert.deepEqual(
    state.utilityPanels['mission-a'].tabs.map((tab) => tab.tool),
    ['review'],
  );
});
