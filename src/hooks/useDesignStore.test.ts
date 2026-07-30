import assert from 'node:assert/strict';
import test from 'node:test';
import { designReducer, initialDesignState } from './useDesignStore';

test('a correlated create error unlocks only the matching Design Studio project', () => {
  const state = {
    ...initialDesignState,
    expected: {
      'create-failed': '/repo/design-a',
      'create-unrelated': '/repo/design-b',
    },
  };

  const next = designReducer(state, {
    type: 'BRIDGE_EVENT',
    event: {
      type: 'error',
      code: 'session.create_failed',
      clientRef: 'create-failed',
      message: 'Factory could not start the design session',
    },
  });

  assert.deepEqual(next.expected, { 'create-unrelated': '/repo/design-b' });
  assert.deepEqual(next.lastError, {
    cwd: '/repo/design-a',
    message: 'Factory could not start the design session',
  });
});

test('an unrelated bridge error does not mutate Design Studio state', () => {
  const state = {
    ...initialDesignState,
    expected: { 'create-pending': '/repo/design' },
  };
  const next = designReducer(state, {
    type: 'BRIDGE_EVENT',
    event: {
      type: 'error',
      appSessionId: 'another-session',
      message: 'Another session failed',
    },
  });

  assert.equal(next, state);
});
