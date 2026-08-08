const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  available,
  authenticate,
  cancelSetup,
  install,
  isGithubDeviceUrl,
  normalizePrComments,
  prComments,
  prSelector,
  resolveBrewExecutable,
  resolveGhExecutable,
} = require('./github.cjs');

const ghResult = (overrides = {}) => ({
  code: 0,
  stdout: '',
  stderr: '',
  spawnFailed: false,
  ...overrides,
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  return child;
}

test('resolves Homebrew gh under a Finder-style PATH', async () => {
  const probes = [];
  const executable = await resolveGhExecutable({
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      if (candidate !== '/opt/homebrew/bin/gh') {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    runFile: async (file, args) => {
      probes.push([file, args]);
      return ghResult({ stdout: 'gh version 2.78.0' });
    },
  });

  assert.equal(executable, '/opt/homebrew/bin/gh');
  assert.deepEqual(probes, [['/opt/homebrew/bin/gh', ['--version']]]);
});

test('prefers PATH and validates the executable before common locations', async () => {
  const candidates = [];
  const executable = await resolveGhExecutable({
    env: { PATH: '/custom/bin:/usr/bin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      candidates.push(candidate);
      if (candidate !== '/custom/bin/gh') throw new Error('unexpected candidate');
    },
    runFile: async () => ghResult({ stdout: 'gh version 2.78.0' }),
  });

  assert.equal(executable, '/custom/bin/gh');
  assert.deepEqual(candidates, ['/custom/bin/gh']);
});

test('uses the fixed login-shell lookup last and returns null when it is invalid', async () => {
  const shellCalls = [];
  const executable = await resolveGhExecutable({
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    access: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    runFile: async (file, args) => {
      shellCalls.push([file, args]);
      return ghResult({ stdout: '/custom/login/bin/gh\n' });
    },
  });

  assert.equal(executable, null);
  assert.deepEqual(shellCalls, [['/bin/zsh', ['-lc', 'command -v gh']]]);
});

test('discovers gh from the configured login shell after common paths fail', async () => {
  const executable = await resolveGhExecutable({
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      if (candidate !== '/custom/login/bin/gh') throw new Error('missing');
    },
    runFile: async (file, args) => {
      if (file === '/bin/zsh') {
        assert.deepEqual(args, ['-lc', 'command -v gh']);
        return ghResult({ stdout: '/custom/login/bin/gh\n' });
      }
      return ghResult({ stdout: 'gh version 2.78.0' });
    },
  });

  assert.equal(executable, '/custom/login/bin/gh');
});

test('availability reports the supported recovery path when gh is missing', async () => {
  const homebrew = await available({
    runGh: async () => ghResult({ code: 1, spawnFailed: true }),
    resolveBrew: async () => '/opt/homebrew/bin/brew',
  });
  assert.deepEqual(homebrew, {
    installed: false,
    authenticated: false,
    installMethod: 'homebrew',
  });

  const manual = await available({
    runGh: async () => ghResult({ code: 1, spawnFailed: true }),
    resolveBrew: async () => null,
  });
  assert.deepEqual(manual, {
    installed: false,
    authenticated: false,
    installMethod: 'manual',
  });
});

test('resolves Apple Silicon Homebrew under a Finder-style PATH', async () => {
  const executable = await resolveBrewExecutable({
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      if (candidate !== '/opt/homebrew/bin/brew') throw new Error('missing');
    },
    runFile: async (file, args) => {
      assert.equal(file, '/opt/homebrew/bin/brew');
      assert.deepEqual(args, ['--version']);
      return ghResult({ stdout: 'Homebrew 4.6.0' });
    },
  });

  assert.equal(executable, '/opt/homebrew/bin/brew');
});

test('resolves Intel Homebrew after the Apple Silicon location is absent', async () => {
  const executable = await resolveBrewExecutable({
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      if (candidate !== '/usr/local/bin/brew') throw new Error('missing');
    },
    runFile: async () => ghResult({ stdout: 'Homebrew 4.6.0' }),
  });

  assert.equal(executable, '/usr/local/bin/brew');
});

test('installs gh with a fixed Homebrew argument vector and verifies gh', async () => {
  const calls = [];
  const result = await install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async (file, args) => {
      calls.push([file, args]);
      return { code: 0, timedOut: false };
    },
    resolveGh: async () => '/opt/homebrew/bin/gh',
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [['/opt/homebrew/bin/brew', ['install', 'gh']]]);
});

test('installation reports a missing supported package manager', async () => {
  const result = await install({ resolveBrew: async () => null });

  assert.deepEqual(result, {
    ok: false,
    reason: 'installer_missing',
    message: 'Homebrew is not installed.',
  });
});

