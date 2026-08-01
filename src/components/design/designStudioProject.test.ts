import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalLiveProjectCwd,
  studioRepositoryCwds,
  studioWorkspaceAccess,
} from './designStudioProject';

const workspaces = [{ liveCwd: '/repo/live', path: '/repo/live/.worktrees/droidex-design' }];

test('Studio project identity remains anchored to the live repository', () => {
  assert.equal(
    canonicalLiveProjectCwd('/repo/live/.worktrees/droidex-design', workspaces),
    '/repo/live',
  );
  assert.equal(canonicalLiveProjectCwd('/other', workspaces), '/other');
});

test('Studio recovers the live repository from a persisted isolated cwd after cold start', () => {
  assert.equal(canonicalLiveProjectCwd('/repo/.worktrees/droidex-design', []), '/repo');
});

test('Studio repository options never expose its internal worktree as another project', () => {
  assert.deepEqual(
    studioRepositoryCwds(
      '/repo/live/.worktrees/droidex-design',
      ['/repo/live', '/other'],
      workspaces,
    ),
    ['/repo/live', '/other'],
  );
});

test('Studio stays blocked until the isolated workspace is ready', () => {
  assert.deepEqual(studioWorkspaceAccess('/repo/live', undefined, undefined), {
    kind: 'loading',
  });
  assert.deepEqual(studioWorkspaceAccess('/repo/live', undefined, 'worktree failed'), {
    kind: 'error',
    message: 'worktree failed',
  });
  assert.deepEqual(studioWorkspaceAccess('/repo/live', workspaces[0], undefined), {
    kind: 'ready',
    cwd: '/repo/live/.worktrees/droidex-design',
  });
});
