import assert from 'node:assert/strict';
import test from 'node:test';
import { isWorktreeDiscoveryStable } from './useSessionWorkingDirectory';
import type { GitWorktree } from '../types/vcs';

const worktree = (path: string): GitWorktree => ({
  path,
  head: 'abc',
  branch: 'main',
  bare: false,
  detached: false,
  locked: false,
  isMain: true,
  isCurrent: true,
});

// isWorktreeDiscoveryStable decides whether the hook's git-worktree probe can
// stop re-running. Empty results use a cooldown because getGitWorktrees cannot
// distinguish a transient Git/IPC failure from a genuine non-repository.
test('a non-empty matching snapshot is a settled discovery', () => {
  const snapshot = {
    sessionKey: 's1',
    cwd: '/repo',
    revision: 'r1',
    worktrees: [worktree('/repo')],
    discoveredAt: 1_000,
  };
  assert.equal(isWorktreeDiscoveryStable(snapshot, 's1', '/repo', 'r1', 1_000), true);
});

test('an empty worktree result is stable during its retry cooldown', () => {
  const snapshot = {
    sessionKey: 's1',
    cwd: '/repo',
    revision: 'r1',
    worktrees: [],
    discoveredAt: 1_000,
  };
  assert.equal(isWorktreeDiscoveryStable(snapshot, 's1', '/repo', 'r2', 5_999), true);
});

test('an empty worktree result becomes retryable after its cooldown', () => {
  const snapshot = {
    sessionKey: 's1',
    cwd: '/repo',
    revision: 'r1',
    worktrees: [],
    discoveredAt: 1_000,
  };
  assert.equal(isWorktreeDiscoveryStable(snapshot, 's1', '/repo', 'r2', 6_000), false);
});

test('no snapshot yet is not settled', () => {
  assert.equal(isWorktreeDiscoveryStable(null, 's1', '/repo', 'r1'), false);
});

test('a snapshot for a different session/cwd/revision is not settled', () => {
  const snapshot = {
    sessionKey: 's1',
    cwd: '/repo',
    revision: 'r1',
    worktrees: [worktree('/repo')],
    discoveredAt: 1_000,
  };
  assert.equal(isWorktreeDiscoveryStable(snapshot, 's2', '/repo', 'r1', 1_000), false);
  assert.equal(isWorktreeDiscoveryStable(snapshot, 's1', '/other', 'r1', 1_000), false);
  assert.equal(isWorktreeDiscoveryStable(snapshot, 's1', '/repo', 'r2', 1_000), false);
});
