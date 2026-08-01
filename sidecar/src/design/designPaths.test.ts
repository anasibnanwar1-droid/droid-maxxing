import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectDesignDir } from './designPaths.js';

test('project design data is shared by a git repository and its linked worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'droidex-design-paths-git-'));
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktree');
  execFileSync('git', ['init', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'initial'], {
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', worktree], { stdio: 'ignore' });

  assert.equal(projectDesignDir(repo, root), projectDesignDir(worktree, root));
});

test('project design data resolves symlinked directories to one identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'droidex-design-paths-dir-'));
  const project = mkdtempSync(join(root, 'project-'));
  const alias = join(root, 'alias');
  symlinkSync(project, alias);

  assert.equal(projectDesignDir(project, root), projectDesignDir(alias, root));
});
