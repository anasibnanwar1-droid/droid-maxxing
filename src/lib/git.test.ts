import test from 'node:test';
import assert from 'node:assert';
import {
  aheadBehindLabel,
  baseDescriptor,
  diffModeLabel,
  isWorktreeInUse,
  stripRemotePrefix,
  worktreeName,
} from './git';

test('diffModeLabel shows the effective base ref for the branch mode', () => {
  assert.equal(diffModeLabel('worktree'), 'Worktree');
  assert.equal(diffModeLabel('uncommitted'), 'Uncommitted');
  // The caller passes the full base ref, so a stored develop base or a
  // non-origin primary remote is reflected verbatim instead of forced to origin.
  assert.equal(diffModeLabel('branch', 'origin/develop'), 'Branch vs origin/develop');
  assert.equal(diffModeLabel('branch', 'upstream/main'), 'Branch vs upstream/main');
  assert.equal(diffModeLabel('branch', null), 'Branch vs origin/main');
});

test('stripRemotePrefix drops the matched remote, including slash-containing names', () => {
  assert.equal(stripRemotePrefix('origin/main', ['origin']), 'main');
  // a remote whose name itself contains a slash: strip the whole "foo/bar/"
  assert.equal(stripRemotePrefix('foo/bar/feature', ['foo/bar', 'origin']), 'feature');
  // prefer the longest matching remote when names overlap
  assert.equal(stripRemotePrefix('foo/bar/feature', ['foo', 'foo/bar']), 'feature');
  // local refs (no matching remote) and empty remote lists are returned as-is
  assert.equal(stripRemotePrefix('dev', ['origin']), 'dev');
  assert.equal(stripRemotePrefix('feature/x', ['origin']), 'feature/x');
  assert.equal(stripRemotePrefix('origin/main', []), 'origin/main');
});

test('baseDescriptor strips the remote prefix and reports the kind', () => {
  assert.deepEqual(
    baseDescriptor({ isRepo: true, base: 'origin/main', baseKind: 'remote', remotes: ['origin'] }),
    {
      ref: 'origin/main',
      shortName: 'main',
      kind: 'remote',
    },
  );
  // a slash-containing remote still resolves to the bare branch name
  assert.deepEqual(
    baseDescriptor({
      isRepo: true,
      base: 'foo/bar/main',
      baseKind: 'remote',
      remotes: ['foo/bar'],
    }),
    { ref: 'foo/bar/main', shortName: 'main', kind: 'remote' },
  );
  assert.deepEqual(baseDescriptor({ isRepo: true, base: 'dev', baseKind: 'local' }), {
    ref: 'dev',
    shortName: 'dev',
    kind: 'local',
  });
  assert.equal(baseDescriptor({ isRepo: true }), null);
  assert.equal(baseDescriptor(null), null);
});

test('worktreeName prefers the branch then falls back to the path basename', () => {
  assert.equal(
    worktreeName({ path: '/repo/.worktrees/feature', branch: 'feature-x' }),
    'feature-x',
  );
  assert.equal(worktreeName({ path: '/repo/.worktrees/feature', branch: null }), 'feature');
  assert.equal(worktreeName({ path: 'C:\\repo\\.worktrees\\win', branch: null }), 'win');
});

test('aheadBehindLabel renders only the non-zero sides', () => {
  assert.equal(aheadBehindLabel(2, 1), '↑2 ↓1');
  assert.equal(aheadBehindLabel(3, 0), '↑3');
  assert.equal(aheadBehindLabel(0, 4), '↓4');
  assert.equal(aheadBehindLabel(0, 0), null);
});

test('isWorktreeInUse matches the root and subdirectories, not sibling prefixes', () => {
  const wt = '/repo/.worktrees/feature';
  assert.equal(isWorktreeInUse(wt, [wt]), true);
  assert.equal(isWorktreeInUse(wt, ['/repo/.worktrees/feature/src']), true);
  // a sibling that merely shares the name prefix must not match
  assert.equal(isWorktreeInUse(wt, ['/repo/.worktrees/feature-2']), false);
  assert.equal(isWorktreeInUse(wt, []), false);
  assert.equal(isWorktreeInUse('', [wt]), false);
});

test('isWorktreeInUse tolerates separator, trailing-slash, and case differences', () => {
  assert.equal(isWorktreeInUse('/repo/.worktrees/feature/', ['/repo/.worktrees/feature']), true);
  assert.equal(isWorktreeInUse('C:\\repo\\wt', ['C:/repo/wt/src']), true);
  assert.equal(isWorktreeInUse('/Repo/WT', ['/repo/wt']), true);
});