test('installation verifies gh even when Homebrew exits successfully', async () => {
  const result = await install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async () => ({ code: 0, timedOut: false }),
    resolveGh: async () => null,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'verification_failed',
    message: 'GitHub CLI was not found after installation.',
  });
});

test('installation reports Homebrew failure and timeout without raw output', async () => {
  const failed = await install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async () => ({ code: 1, timedOut: false, stderr: 'private package details' }),
  });
  assert.deepEqual(failed, {
    ok: false,
    reason: 'install_failed',
    message: 'Homebrew could not install GitHub CLI.',
  });

  const timedOut = await install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async () => ({ code: 1, timedOut: true }),
  });
  assert.deepEqual(timedOut, {
    ok: false,
    reason: 'timeout',
    message: 'GitHub CLI installation timed out.',
  });
});

test('only one GitHub setup operation runs at a time', async () => {
  let finishInstall;
  const first = install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async () =>
      new Promise((resolve) => {
        finishInstall = () => resolve({ code: 0, timedOut: false });
      }),
    resolveGh: async () => '/opt/homebrew/bin/gh',
  });
  await Promise.resolve();

  const second = await install({ resolveBrew: async () => '/opt/homebrew/bin/brew' });
  assert.deepEqual(second, {
    ok: false,
    reason: 'busy',
    message: 'GitHub setup is already running.',
  });

  finishInstall();
  assert.deepEqual(await first, { ok: true });
});

test('accepts only the exact GitHub device-login URL', () => {
  assert.equal(isGithubDeviceUrl('https://github.com/login/device'), true);
  assert.equal(isGithubDeviceUrl('https://github.com/login/device/extra'), false);
  assert.equal(isGithubDeviceUrl('https://github.com.evil.test/login/device'), false);
  assert.equal(isGithubDeviceUrl('http://github.com/login/device'), false);
  assert.equal(isGithubDeviceUrl('not a URL'), false);
});

test('browser authentication uses fixed arguments and opens the emitted device URL', async () => {
  const opened = [];
  const deviceCodes = [];
  const child = fakeChild();
  const pending = authenticate(async (url) => opened.push(url), {
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: (file, args, options) => {
      assert.equal(file, '/opt/homebrew/bin/gh');
      assert.deepEqual(args, [
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--git-protocol',
        'https',
        '--web',
        '--clipboard',
        '--skip-ssh-key',
      ]);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      queueMicrotask(() => {
        child.stderr.write('First copy your one-time code: ABCD-7HJK\n');
        child.stderr.write('Open this URL to continue: https://github.com/login/');
        child.stderr.write('device\n');
        child.emit('close', 0, null);
      });
      return child;
    },
    onDeviceCode: (code) => deviceCodes.push(code),
    verifyAuth: async () => true,
  });

  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(opened, ['https://github.com/login/device']);
  assert.deepEqual(deviceCodes, ['ABCD-7HJK']);
});

test('browser authentication never exposes malformed device codes', async () => {
  const deviceCodes = [];
  const child = fakeChild();
  const result = await authenticate(async () => undefined, {
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write('First copy your one-time code: not-a-code\n');
        child.stderr.write('https://github.com/login/device\n');
        child.emit('close', 0, null);
      });
      return child;
    },
    onDeviceCode: (code) => deviceCodes.push(code),
    verifyAuth: async () => true,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(deviceCodes, []);
});

test('browser authentication rejects a non-GitHub verification URL', async () => {
  const child = fakeChild();
  const result = await authenticate(async () => assert.fail('must not open browser'), {
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write('Open this URL: https://github.com.evil.test/login/device\n');
        child.emit('close', 0, null);
      });
      return child;
    },
    verifyAuth: async () => true,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'browser_failed',
    message: 'GitHub CLI did not provide a trusted sign-in page.',
  });
});

test('browser authentication reports browser-open failure without raw errors', async () => {
  const child = fakeChild();
  const result = await authenticate(
    async () => {
      throw new Error('private browser details');
    },
    {
      resolveGh: async () => '/opt/homebrew/bin/gh',
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stderr.write('https://github.com/login/device\n');
        });
        return child;
      },
      verifyAuth: async () => true,
    },
  );

  assert.deepEqual(result, {
    ok: false,
    reason: 'browser_failed',
    message: 'DROIDEX could not open the GitHub sign-in page.',
  });
  assert.equal(child.killed, true);
});

test('browser authentication requires final gh auth verification', async () => {
  const child = fakeChild();
  const result = await authenticate(async () => undefined, {
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write('https://github.com/login/device\n');
        child.emit('close', 0, null);
      });
      return child;
    },
    verifyAuth: async () => false,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'auth_failed',
    message: 'GitHub CLI could not verify the signed-in account.',
  });
});

