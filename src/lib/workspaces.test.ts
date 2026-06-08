import test from 'node:test';
import assert from 'node:assert/strict';
import type { MissionSummary } from '../types/bridge';
import { addWorkspaceCwd, buildWorkspaceSections } from './workspaces';

const mission = (id: string, cwd: string, updatedAt: number): MissionSummary => ({
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

test('addWorkspaceCwd keeps explicit workspaces unique and ordered newest first', () => {
  assert.deepEqual(addWorkspaceCwd(['/repo/old'], '/repo/new'), ['/repo/new', '/repo/old']);
  assert.deepEqual(addWorkspaceCwd(['/repo/old', '/repo/new'], '/repo/old'), ['/repo/old', '/repo/new']);
  assert.deepEqual(addWorkspaceCwd(['/repo/old'], ''), ['/repo/old']);
});

test('buildWorkspaceSections includes all explicitly added workspace sessions', () => {
  const missions = [
    mission('plain-chat', '', 100),
    mission('other-workspace', '/repo/other', 200),
    ...Array.from({ length: 7 }, (_, i) => mission(`repo-${i}`, '/repo/app', i + 1)),
  ];

  const sections = buildWorkspaceSections(['/repo/app'], missions);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].cwd, '/repo/app');
  assert.deepEqual(sections[0].sessions.map((m) => m.id), ['repo-6', 'repo-5', 'repo-4', 'repo-3', 'repo-2', 'repo-1', 'repo-0']);
});
