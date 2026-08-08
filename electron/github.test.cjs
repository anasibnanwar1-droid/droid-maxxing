const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePrComments,
  prComments,
  prSelector,
  resolveGhExecutable,
} = require('./github.cjs');

const ghResult = (overrides = {}) => ({
  code: 0,
  stdout: '',
  stderr: '',
  spawnFailed: false,
  ...overrides,
});

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
