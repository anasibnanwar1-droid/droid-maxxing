import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionSummary } from '../types/bridge';
import {
  addWorkspaceCwd,
  buildWorkspaceSections,
  resolveNewChatCwd,
  SIDEBAR_VISIBLE_SESSION_LIMIT,
} from './workspaces';

const session = (appSessionId: string, cwd: string, updatedAt: number): SessionSummary => ({
  appSessionId,
  providerSessionId: `provider-${appSessionId}`,
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
});

test('addWorkspaceCwd keeps explicit workspaces unique and ordered newest first', () => {
  assert.deepEqual(addWorkspaceCwd(['/repo/old'], '/repo/new'), ['/repo/new', '/repo/old']);
  assert.deepEqual(addWorkspaceCwd(['/repo/old', '/repo/new'], '/repo/old'), [
    '/repo/old',
    '/repo/new',
  ]);
  assert.deepEqual(addWorkspaceCwd(['/repo/old'], ''), ['/repo/old']);
});

test('resolveNewChatCwd inherits the active workspace session folder', () => {
  assert.equal(
    resolveNewChatCwd({ cwd: '/repo/droid-control', workspaceKind: 'folder' }, { cwd: '' }),
    '/repo/droid-control',
  );
  // Active workspace wins over a stale non-empty draft path.
  assert.equal(
    resolveNewChatCwd(
      { cwd: '/repo/droid-control', workspaceKind: 'folder' },
      { cwd: '/repo/stale' },
    ),
    '/repo/droid-control',
  );
});

test('resolveNewChatCwd starts folder-less when the active chat has no workspace', () => {
  // Empty cwd must not fall through to a leftover draft workspace path.
  assert.equal(resolveNewChatCwd({ cwd: '', workspaceKind: 'none' }, { cwd: '/repo/stale' }), '');
  assert.equal(resolveNewChatCwd({ cwd: '', workspaceKind: 'none' }, null), '');
  // Missing cwd on an active session still means "no workspace".
  assert.equal(resolveNewChatCwd({ workspaceKind: 'none' }, { cwd: '/repo/stale' }), '');
  assert.equal(resolveNewChatCwd({ cwd: null }, { cwd: '/repo/stale' }), '');
});

test('resolveNewChatCwd falls back to draft only when nothing is selected', () => {
  assert.equal(resolveNewChatCwd(null, { cwd: '/repo/draft' }), '/repo/draft');
  assert.equal(resolveNewChatCwd(undefined, { cwd: '' }), '');
  assert.equal(resolveNewChatCwd(null, null), '');
});

test('buildWorkspaceSections includes every known session for explicitly added workspaces', () => {
  const sessions = [
    session('plain-chat', '', 100),
    session('other-workspace', '/repo/other', 200),
    ...Array.from({ length: SIDEBAR_VISIBLE_SESSION_LIMIT + 2 }, (_, i) =>
      session(`repo-${i}`, '/repo/app', i + 1),
    ),
  ];

  const sections = buildWorkspaceSections(['/repo/app'], sessions);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].cwd, '/repo/app');
  assert.deepEqual(
    sections[0].sessions.map((item) => item.appSessionId),
    ['repo-6', 'repo-5', 'repo-4', 'repo-3', 'repo-2', 'repo-1', 'repo-0'],
  );
});

test('buildWorkspaceSections can still cap an explicit bootstrap list', () => {
  const sessions = Array.from({ length: SIDEBAR_VISIBLE_SESSION_LIMIT + 2 }, (_, i) =>
    session(`repo-${i}`, '/repo/app', i + 1),
  );

  const sections = buildWorkspaceSections(['/repo/app'], sessions, SIDEBAR_VISIBLE_SESSION_LIMIT);

  assert.deepEqual(
    sections[0].sessions.map((item) => item.appSessionId),
    ['repo-6', 'repo-5', 'repo-4', 'repo-3', 'repo-2'],
  );
});

test('buildWorkspaceSections keeps nested worktree sessions under the repository workspace', () => {
  const sections = buildWorkspaceSections(
    ['/repo/app/.worktrees/feature-a', '/repo/app', '/repo/app/packages/ui'],
    [
      session('main', '/repo/app', 1),
      session('worktree', '/repo/app/.worktrees/feature-a', 3),
      session('nested-workspace', '/repo/app/packages/ui', 2),
    ],
  );

  assert.deepEqual(
    sections[0].sessions.map((item) => item.appSessionId),
    ['worktree', 'main'],
  );
  assert.deepEqual(
    sections[1].sessions.map((item) => item.appSessionId),
    ['nested-workspace'],
  );
  assert.equal(sections.length, 2);
  assert.equal(sections[0].cwd, '/repo/app');
});
