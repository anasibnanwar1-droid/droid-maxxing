import test from 'node:test';
import assert from 'node:assert';
import {
  aheadBehindLabel,
  baseDescriptor,
  checkoutBlockReason,
  diffModeLabel,
  worktreeName,
  worktreeSwitchBlockReason,
} from './git';

test('diffModeLabel names each mode, using the default branch for the branch mode', () => {
  assert.equal(diffModeLabel('worktree'), 'Worktree');
  assert.equal(diffModeLabel('uncommitted'), 'Uncommitted');
  assert.equal(diffModeLabel('branch', 'develop'), 'Branch vs origin/develop');
  assert.equal(diffModeLabel('branch', null), 'Branch vs origin/main');
});

test('baseDescriptor strips the remote prefix and reports the kind', () => {
  assert.deepEqual(baseDescriptor({ isRepo: true, base: 'origin/main', baseKind: 'remote' }), {
    ref: 'origin/main',
    shortName: 'main',
    kind: 'remote',
  });
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

test('worktreeSwitchBlockReason blocks switching during an active session', () => {
  assert.equal(worktreeSwitchBlockReason({ hasActiveSession: true }), 'active_session');
  assert.equal(worktreeSwitchBlockReason({ hasActiveSession: false }), null);
});

test('checkoutBlockReason prioritizes the live agent over a dirty tree', () => {
  assert.equal(checkoutBlockReason({ live: true, dirty: true }), 'live');
  assert.equal(checkoutBlockReason({ live: false, dirty: true }), 'dirty');
  assert.equal(checkoutBlockReason({ live: false, dirty: false }), null);
});
