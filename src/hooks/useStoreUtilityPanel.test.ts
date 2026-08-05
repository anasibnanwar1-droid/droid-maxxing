import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer, type AppState } from './useStore';
import type { SessionSummary } from '../types/bridge';

function sessionSummary(appSessionId: string): SessionSummary {
  return {
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
  };
}

function activeState(appSessionId: string): AppState {
  return {
    ...initialState,
    activeAppSessionId: appSessionId,
    rightPanelOpen: true,
    utilityPanels: {},
  };
}

function browser(appSessionId: string) {
  return {
    browserSessionId: `browser-${appSessionId}`,
    appSessionId,
    url: 'https://example.com/',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
    viewportMode: 'fit' as const,
    scroll: { x: 0, y: 0 },
    refs: [],
  };
}

test('utility tools are session scoped and opening one hides Context', () => {
  let state = reducer(activeState('session-a'), {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'browser',
  });
  assert.equal(state.rightPanelOpen, false);
  assert.equal(state.utilityPanels['session-a'].open, true);
  assert.equal(state.utilityPanels['session-a'].tabs[0].tool, 'browser');

  state = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'session-b' });
  state = reducer(state, { type: 'OPEN_UTILITY_TOOL', tool: 'files' });
  assert.equal(state.utilityPanels['session-b'].tabs[0].tool, 'files');
  assert.equal(state.utilityPanels['session-a'].tabs[0].tool, 'browser');
});

test('opening Context collapses the active session utility pane without closing tabs', () => {
  let state = reducer(activeState('session-a'), {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'terminal',
    tabId: 'terminal-1',
  });
  state = reducer(state, { type: 'SET_RIGHT_PANEL', open: true });
  assert.equal(state.rightPanelOpen, true);
  assert.equal(state.utilityPanels['session-a'].open, false);
  assert.equal(state.utilityPanels['session-a'].tabs[0].id, 'terminal-1');
});

test('an explicit session id keeps delayed tab closes scoped to their origin', () => {
  let state = reducer(activeState('session-a'), {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'terminal',
    tabId: 'terminal-a',
  });
  state = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'session-b' });
  state = reducer(state, {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'terminal',
    tabId: 'terminal-b',
  });

  state = reducer(state, {
    type: 'CLOSE_UTILITY_TAB',
    tabId: 'terminal-a',
    appSessionId: 'session-a',
  });

  assert.equal(state.utilityPanels['session-a'].tabs.length, 0);
  assert.equal(state.utilityPanels['session-b'].tabs[0].id, 'terminal-b');
});

test('an explicit session id keeps delayed tab updates scoped to their origin', () => {
  let state = reducer(activeState('session-a'), {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'terminal',
    tabId: 'terminal-a',
  });
  state = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'session-b' });
  state = reducer(state, {
    type: 'OPEN_UTILITY_TOOL',
    tool: 'terminal',
    tabId: 'terminal-b',
  });

  state = reducer(state, {
    type: 'UPDATE_UTILITY_TAB',
    tabId: 'terminal-a',
    appSessionId: 'session-a',
    terminalId: 'pty-a',
    cwd: '/workspace-a',
    label: 'zsh',
  });

  assert.equal(state.utilityPanels['session-a'].tabs[0].terminalId, 'pty-a');
  assert.equal(state.utilityPanels['session-a'].tabs[0].cwd, '/workspace-a');
  assert.equal(state.utilityPanels['session-a'].tabs[0].label, 'zsh');
  assert.equal(state.utilityPanels['session-b'].tabs[0].terminalId, undefined);
});

test('legacy Review and Browser actions route through utility tabs', () => {
  let state = reducer(activeState('session-a'), {
    type: 'SET_REVIEW_OPEN',
    open: true,
  });
  assert.equal(state.utilityPanels['session-a'].tabs[0].tool, 'review');
  state = reducer(state, { type: 'SET_BROWSER_OPEN', open: true });
  assert.deepEqual(
    state.utilityPanels['session-a'].tabs.map((tab) => tab.tool),
    ['review', 'browser'],
  );
  state = reducer(state, { type: 'SET_BROWSER_OPEN', open: false });
  assert.deepEqual(
    state.utilityPanels['session-a'].tabs.map((tab) => tab.tool),
    ['review'],
  );
});

test('background browser updates create the session browser tab', () => {
  const state = reducer(activeState('session-a'), {
    type: 'BROWSER_UPDATED',
    browser: browser('session-b'),
  });

  assert.equal(state.utilityPanels['session-b'].open, true);
  assert.equal(state.utilityPanels['session-b'].activeTabId, 'browser:session-b');
  assert.equal(state.utilityPanels['session-b'].tabs[0].tool, 'browser');
  assert.equal(state.activeAppSessionId, 'session-a');
});

test('browser updates preserve an explicitly hidden browser pane', () => {
  let state = reducer(activeState('session-a'), {
    type: 'SET_BROWSER_OPEN',
    open: true,
  });
  state = reducer(state, { type: 'SET_BROWSER_OPEN', open: false });
  state = reducer(state, {
    type: 'BROWSER_UPDATED',
    browser: browser('session-a'),
  });

  assert.equal(state.browserOpenKeys['session-a'], false);
  assert.equal(
    state.utilityPanels['session-a'].tabs.some((tab) => tab.tool === 'browser'),
    false,
  );
});

test('a session switch drops a pending review-focus request', () => {
  let state = reducer(activeState('session-a'), {
    type: 'OPEN_REVIEW_AT',
    scope: 'last_turn',
    path: 'src/app.ts',
  });
  assert.equal(state.reviewFocusPath, 'src/app.ts');

  // The request belongs to session-a; it must not fire in session-b's panel.
  state = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'session-b' });
  assert.equal(state.reviewFocusPath, null);

  // Re-selecting the already-active session keeps an in-flight request alive.
  state = reducer(state, { type: 'OPEN_REVIEW_AT', scope: 'last_turn', path: 'src/b.ts' });
  state = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'session-b' });
  assert.equal(state.reviewFocusPath, 'src/b.ts');
});

test('starting a new chat drops a pending review-focus request', () => {
  let state = reducer(activeState('session-a'), {
    type: 'OPEN_REVIEW_AT',
    scope: 'last_turn',
    path: 'src/app.ts',
  });
  state = reducer(state, { type: 'START_CHAT', cwd: '/repo' });
  assert.equal(state.activeAppSessionId, null);
  assert.equal(state.reviewFocusPath, null);
});

test('creating another session drops a pending review-focus request', () => {
  let state = reducer(activeState('session-a'), {
    type: 'OPEN_REVIEW_AT',
    scope: 'last_turn',
    path: 'src/app.ts',
  });
  state = reducer(state, {
    type: 'SESSION_CREATED',
    clientRef: 'ref-1',
    session: sessionSummary('session-b'),
  });
  assert.equal(state.activeAppSessionId, 'session-b');
  assert.equal(state.reviewFocusPath, null);
});

test('each review-focus request bumps the request generation', () => {
  let state = reducer(activeState('session-a'), {
    type: 'OPEN_REVIEW_AT',
    scope: 'last_turn',
    path: 'src/app.ts',
  });
  const first = state.reviewFocusRequestId;
  // A repeated click for the same file is a new request: the Review pane's
  // fallback dedupe keys on this id, so it must change to re-arm the chain.
  state = reducer(state, { type: 'OPEN_REVIEW_AT', scope: 'last_turn', path: 'src/app.ts' });
  assert.equal(state.reviewFocusRequestId, first + 1);
});
