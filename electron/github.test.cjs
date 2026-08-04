const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePrComments, prSelector } = require('./github.cjs');

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
        },
      ],
      reviews: [
        {
          id: 'review-20',
          author: { login: 'reviewer' },
          body: 'Changes requested',
          submittedAt: '2026-08-04T10:01:00Z',
          state: 'CHANGES_REQUESTED',
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
      },
    ],
  );

  assert.deepEqual(
    comments.map(({ kind, author, body, path, line }) => ({ kind, author, body, path, line })),
    [
      {
        kind: 'comment',
        author: 'author',
        body: 'Top-level **comment**',
        path: undefined,
        line: undefined,
      },
      {
        kind: 'review',
        author: 'reviewer',
        body: 'Changes requested',
        path: undefined,
        line: undefined,
      },
      {
        kind: 'inline',
        author: 'inline-reviewer',
        body: 'Fix `scope` here',
        path: 'src/components/ReviewPanel.tsx',
        line: 42,
      },
    ],
  );
});
