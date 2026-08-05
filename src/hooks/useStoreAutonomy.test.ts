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
  autonomy: 'medium',
  phase: 'running',
  features: [],
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  createdAt: 1,
  updatedAt: 1,
};

test('the persisted default is the only seed for new drafts', () => {
  withLocalStorageMap({}, () => {
    const state = reducer(initialState, { type: 'SET_DEFAULT_AUTONOMY', autonomy: 'low' });
    assert.equal(state.defaultAutonomy, 'low');
    assert.equal(globalThis.localStorage.getItem('droid-default-autonomy'), 'low');
    // Changing the default never rewrites an explicit draft override.
    const drafted = reducer(state, { type: 'SET_DRAFT_AUTONOMY', autonomy: 'high' });
    const changed = reducer(drafted, { type: 'SET_DEFAULT_AUTONOMY', autonomy: 'off' });
    assert.equal(changed.draftAutonomy, 'high');
    assert.equal(changed.defaultAutonomy, 'off');
  });
});

test('the draft override resets at every draft lifecycle point', () => {
  const drafted = reducer(initialState, { type: 'SET_DRAFT_AUTONOMY', autonomy: 'high' });
  assert.equal(drafted.draftAutonomy, 'high');

  const pending = reducer(drafted, {
    type: 'SET_PENDING_COMPOSE',
    clientRef: 'c-1',
    text: 'start chat',
    skills: [],
    files: [],
  });
  const created = reducer(pending, {
    type: 'SESSION_CREATED',
    clientRef: 'c-1',
    session,
  });
  assert.equal(created.draftAutonomy, null);

  const draftedAgain = reducer(drafted, { type: 'SET_DRAFT_AUTONOMY', autonomy: 'low' });
  const switched = reducer(draftedAgain, { type: 'SET_ACTIVE_SESSION', id: 'app-1' });
  assert.equal(switched.draftAutonomy, null);

  const draftedOnceMore = reducer(drafted, { type: 'SET_DRAFT_AUTONOMY', autonomy: 'off' });
  const newChat = reducer(draftedOnceMore, { type: 'START_CHAT', cwd: '/tmp' });
  assert.equal(newChat.draftAutonomy, null);
});

test('a pending autonomy change settles only on a confirmed level change', () => {
  const requested = reducer(
    { ...initialState, sessions: { 'app-1': session } },
    {
      type: 'AUTONOMY_UPDATE_REQUESTED',
      appSessionId: 'app-1',
      autonomy: 'high',
    },
  );
  assert.equal(requested.pendingAutonomy['app-1'], 'high');

  // An echo of the old confirmed level keeps the change pending.
  const echo = reducer(requested, { type: 'SESSION_UPDATED', session });
  assert.equal(echo.pendingAutonomy['app-1'], 'high');

  // The provider confirming the requested level settles it.
  const confirmed = reducer(requested, {
    type: 'SESSION_UPDATED',
    session: { ...session, autonomy: 'high' },
  });
  assert.equal(confirmed.pendingAutonomy['app-1'], undefined);

  // A change through another path (e.g. the CLI) also settles: the pending
  // request is no longer the latest truth.
  const externallyChanged = reducer(requested, {
    type: 'SESSION_UPDATED',
    session: { ...session, autonomy: 'off' },
  });
  assert.equal(externallyChanged.pendingAutonomy['app-1'], undefined);
});

test('closing a session drops its pending autonomy entry', () => {
  const requested = reducer(initialState, {
    type: 'AUTONOMY_UPDATE_REQUESTED',
    appSessionId: 'app-1',
    autonomy: 'high',
  });
  const closed = reducer(requested, { type: 'SESSION_CLOSED', appSessionId: 'app-1' });
  assert.equal(closed.pendingAutonomy['app-1'], undefined);
});

test('a failed autonomy update settles pending and toasts without failing the session', () => {
  const failure = {
    type: 'error' as const,
    code: 'session.autonomy_update_failed',
    appSessionId: 'app-1',
    message: 'Could not change autonomy: provider rejected the update',
    recoverable: true as const,
  };

  assert.equal(toastMessageForEvent(failure), failure.message);
  const action = adaptEvent(failure);
  assert.deepEqual(action, { type: 'AUTONOMY_UPDATE_SETTLED', appSessionId: 'app-1' });

  const state = {
    ...initialState,
    sessions: { 'app-1': session },
    pendingAutonomy: { 'app-1': 'high' as const },
  };
  const next = reducer(state, action!);
  assert.equal(next.pendingAutonomy['app-1'], undefined);
  assert.equal(next.sessions['app-1']?.phase, 'running');
  assert.equal(next.sessions['app-1']?.autonomy, 'medium');
});

test('an autonomy failure without a session id produces no reducer action', () => {
  const action = adaptEvent({
    type: 'error',
    code: 'session.autonomy_update_failed',
    message: 'no session',
    recoverable: true,
  });
  assert.equal(action, null);
});

function withLocalStorageMap(seed: Record<string, string>, fn: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map(Object.entries(seed));
  const mock: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, next) => {
      values.set(key, next);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: mock });
  try {
    fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}
