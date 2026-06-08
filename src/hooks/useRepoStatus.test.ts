import assert from 'node:assert/strict';
import test from 'node:test';
import { isCurrentRepoStatusRequest } from './useRepoStatus';

test('isCurrentRepoStatusRequest ignores older polling responses', () => {
  assert.equal(isCurrentRepoStatusRequest(1, 2), false);
  assert.equal(isCurrentRepoStatusRequest(2, 2), true);
});
