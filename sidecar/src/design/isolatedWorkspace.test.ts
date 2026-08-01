import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDesignWorkspace } from './isolatedWorkspace.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'droidex-iso-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(dir, 'README.md'), '# repo\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

test('prepareDesignWorkspace creates an isolated droidex/design worktree and seeds DNA', async () => {
  const repo = await makeRepo();
  // Uncommitted DNA in the live tree — must be carried into the worktree.
  await writeFile(join(repo, 'DESIGN.md'), '# DNA\n\nliving intent\n', 'utf8');

  const info = await prepareDesignWorkspace(repo);
  assert.equal(info.isWorktree, true);
  assert.equal(info.branch, 'droidex/design');
  // git resolves symlinks (/var -> /private/var on macOS), so compare by suffix.
  assert.ok(
    info.path.endsWith(join('.worktrees', 'droidex-design')),
    `worktree path under .worktrees/droidex-design (got ${info.path})`,
  );
  assert.ok(existsSync(info.path), 'worktree dir exists');

  const branch = (await git(info.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  assert.equal(branch, 'droidex/design');

  // DNA seeded into the worktree.
  assert.ok(existsSync(join(info.path, 'DESIGN.md')), 'DESIGN.md seeded into worktree');

  // Writing in the worktree must not appear in the live tree root.
  await writeFile(join(info.path, 'scratch.txt'), 'agent output\n', 'utf8');
  assert.equal(
    existsSync(join(repo, 'scratch.txt')),
    false,
    'worktree writes never touch the live tree',
  );

  // The live repo stays clean (.worktrees is excluded).
  const status = await git(repo, ['status', '--porcelain']);
  assert.doesNotMatch(status, /worktrees/, 'live repo status is not dirtied by the worktree');
});

test('prepareDesignWorkspace is idempotent — a second call reuses the worktree', async () => {
  const repo = await makeRepo();
  const first = await prepareDesignWorkspace(repo);
  const second = await prepareDesignWorkspace(repo);
  assert.equal(second.isWorktree, true);
  assert.equal(second.path, first.path);
});

test('prepareDesignWorkspace fails closed when the folder is not a git repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'droidex-plain-'));
  await assert.rejects(prepareDesignWorkspace(dir), /requires a Git repository/i);
});

test('prepareDesignWorkspace fails closed when worktree creation fails', async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, '.worktrees'), 'blocks the worktree directory', 'utf8');

  await assert.rejects(
    prepareDesignWorkspace(repo),
    /Could not create the isolated DROIDEX Design worktree/,
  );
  assert.equal(existsSync(join(repo, '.worktrees', 'droidex-design')), false);
});
