import assert from 'node:assert/strict';
import test from 'node:test';
import { environmentLabels } from './repoEnvironment';

test('environmentLabels shows repo label, branch, and change count', () => {
  const labels = environmentLabels('/Users/anas/Documents/droid-control', {
    repoRoot: '/Users/anas/Documents/droid-control',
    branch: 'feature/context',
    changed: 3,
    staged: 1,
    unstaged: 1,
    untracked: 1,
  });

  assert.equal(labels.location, 'droid-control');
  assert.equal(labels.branch, 'feature/context');
  assert.equal(labels.changes, '3 changes');
});

test('environmentLabels handles a clean detached or branchless repo', () => {
  const labels = environmentLabels('/repo/app-worktree', {
    repoRoot: '/repo/app-worktree',
    branch: null,
    changed: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
  });

  assert.equal(labels.location, 'app-worktree');
  assert.equal(labels.branch, 'No branch');
  assert.equal(labels.changes, 'Clean');
});

test('environmentLabels falls back to folder labels outside a repo', () => {
  const labels = environmentLabels('/Users/anas/Documents/plain-folder', null);

  assert.equal(labels.location, 'plain-folder');
  assert.equal(labels.branch, 'No branch');
  assert.equal(labels.changes, 'No repo');
});
