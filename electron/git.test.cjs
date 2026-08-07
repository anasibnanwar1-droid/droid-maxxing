const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  adoptTurnBaseline,
  createWorktree,
  diffFiles,
  fileDiff,
  markTurnStart,
} = require('./git.cjs');

// Integration tests for the last_turn review scope, driven through the module's
// public API against real scratch repositories. Each scenario gets its own
// repo: the untracked-file scan is TTL-cached per repo root, so reusing one
// repo across scenarios could serve a stale scan.

const repos = [];

function git(dir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

async function makeRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'droid-git-test-'));
  repos.push(dir);
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

async function write(dir, rel, content) {
  await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fsp.writeFile(path.join(dir, rel), content);
}

async function commitAll(dir, message) {
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-qm', message]);
}

const pathsOf = (res) => res.files.map((f) => f.path);

test.after(async () => {
  await Promise.all(repos.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

test('last_turn with a baseline lists the turn changes and hides preexisting untracked files', async () => {
  const dir = await makeRepo();
  await write(dir, 'tracked.txt', 'v1\n');
  await commitAll(dir, 'init');
  // Untracked before the turn begins: must not be attributed to the turn.
  await write(dir, 'notes.txt', 'preexisting\n');

  const mark = await markTurnStart(dir, 'session-a');
  assert.equal(mark.ok, true);

  await write(dir, 'tracked.txt', 'v2\n');
  await write(dir, 'new.txt', 'created this turn\n');

  const res = await diffFiles(dir, { mode: 'last_turn', appSessionId: 'session-a' });
  const paths = pathsOf(res);
  assert.ok(paths.includes('tracked.txt'), `tracked edit missing from ${paths}`);
  assert.ok(paths.includes('new.txt'), `turn-created file missing from ${paths}`);
  assert.ok(!paths.includes('notes.txt'), `preexisting untracked file leaked into ${paths}`);
});

test('last_turn without a baseline falls back to HEAD without flooding untracked files', async () => {
  const dir = await makeRepo();
  await write(dir, 'tracked.txt', 'v1\n');
  await commitAll(dir, 'init');
  await write(dir, 'notes.txt', 'preexisting\n');
  await write(dir, 'tracked.txt', 'v2\n');

  // No markTurnStart for this session (app restarted, session restored from
  // history). The HEAD approximation keeps tracked work visible, but without
  // a turn-start snapshot every untracked file would look like a turn change.
  const res = await diffFiles(dir, { mode: 'last_turn', appSessionId: 'never-marked' });
  const paths = pathsOf(res);
  assert.ok(paths.includes('tracked.txt'), `tracked change missing from ${paths}`);
  assert.ok(!paths.includes('notes.txt'), `untracked flood: ${paths}`);
});

test('last_turn follows the latest baseline once a newer turn begins', async () => {
  const dir = await makeRepo();
  await write(dir, 'a.txt', '1\n');
  await commitAll(dir, 'init');

  await markTurnStart(dir, 'session-a');
  await write(dir, 'a.txt', '2\n');
  let res = await diffFiles(dir, { mode: 'last_turn', appSessionId: 'session-a' });
  assert.ok(pathsOf(res).includes('a.txt'));

  // The next turn starts: the baseline advances past the previous turn's
  // edits, so they no longer appear as last-turn changes.
  await markTurnStart(dir, 'session-a');
  res = await diffFiles(dir, { mode: 'last_turn', appSessionId: 'session-a' });
  assert.deepEqual(pathsOf(res), []);
});

test('concurrent first turns adopt separate client baselines', async () => {
  const dir = await makeRepo();
  await write(dir, 'seed.txt', 'seed\n');
  await commitAll(dir, 'init');

  await markTurnStart(dir, 'client-a');
  await write(dir, 'a.txt', 'a\n');
  await markTurnStart(dir, 'client-b');
  await write(dir, 'b.txt', 'b\n');

  assert.deepEqual(await adoptTurnBaseline(dir, 'client-a', 'session-a'), { ok: true });
  assert.deepEqual(await adoptTurnBaseline(dir, 'client-b', 'session-b'), { ok: true });
  assert.deepEqual(
    pathsOf(await diffFiles(dir, { mode: 'last_turn', appSessionId: 'session-a' })),
    ['a.txt', 'b.txt'],
  );
  assert.deepEqual(
    pathsOf(await diffFiles(dir, { mode: 'last_turn', appSessionId: 'session-b' })),
    ['b.txt'],
  );

  // Adoption moves rather than copies the provisional entry.
  assert.deepEqual(await adoptTurnBaseline(dir, 'client-a', 'session-c'), { ok: false });
});

test('last_turn fileDiff renders a file created during the turn', async () => {
  const dir = await makeRepo();
  await write(dir, 'seed.txt', 'seed\n');
  await commitAll(dir, 'init');

  await markTurnStart(dir, 'session-a');
  await write(dir, 'new.txt', 'hello turn\n');

  const res = await fileDiff(dir, {
    mode: 'last_turn',
    appSessionId: 'session-a',
    path: 'new.txt',
  });
  assert.ok(res.diff.includes('hello turn'), 'turn-created file diff should show its content');
});

test('last_turn works in an unborn repo via the write-tree baseline', async () => {
  const dir = await makeRepo();
  // No commits yet: stash create and rev-parse HEAD both fail, so the
  // baseline falls back to the (empty) index tree.
  const mark = await markTurnStart(dir, 'session-a');
  assert.equal(mark.ok, true);

  await write(dir, 'first.txt', 'x\n');
  const res = await diffFiles(dir, { mode: 'last_turn', appSessionId: 'session-a' });
  assert.ok(pathsOf(res).includes('first.txt'));
});

test('a created worktree keeps its review diff after its base branch merges it', async () => {
  const dir = await makeRepo();
  await write(dir, 'seed.txt', 'seed\n');
  await commitAll(dir, 'init');
  const baseCommit = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const baseBranch = (await git(dir, ['branch', '--show-current'])).trim();

  const created = await createWorktree(dir, {
    branch: 'feature/review-after-merge',
    base: baseBranch,
    newBranch: true,
  });
  assert.equal(created.ok, true);
  assert.equal(
    created.path,
    path.join(await fsp.realpath(dir), '.worktrees', 'feature-review-after-merge'),
  );

  await write(created.path, 'feature.txt', 'kept for historical review\n');
  await commitAll(created.path, 'feature');
  const featureCommit = (await git(created.path, ['rev-parse', 'HEAD'])).trim();

  // Simulate main fast-forwarding when the branch is merged. The worktree
  // remains open on the feature branch, and Review must still show what that
  // session produced rather than comparing two refs that now point together.
  await git(dir, ['update-ref', `refs/heads/${baseBranch}`, featureCommit, baseCommit]);

  for (const mode of ['branch', 'worktree']) {
    const files = await diffFiles(created.path, { mode });
    assert.deepEqual(pathsOf(files), ['feature.txt'], `${mode} scope lost the merged change`);

    const rendered = await fileDiff(created.path, { mode, path: 'feature.txt' });
    assert.match(rendered.diff, /\+kept for historical review/);
  }
});

test('uncommitted file entries all render a current diff', async () => {
  const dir = await makeRepo();
  await write(dir, 'edited.txt', 'before\n');
  await write(dir, 'deleted.txt', 'remove me\n');
  await write(dir, 'renamed.txt', 'rename me\n');
  await commitAll(dir, 'init');

  await write(dir, 'edited.txt', 'after\n');
  await fsp.rm(path.join(dir, 'deleted.txt'));
  await git(dir, ['mv', 'renamed.txt', 'moved.txt']);
  await write(dir, 'untracked.txt', 'brand new\n');

  const result = await diffFiles(dir, { mode: 'uncommitted' });
  assert.deepEqual(pathsOf(result), ['deleted.txt', 'edited.txt', 'moved.txt', 'untracked.txt']);
  assert.equal(result.files.find((file) => file.path === 'moved.txt')?.status, 'renamed');

  for (const file of result.files) {
    const rendered = await fileDiff(dir, { mode: 'uncommitted', path: file.path });
    assert.notEqual(rendered.diff, '', `${file.status} ${file.path} had no diff`);
  }
});
