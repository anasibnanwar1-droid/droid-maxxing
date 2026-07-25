import test from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalInputTarget, isTerminalTabShortcut } from './keyboardShortcuts';

test('terminal tab shortcut requires Ctrl+backtick', () => {
  assert.equal(isTerminalTabShortcut({ ctrlKey: true, key: '`' }), true);
  assert.equal(isTerminalTabShortcut({ ctrlKey: false, key: '`' }), false);
  assert.equal(isTerminalTabShortcut({ ctrlKey: true, key: 'r' }), false);
});

test('terminal shortcut targets stay owned by xterm', () => {
  const terminalTarget = {
    closest(selector: string) {
      return selector === '[data-terminal-input]' ? {} : null;
    },
  };
  const appTarget = { closest: () => null };

  assert.equal(isTerminalInputTarget(terminalTarget as unknown as EventTarget), true);
  assert.equal(isTerminalInputTarget(appTarget as unknown as EventTarget), false);
  assert.equal(isTerminalInputTarget(null), false);
});
