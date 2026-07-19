import test, { afterEach } from 'node:test';
import assert from 'node:assert';
import { checkoutGitBranch, gitFetch } from './git';
import { createPullRequest, detectPullRequest, postPrComment } from './github';

// These wrappers promise one error contract: IPC-level rejections surface as
// structured failures, never as rejected promises. Simulate the desktop bridge
// by installing a fake window.droidControl for the duration of each test.
type FakeApi = Record<string, (...args: unknown[]) => Promise<unknown>>;
const g = globalThis as { window?: { droidControl?: FakeApi } };

function withBridge(api: FakeApi) {
  g.window = { droidControl: api };
}

afterEach(() => {
  delete g.window;
});

test('action wrappers fail with not_desktop outside the desktop shell', async () => {
  assert.deepEqual(await checkoutGitBranch('/repo', { ref: 'main' }), {
    ok: false,
    reason: 'not_desktop',
  });
});

test('gitFetch reports no_dir before the desktop check', async () => {
  assert.deepEqual(await gitFetch(''), { ok: false, reason: 'no_dir' });
});

test('action wrappers convert IPC rejections into failed results', async () => {
  withBridge({ gitCheckout: () => Promise.reject(new Error('bridge down')) });
  assert.deepEqual(await checkoutGitBranch('/repo', { ref: 'main' }), {
    ok: false,
    reason: 'ipc_error',
  });
});

test('action wrappers pass successful results through untouched', async () => {
  const result = { ok: true };
  withBridge({ gitCheckout: () => Promise.resolve(result) });
  assert.equal(await checkoutGitBranch('/repo', { ref: 'main' }), result);
});

test('detectPullRequest treats non-desktop and missing dir as an authoritative empty answer', async () => {
  // { ok: true, pr: null } may clear a previously shown PR ...
  assert.deepEqual(await detectPullRequest('/repo'), { ok: true, pr: null });
  withBridge({ githubDetectPr: () => Promise.resolve({ ok: true, pr: null }) });
  assert.deepEqual(await detectPullRequest(''), { ok: true, pr: null });
});

test('detectPullRequest reports IPC failure as non-authoritative', async () => {
  // ... while { ok: false } must keep the last-known PR in usePullRequest.
  withBridge({ githubDetectPr: () => Promise.reject(new Error('bridge down')) });
  assert.deepEqual(await detectPullRequest('/repo'), { ok: false, pr: null });
});

test('detectPullRequest passes the bridge answer through untouched', async () => {
  const answer = { ok: true, pr: { number: 12, title: 'x' } };
  withBridge({ githubDetectPr: () => Promise.resolve(answer) });
  assert.equal(await detectPullRequest('/repo', 'feature/foo'), answer);
});

test('createPullRequest and postPrComment convert IPC rejections into failed results', async () => {
  withBridge({
    githubCreatePr: () => Promise.reject(new Error('bridge down')),
    githubPostComment: () => Promise.reject(new Error('bridge down')),
  });
  assert.deepEqual(await createPullRequest('/repo', { title: 't' }), {
    ok: false,
    reason: 'error',
  });
  assert.deepEqual(await postPrComment('/repo', 12, 'hello'), { ok: false, reason: 'error' });
});
