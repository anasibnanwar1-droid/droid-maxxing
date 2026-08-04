import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PullRequest } from '../../types/vcs';
import { PullRequestPanel } from './PullRequestPanel';

const pr: PullRequest = {
  number: 78,
  title: 'Improve PR details',
  state: 'OPEN',
  url: 'https://example.test/pull/78',
  isDraft: false,
  headRefName: 'feature',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  additions: 10,
  deletions: 2,
  changedFiles: 2,
  createdAt: '2026-08-04T10:00:00Z',
  updatedAt: '2026-08-04T10:00:00Z',
  author: 'author',
};

test('PR comments expose reactions in collapsed cards with a send control', () => {
  const html = renderToStaticMarkup(
    createElement(PullRequestPanel, {
      cwd: '/repo',
      pr,
      checks: [],
      comments: [
        {
          id: 'comment-1',
          kind: 'comment',
          author: 'reviewer',
          body: 'Looks good to me',
          createdAt: '2026-08-04T10:01:00Z',
          url: 'https://example.test/comment/1',
          state: null,
          reactions: [
            { content: 'THUMBS_UP', count: 3 },
            { content: 'EYES', count: 1 },
          ],
        },
      ],
      loadingDetail: false,
      checksError: null,
      commentsError: null,
      onBack: () => undefined,
      onRefresh: () => undefined,
    }),
  );

  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Looks good to me/);
  assert.match(html, /👍/);
  assert.match(html, /👀/);
  assert.match(html, />3</);
  assert.match(html, /lucide-send-horizontal/);
});
