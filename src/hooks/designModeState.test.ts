import assert from 'node:assert/strict';
import test from 'node:test';
import { clearDesignMode, isDesignModeOpen, setDesignMode, toggleDesignMode } from './designModeState';

test('design mode is scoped by session id', () => {
  let state = toggleDesignMode({}, 'session-a');

  assert.equal(isDesignModeOpen(state, 'session-a'), true);
  assert.equal(isDesignModeOpen(state, 'session-b'), false);

  state = toggleDesignMode(state, 'session-b');

  assert.equal(isDesignModeOpen(state, 'session-a'), true);
  assert.equal(isDesignModeOpen(state, 'session-b'), true);
});

test('clears one mission without changing other design mode state', () => {
  const state = clearDesignMode(setDesignMode({ 'session-a': true }, 'session-b', true), 'session-a');

  assert.equal(isDesignModeOpen(state, 'session-a'), false);
  assert.equal(isDesignModeOpen(state, 'session-b'), true);
});
