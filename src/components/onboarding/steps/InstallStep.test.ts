import assert from 'node:assert/strict';
import test from 'node:test';

import { selectInstallChannel } from './InstallStep';

test('selectInstallChannel replaces a selection that is no longer available', () => {
  assert.equal(selectInstallChannel(['npm'], 'brew'), 'npm');
  assert.equal(selectInstallChannel([], 'brew'), null);
});

test('selectInstallChannel retains a selection that is still available', () => {
  assert.equal(selectInstallChannel(['script', 'brew'], 'brew'), 'brew');
});
