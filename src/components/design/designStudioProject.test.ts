import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalLiveProjectCwd,
  recoverLiveProjectCwd,
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

test('Studio recovers a relocated design worktree through Git repository identity', async () => {
  const liveCwd = await recoverLiveProjectCwd('/tmp/custom-design-checkout', [], async (cwd) => {
    assert.equal(cwd, '/tmp/custom-design-checkout');
    return [
      {
        path: '/repo/live',
        branch: 'main',
        isMain: true,
        isCurrent: false,
      },
      {
        path: '/tmp/custom-design-checkout',
        branch: 'droidex/design',
        isMain: false,
        isCurrent: true,
      },
    ];
  });

  assert.equal(liveCwd, '/repo/live');
});

test('Studio does not recover a live root that already has an isolated workspace', async () => {
  const liveCwd = await recoverLiveProjectCwd('/repo/live', workspaces, async () => {
    throw new Error('Git recovery should not run for a known live workspace.');
  });

  assert.equal(liveCwd, '/repo/live');
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

test('Studio repository options collapse a recovered relocated design worktree', () => {
  assert.deepEqual(
    studioRepositoryCwds(
      '/repo/live',
      ['/repo/live', '/tmp/custom-design-checkout'],
      [{ liveCwd: '/repo/live', path: '/tmp/custom-design-checkout' }],
    ),
    ['/repo/live'],
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