test('browser authentication times out and terminates its child', async () => {
  const child = fakeChild();
  const result = await authenticate(async () => undefined, {
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => {
      setImmediate(() => child.emit('close', 1, null));
      return child;
    },
    verifyAuth: async () => true,
    authTimeoutMs: 25,
    setTimer: (callback, timeoutMs) => {
      assert.equal(timeoutMs, 25);
      callback();
      return { unref() {} };
    },
    clearTimer: () => undefined,
  });

  assert.equal(child.killed, true);
  assert.deepEqual(result, {
    ok: false,
    reason: 'timeout',
    message: 'GitHub sign-in timed out.',
  });
});

test('cancelling browser authentication terminates its child process', async () => {
  const child = fakeChild();
  const pending = authenticate(async () => undefined, {
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => child,
    verifyAuth: async () => true,
  });
  await Promise.resolve();

  cancelSetup();

  assert.equal(child.killed, true);
  assert.deepEqual(await pending, {
    ok: false,
    reason: 'cancelled',
    message: 'GitHub sign-in was cancelled.',
  });
});

test('PR selectors accept only bare positive digit strings', () => {
  assert.equal(prSelector(78), '78');
  assert.equal(prSelector('078'), '078');
  assert.equal(prSelector('--repo=other/repo'), null);
  assert.equal(prSelector('https://github.com/example/repo/pull/78'), null);
});

test('PR comments include top-level, review, and inline review threads', () => {
  const comments = normalizePrComments(
    {
      comments: [
        {
          databaseId: 10,
          author: { login: 'author' },
          body: 'Top-level **comment**',
          createdAt: '2026-08-04T10:00:00Z',
          url: 'https://example.test/comment/10',
          reactionGroups: [{ content: 'EYES', users: { totalCount: 2 } }],
        },
      ],
      reviews: [
        {
          id: 'review-20',
          author: { login: 'reviewer' },
          body: 'Changes requested',
          submittedAt: '2026-08-04T10:01:00Z',
          state: 'CHANGES_REQUESTED',
          reactionGroups: [{ content: 'THUMBS_UP', users: { totalCount: 1 } }],
        },
      ],
    },
    [
      {
        id: 30,
        user: { login: 'inline-reviewer' },
        body: 'Fix `scope` here',
        created_at: '2026-08-04T10:02:00Z',
        html_url: 'https://example.test/review/30',
        path: 'src/components/ReviewPanel.tsx',
        line: 42,
        diff_hunk: '@@ -40,2 +40,3 @@',
        reactions: { '+1': 3, heart: 1, total_count: 4 },
      },
    ],
  );

  assert.deepEqual(
    comments.map(({ kind, author, body, path, line, reactions }) => ({
      kind,
      author,
      body,
      path,
      line,
      reactions,
    })),
    [
      {
        kind: 'comment',
        author: 'author',
        body: 'Top-level **comment**',
        path: undefined,
        line: undefined,
        reactions: [{ content: 'EYES', count: 2 }],
      },
      {
        kind: 'review',
        author: 'reviewer',
        body: 'Changes requested',
        path: undefined,
        line: undefined,
        reactions: [{ content: 'THUMBS_UP', count: 1 }],
      },
      {
        kind: 'inline',
        author: 'inline-reviewer',
        body: 'Fix `scope` here',
        path: 'src/components/ReviewPanel.tsx',
        line: 42,
        reactions: [
          { content: 'THUMBS_UP', count: 3 },
          { content: 'HEART', count: 1 },
        ],
      },
    ],
  );
});

test('PR comments keep conversation comments when inline pagination fails', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr') {
      return ghResult({
        stdout: JSON.stringify({
          comments: [{ databaseId: 10, author: { login: 'author' }, body: 'available' }],
          reviews: [],
        }),
      });
    }
    return ghResult({ code: 1, stderr: 'REST rate limited' });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.message, /REST rate limited/);
  assert.deepEqual(
    result.comments.map((comment) => comment.body),
    ['available'],
  );
});

test('PR comments keep inline comments when conversation lookup fails', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr') return ghResult({ code: 1, stderr: 'GraphQL unavailable' });
    return ghResult({
      stdout: JSON.stringify([
        [
          {
            id: 30,
            user: { login: 'reviewer' },
            body: 'inline available',
            path: 'src/file.ts',
            line: 4,
          },
        ],
      ]),
    });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.message, /GraphQL unavailable/);
  assert.deepEqual(
    result.comments.map((comment) => comment.body),
    ['inline available'],
  );
});

test('PR comments fail only when neither source succeeds', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) =>
    ghResult({ code: 1, stderr: `${args[0]} failed` }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'gh_error');
  assert.deepEqual(result.comments, []);
  assert.match(result.message, /pr failed/);
  assert.match(result.message, /api failed/);
});
