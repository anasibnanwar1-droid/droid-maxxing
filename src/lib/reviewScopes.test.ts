import test from 'node:test';
import assert from 'node:assert';
import { diffModeToReviewScope, matchReviewFocusPath, nextReviewFocusScope } from './reviewScopes';

test('diffModeToReviewScope maps a summary mode to the matching review scope', () => {
  // Each summary mode has an exactly-corresponding review scope.
  assert.equal(diffModeToReviewScope('branch'), 'branch');
  assert.equal(diffModeToReviewScope('worktree'), 'worktree');
  // 'uncommitted' must include staged files, so it maps to its own scope.
  assert.equal(diffModeToReviewScope('uncommitted'), 'uncommitted');
});

test('nextReviewFocusScope walks last_turn through uncommitted to worktree', () => {
  assert.equal(nextReviewFocusScope('last_turn'), 'uncommitted');
  assert.equal(nextReviewFocusScope('uncommitted'), 'worktree');
  assert.equal(nextReviewFocusScope('worktree'), null);
});

test('nextReviewFocusScope stops for scopes outside the focus chain', () => {
  // A focus request always starts at 'last_turn'; any other current scope
  // means the user navigated away mid-flight, so the chain must not resume.
  assert.equal(nextReviewFocusScope('staged'), null);
  assert.equal(nextReviewFocusScope('unstaged'), null);
  assert.equal(nextReviewFocusScope('branch'), null);
  assert.equal(nextReviewFocusScope('commit'), null);
});

test('matchReviewFocusPath matches repo-relative paths exactly', () => {
  const files = [{ path: 'src/app.ts' }, { path: 'README.md' }];
  assert.equal(matchReviewFocusPath(files, 'src/app.ts'), 'src/app.ts');
  assert.equal(matchReviewFocusPath(files, 'README.md'), 'README.md');
});

test('matchReviewFocusPath matches absolute transcript paths under the repo', () => {
  const files = [{ path: 'src/app.ts' }];
  assert.equal(matchReviewFocusPath(files, '/Users/dev/repo/src/app.ts'), 'src/app.ts');
  // Windows-style separators from a transcript are normalized.
  assert.equal(matchReviewFocusPath(files, 'C:\\repo\\src\\app.ts'), 'src/app.ts');
});

test('matchReviewFocusPath matches cwd-relative paths in a repo subdirectory', () => {
  // The session cwd is apps/web, so the transcript reports src/app.ts while
  // git reports the repo-root-relative path.
  const files = [{ path: 'apps/web/src/app.ts' }];
  assert.equal(matchReviewFocusPath(files, 'src/app.ts'), 'apps/web/src/app.ts');
  assert.equal(matchReviewFocusPath(files, './src/app.ts'), 'apps/web/src/app.ts');
});

test('matchReviewFocusPath prefers an exact match over an earlier suffix match', () => {
  const files = [{ path: 'packages/a/src/app.ts' }, { path: 'src/app.ts' }];
  assert.equal(matchReviewFocusPath(files, 'src/app.ts'), 'src/app.ts');
});

test('matchReviewFocusPath resolves relative paths against the session cwd first', () => {
  const files = [{ path: 'packages/api/src/app.ts' }, { path: 'packages/web/src/app.ts' }];
  // Session cwd is packages/web: edit tools resolve 'src/app.ts' there, not
  // in the alphabetically first packages/api.
  assert.equal(
    matchReviewFocusPath(files, 'src/app.ts', '/repo/packages/web'),
    'packages/web/src/app.ts',
  );
});

test('matchReviewFocusPath prefers the cwd-resolved file over a root-level exact match', () => {
  const files = [{ path: 'packages/web/src/app.ts' }, { path: 'src/app.ts' }];
  assert.equal(
    matchReviewFocusPath(files, 'src/app.ts', '/repo/packages/web'),
    'packages/web/src/app.ts',
  );
});

test('matchReviewFocusPath picks the longest suffix for absolute paths', () => {
  // Both git paths suffix-match; the longer one pins the repo root at /repo.
  const files = [{ path: 'web/src/app.ts' }, { path: 'packages/web/src/app.ts' }];
  assert.equal(
    matchReviewFocusPath(files, '/repo/packages/web/src/app.ts'),
    'packages/web/src/app.ts',
  );
});

test('matchReviewFocusPath returns null when nothing matches', () => {
  const files = [{ path: 'src/app.ts' }];
  assert.equal(matchReviewFocusPath(files, 'src/other.ts'), null);
  assert.equal(matchReviewFocusPath(files, '/elsewhere/repo/src/app.tsx'), null);
  assert.equal(matchReviewFocusPath([], 'src/app.ts'), null);
  assert.equal(matchReviewFocusPath(files, ''), null);
});
