import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

// The electron backend is CommonJS; pull the exported pure validation helpers
// through createRequire so they run under the same node:test harness.
const require = createRequire(import.meta.url);
const git = require('../../electron/git.cjs');
const github = require('../../electron/github.cjs');

test('validBranchName accepts normal and hierarchical branch names', () => {
  for (const name of ['main', 'feature/foo', 'fix/issue-27/part.2', 'v1.0', 'HEAD-2']) {
    assert.equal(git.validBranchName(name), true, name);
  }
});

test('validBranchName rejects option-like and malformed names', () => {
  const bad = [
    null,
    undefined,
    '',
    42,
    '-D', // leading dash would be parsed as a git option
    '--force',
    '@',
    'a..b',
    'a@{1}',
    'name.',
    'a b',
    'a\tb',
    'a\nb',
    'a~1',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'a\x00b',
    'a\x1fb',
    'a\x7fb',
    '/leading',
    'trailing/',
    'a//b',
    '.hidden',
    'nested/.hidden',
    'name.lock',
    'nested/name.lock/x',
  ];
  for (const name of bad) {
    assert.equal(git.validBranchName(name), false, String(name));
  }
});

test('sanitizeSegment collapses unsafe characters and trims dashes', () => {
  assert.equal(git.sanitizeSegment('feature/foo bar'), 'feature-foo-bar');
  assert.equal(git.sanitizeSegment('--weird--'), 'weird');
  assert.equal(git.sanitizeSegment('a.b-c_d'), 'a.b-c_d');
  assert.equal(git.sanitizeSegment(''), '');
  assert.equal(git.sanitizeSegment(null), '');
  assert.equal(git.sanitizeSegment('///'), '');
  assert.equal(git.sanitizeSegment('x'.repeat(200)).length, 80);
});

test('isWithin matches exact paths and children on a separator boundary', () => {
  const base = path.join(path.sep, 'repo');
  assert.equal(git.isWithin(base, base), true);
  assert.equal(git.isWithin(base, path.join(base, 'sub', 'file')), true);
  // "/repo-evil" shares the prefix but is not inside "/repo"
  assert.equal(git.isWithin(base, `${base}-evil`), false);
  assert.equal(git.isWithin(base, path.join(path.sep, 'other')), false);
});

test('allowedWorktreeTarget keeps targets inside repo, parent, or home', () => {
  const root = path.join(path.sep, 'private', 'srv', 'repo');
  assert.equal(git.allowedWorktreeTarget(root, path.join(root, '.worktrees', 'wt')), true);
  assert.equal(git.allowedWorktreeTarget(root, path.join(path.dirname(root), 'sibling')), true);
  assert.equal(git.allowedWorktreeTarget(root, path.join(os.homedir(), 'worktrees', 'wt')), true);
  assert.equal(git.allowedWorktreeTarget(root, path.join(path.sep, 'etc', 'planted')), false);
  assert.equal(git.allowedWorktreeTarget(root, path.join(path.sep, 'tmp', 'planted')), false);
  // nesting inside the .git dir would corrupt the repo
  assert.equal(git.allowedWorktreeTarget(root, path.join(root, '.git', 'wt')), false);
  // prefix sibling of root is only allowed because it sits in root's parent
  assert.equal(git.allowedWorktreeTarget(root, `${root}-evil`), true);
});

test('matchRemote prefers the longest configured remote name', () => {
  assert.equal(git.matchRemote('origin/main', ['origin']), 'origin');
  assert.equal(git.matchRemote('foo/bar/feature', ['foo', 'foo/bar']), 'foo/bar');
  assert.equal(git.matchRemote('origin', ['origin']), 'origin');
  assert.equal(git.matchRemote('originals/x', ['origin']), null);
  assert.equal(git.matchRemote('dev', ['origin']), null);
  assert.equal(git.matchRemote('origin/main', []), null);
  assert.equal(git.matchRemote(null, ['origin']), null);
  assert.equal(git.matchRemote('origin/main', null), null);
});

test('prSelector only accepts bare integers', () => {
  assert.equal(github.prSelector('12'), '12');
  assert.equal(github.prSelector(12), '12');
  assert.equal(github.prSelector(0), '0');
  for (const value of [
    null,
    undefined,
    '',
    '-1',
    '--repo=evil/evil',
    '12abc',
    '1.5',
    'feature/foo',
    'https://github.com/owner/repo/pull/12',
    ' 12',
    '12 ',
  ]) {
    assert.equal(github.prSelector(value), null, String(value));
  }
});
