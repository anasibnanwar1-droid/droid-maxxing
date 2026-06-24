import test from 'node:test';
import assert from 'node:assert';
import { diffModeToReviewScope } from './reviewScopes';

test('diffModeToReviewScope maps a summary mode to the matching review scope', () => {
  // branch/worktree share their diff range with the same-named scope exactly.
  assert.equal(diffModeToReviewScope('branch'), 'branch');
  assert.equal(diffModeToReviewScope('worktree'), 'worktree');
  // 'uncommitted' has no exact scope, so the closest working-tree scope is used.
  assert.equal(diffModeToReviewScope('uncommitted'), 'unstaged');
});
