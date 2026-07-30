import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from './protocol.js';
import { filterSessionListSummaries } from './sessionListFilter.js';

const summary = (
  appSessionId: string,
  cwd: string,
  updatedAt: number,
  extra: Partial<SessionSummary> = {},
): SessionSummary => ({
  appSessionId,
  providerSessionId: appSessionId,
  sessionPurpose: 'chat',
  interactionMode: 'auto',
  role: 'primary',
  title: appSessionId,
  goal: appSessionId,
  cwd,
  workspaceKind: cwd ? 'folder' : 'none',
  autonomy: 'low',
  phase: 'paused',
  features: [],
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  createdAt: updatedAt,
  updatedAt,
  ...extra,
  compacting: extra.compacting ?? false,
});

test('filterSessionListSummaries returns only five latest summaries per requested workspace', () => {
  const summaries = [
    summary('plain-chat', '', 100),
    summary('other-workspace', '/repo/other', 200),
    ...Array.from({ length: 7 }, (_, i) => summary(`app-${i}`, '/repo/app', i + 1)),
    ...Array.from({ length: 3 }, (_, i) => summary(`api-${i}`, '/repo/api', i + 10)),
  ];

  const filtered = filterSessionListSummaries(summaries, {
    workspaceCwds: ['/repo/app', '/repo/api'],
    limitPerWorkspace: 5,
  });

  assert.deepEqual(
    filtered.map((m) => m.appSessionId),
    ['api-2', 'api-1', 'api-0', 'app-6', 'app-5', 'app-4', 'app-3', 'app-2'],
  );
});

test('filterSessionListSummaries returns every session when no per-workspace limit is given', () => {
  const summaries = Array.from({ length: 9 }, (_, i) => summary(`app-${i}`, '/repo/app', i + 1));

  const filtered = filterSessionListSummaries(summaries, { workspaceCwds: ['/repo/app'] });

  assert.equal(filtered.length, 9);
});

test('filterSessionListSummaries keeps latest plain chats when workspace loading is limited', () => {
  const summaries = [
    ...Array.from({ length: 7 }, (_, i) => summary(`plain-${i}`, '', i + 1)),
    ...Array.from({ length: 7 }, (_, i) => summary(`app-${i}`, '/repo/app', i + 20)),
    summary('other-workspace', '/repo/other', 100),
  ];

  const filtered = filterSessionListSummaries(summaries, {
    workspaceCwds: ['/repo/app'],
    includePlainChats: true,
    limitPerWorkspace: 3,
  });

  assert.deepEqual(
    filtered.map((m) => m.appSessionId),
    ['app-6', 'app-5', 'app-4', 'plain-6', 'plain-5', 'plain-4'],
  );
});
