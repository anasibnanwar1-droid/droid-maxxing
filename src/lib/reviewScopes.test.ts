import test from 'node:test';
import assert from 'node:assert';
import { diffModeToReviewScope } from './reviewScopes';

test('diffModeToReviewScope maps a summary mode to the matching review scope', () => {
  // Each summary mode has an exactly-corresponding review scope.
  assert.equal(diffModeToReviewScope('branch'), 'branch');
  assert.equal(diffModeToReviewScope('worktree'), 'worktree');
  // 'uncommitted' must include staged files, so it maps to its own scope.
  assert.equal(diffModeToReviewScope('uncommitted'), 'uncommitted');
});
