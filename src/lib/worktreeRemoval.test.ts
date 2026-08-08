import test from 'node:test';
import assert from 'node:assert/strict';
import { removeWorktreeAndReanchor } from './worktreeRemoval';

test('failed removal leaves linked sessions anchored to the existing worktree', async () => {
  const calls: string[] = [];
  const outcome = await removeWorktreeAndReanchor(
    async () => {
      calls.push('remove');
      return { ok: false, reason: 'not_clean' };
    },
    async () => {
      calls.push('reanchor');
      return 2;
    },
  );

  assert.deepEqual(calls, ['remove']);
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.reanchored, 0);
  assert.equal(outcome.reanchorFailed, false);
});

test('successful removal reanchors linked sessions after the worktree is gone', async () => {
  const calls: string[] = [];
  const outcome = await removeWorktreeAndReanchor(
    async () => {
      calls.push('remove');
      return { ok: true, branchDeleted: true };
    },
    async () => {
      calls.push('reanchor');
      return 2;
    },
  );

  assert.deepEqual(calls, ['remove', 'reanchor']);
  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.reanchored, 2);
  assert.equal(outcome.reanchorFailed, false);
});

test('successful removal reports a later reanchor failure separately', async () => {
  const outcome = await removeWorktreeAndReanchor(
    async () => ({ ok: true }),
    async () => {
      throw new Error('sidecar unavailable');
    },
  );

  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.reanchored, 0);
  assert.equal(outcome.reanchorFailed, true);
});
