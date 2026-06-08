import assert from 'node:assert/strict';
import test from 'node:test';
import type { MissionSummary } from './protocol.js';
import { filterMissionListSummaries } from './missionListFilter.js';

const summary = (id: string, cwd: string, updatedAt: number): MissionSummary => ({
  id,
  sessionId: id,
  kind: 'chat',
  role: 'orchestrator',
  title: id,
  goal: id,
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
});

test('filterMissionListSummaries returns only five latest summaries per requested workspace', () => {
  const summaries = [
    summary('plain-chat', '', 100),
    summary('other-workspace', '/repo/other', 200),
    ...Array.from({ length: 7 }, (_, i) => summary(`app-${i}`, '/repo/app', i + 1)),
    ...Array.from({ length: 3 }, (_, i) => summary(`api-${i}`, '/repo/api', i + 10)),
  ];

  const filtered = filterMissionListSummaries(summaries, {
    workspaceCwds: ['/repo/app', '/repo/api'],
    limitPerWorkspace: 5,
  });

  assert.deepEqual(filtered.map((m) => m.id), [
    'api-2',
    'api-1',
    'api-0',
    'app-6',
    'app-5',
    'app-4',
    'app-3',
    'app-2',
  ]);
});

test('filterMissionListSummaries keeps latest plain chats when workspace loading is limited', () => {
  const summaries = [
    ...Array.from({ length: 7 }, (_, i) => summary(`plain-${i}`, '', i + 1)),
    ...Array.from({ length: 7 }, (_, i) => summary(`app-${i}`, '/repo/app', i + 20)),
    summary('other-workspace', '/repo/other', 100),
  ];

  const filtered = filterMissionListSummaries(summaries, {
    workspaceCwds: ['/repo/app'],
    includePlainChats: true,
    limitPerWorkspace: 3,
  });

  assert.deepEqual(filtered.map((m) => m.id), [
    'app-6',
    'app-5',
    'app-4',
    'plain-6',
    'plain-5',
    'plain-4',
  ]);
});
