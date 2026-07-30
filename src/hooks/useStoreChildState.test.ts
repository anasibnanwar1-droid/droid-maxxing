import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChildSessionSummary, SessionSummary } from '../types/bridge';
import { initialState, reducer } from './useStore';

function session(appSessionId: string): SessionSummary {
  return {
    appSessionId,
    providerSessionId: `provider-${appSessionId}`,
    sessionPurpose: 'mission-control',
    interactionMode: 'agi',
    role: 'primary',
    title: appSessionId,
    goal: 'test',
    cwd: '/workspace',
    workspaceKind: 'folder',
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

function child(parentAppSessionId: string, childSessionId: string): ChildSessionSummary {
  return {
    parentAppSessionId,
    childSessionId,
    role: 'worker',
    status: 'paused',
    modelId: 'model-default',
    transcriptAvailable: true,
  };
}

test('same-event sibling progress remains distinct by exact child identity', () => {
  const state = reducer(initialState, {
    type: 'SESSION_PROGRESS',
    appSessionId: 'parent',
    entries: [
      {
        id: 'progress-a',
        timestamp: '2026-07-30T00:00:00.000Z',
        type: 'worker_started',
        title: 'Workers started',
        featureId: 'feature',
        workerChildSessionId: 'child-a',
      },
      {
        id: 'progress-b',
        timestamp: '2026-07-30T00:00:00.000Z',
        type: 'worker_started',
        title: 'Workers started',
        featureId: 'feature',
        workerChildSessionId: 'child-b',
      },
    ],
  });

  assert.deepEqual(
    state.progress.parent?.map((entry) => entry.workerChildSessionId),
    ['child-a', 'child-b'],
  );
});

test('closing a parent preserves historical parent and child discovery but clears live targeting', () => {
  const parent = session('parent');
  const historicalChild = child('parent', 'child');
  const state = reducer(
    {
      ...initialState,
      sessions: { parent },
      sessionOrder: ['parent'],
      activeAppSessionId: 'parent',
      childSessions: { parent: { child: historicalChild } },
      childAccess: {
        parent: { child: { state: 'ready', requestId: 'open', runtimeGeneration: 1 } },
      },
      childRuntime: { parent: { child: { available: true, runtimeGeneration: 1 } } },
      selectedChild: { parentAppSessionId: 'parent', childSessionId: 'child' },
      historyLoaded: true,
    },
    { type: 'SESSION_CLOSED', appSessionId: 'parent' },
  );

  assert.equal(state.sessions.parent, parent);
  assert.deepEqual(state.sessionOrder, ['parent']);
  assert.equal(state.activeAppSessionId, 'parent');
  assert.equal(state.childSessions.parent?.child, historicalChild);
  assert.equal(state.childAccess.parent, undefined);
  assert.equal(state.childRuntime.parent, undefined);
  assert.equal(state.selectedChild, null);
});
