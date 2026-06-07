import assert from 'node:assert/strict';
import test from 'node:test';
import { clearDesignMode, isDesignModeOpen, setDesignMode, toggleDesignMode } from './designModeState';

test('design mode is scoped by mission id', () => {
  let state = toggleDesignMode({}, 'chat-a');

  assert.equal(isDesignModeOpen(state, 'chat-a'), true);
  assert.equal(isDesignModeOpen(state, 'chat-b'), false);

  state = toggleDesignMode(state, 'chat-b');

  assert.equal(isDesignModeOpen(state, 'chat-a'), true);
  assert.equal(isDesignModeOpen(state, 'chat-b'), true);
});

test('clears one mission without changing other design mode state', () => {
  const state = clearDesignMode(setDesignMode({ 'chat-a': true }, 'chat-b', true), 'chat-a');

  assert.equal(isDesignModeOpen(state, 'chat-a'), false);
  assert.equal(isDesignModeOpen(state, 'chat-b'), true);
});
