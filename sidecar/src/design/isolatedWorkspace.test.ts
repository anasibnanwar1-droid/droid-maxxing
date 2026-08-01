import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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

async function makeUnbornRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'droidex-iso-unborn-'));
  await git(dir, ['init', '-q', '-b', 'main']);
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

test('prepareDesignWorkspace snapshots a repository before its first commit', async () => {
  const repo = await makeUnbornRepo();
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n', 'utf8');
  await writeFile(join(repo, 'README.md'), '# greenfield\n', 'utf8');
  await writeFile(join(repo, 'src', 'app.ts'), 'export const ready = true;\n', 'utf8');
  await writeFile(join(repo, 'ignored.txt'), 'do not copy\n', 'utf8');
  await symlink('README.md', join(repo, 'readme-link'));

  const info = await prepareDesignWorkspace(repo);

  assert.equal(info.isWorktree, true);
  assert.equal(info.branch, 'droidex/design');
  assert.equal((await git(info.path, ['branch', '--show-current'])).trim(), 'droidex/design');
  assert.equal(await readFile(join(info.path, 'README.md'), 'utf8'), '# greenfield\n');
  assert.equal(
    await readFile(join(info.path, 'src', 'app.ts'), 'utf8'),
    'export const ready = true;\n',
  );
  assert.equal(existsSync(join(info.path, 'readme-link')), true, 'symlink is preserved');
  assert.equal(existsSync(join(info.path, 'ignored.txt')), false, 'ignored files stay excluded');
  assert.equal(existsSync(join(repo, 'src', 'agent-output.ts')), false);

  await writeFile(join(info.path, 'src', 'agent-output.ts'), 'isolated\n', 'utf8');
  assert.equal(existsSync(join(repo, 'src', 'agent-output.ts')), false);
});

test('prepareDesignWorkspace snapshots the whole repository when opened from a nested folder', async () => {
  const repo = await makeUnbornRepo();
  const app = join(repo, 'packages', 'app');
  await mkdir(app, { recursive: true });
  await writeFile(join(repo, 'README.md'), '# root\n', 'utf8');
  await writeFile(join(app, 'index.ts'), 'export {};\n', 'utf8');

  const info = await prepareDesignWorkspace(app);

  assert.equal(await readFile(join(info.path, 'README.md'), 'utf8'), '# root\n');
  assert.equal(
    await readFile(join(info.path, 'packages', 'app', 'index.ts'), 'utf8'),
    'export {};\n',
  );
});

test('prepareDesignWorkspace rejects absolute symlinks that escape isolation', async () => {
  const repo = await makeUnbornRepo();
  const outside = await mkdtemp(join(tmpdir(), 'droidex-iso-outside-'));
  const outsideFile = join(outside, 'secret.txt');
  await writeFile(outsideFile, 'outside\n', 'utf8');
  await symlink(outsideFile, join(repo, 'unsafe-link'));

  await assert.rejects(
    prepareDesignWorkspace(repo),
    /Refusing to copy a symlink outside the isolated workspace/,
  );
  assert.equal(existsSync(join(repo, '.worktrees', 'droidex-design')), false);
});

test('prepareDesignWorkspace cleans a partial snapshot before retrying', async () => {
  const repo = await makeUnbornRepo();
  const outside = await mkdtemp(join(tmpdir(), 'droidex-iso-outside-'));
  const outsideFile = join(outside, 'outside.txt');
  await writeFile(join(repo, 'README.md'), '# retry\n', 'utf8');
  await writeFile(outsideFile, 'outside\n', 'utf8');
  const link = join(repo, 'unsafe-link');
  await symlink(relative(dirname(link), outsideFile), link);

  await assert.rejects(
    prepareDesignWorkspace(repo),
    /Refusing to copy a symlink outside the isolated workspace/,
  );
  assert.equal(existsSync(join(repo, '.worktrees', 'droidex-design')), false);

  await unlink(link);
  await writeFile(link, 'safe now\n', 'utf8');
  const info = await prepareDesignWorkspace(repo);

  assert.equal(await readFile(join(info.path, 'unsafe-link'), 'utf8'), 'safe now\n');
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
