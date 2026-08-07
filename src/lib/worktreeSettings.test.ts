import assert from 'node:assert';
import test from 'node:test';
import type { SessionSummary } from '../types/bridge';
import type { GitWorktree } from '../types/vcs';
import {
  linkedSessionsForWorktree,
  uniqueWorktreeRepositories,
  worktreeChatStatus,
} from './worktreeSettings';

function session(
  appSessionId: string,
  cwd: string,
  overrides: Partial<Pick<SessionSummary, 'phase' | 'streaming' | 'updatedAt'>> = {},
): SessionSummary {
  return {
    appSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: '',
    cwd,
    autonomy: 'low',
    phase: overrides.phase ?? 'completed',
    streaming: overrides.streaming,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 1,
  };
}

function worktree(path: string, isMain = false): GitWorktree {
  return {
    path,
    head: null,
    branch: null,
    bare: false,
    detached: false,
    locked: false,
    isMain,
    isCurrent: false,
  };
}

test('uniqueWorktreeRepositories groups duplicate workspace entries under the main checkout', () => {
  const repositoryWorktrees = [worktree('/repo', true), worktree('/repo/.worktrees/feature')];
  const grouped = uniqueWorktreeRepositories([
    { cwd: '/repo', worktrees: repositoryWorktrees },
    { cwd: '/repo/.worktrees/feature', worktrees: repositoryWorktrees },
    { cwd: '/other', worktrees: [worktree('/other', true), worktree('/other/wt')] },
  ]);

  assert.deepEqual(
    grouped.map((repository) => repository.root),
    ['/repo', '/other'],
  );
});

test('linkedSessionsForWorktree matches exact and nested chat paths without prefix collisions', () => {
  const linked = linkedSessionsForWorktree('/repo/.worktrees/feature', [
    session('exact', '/repo/.worktrees/feature', { updatedAt: 2 }),
    session('nested', '/repo/.worktrees/feature/packages/app', { updatedAt: 3 }),
    session('prefix', '/repo/.worktrees/feature-old', { updatedAt: 4 }),
    session('main', '/repo', { updatedAt: 5 }),
  ]);

  assert.deepEqual(
    linked.map((candidate) => candidate.appSessionId),
    ['nested', 'exact'],
  );
});

test('worktreeChatStatus distinguishes the open chat, background work, and idle history', () => {
  assert.equal(worktreeChatStatus(session('open', '/repo'), 'open'), 'open');
  assert.equal(
    worktreeChatStatus(session('working', '/repo', { phase: 'orchestrator_turn' }), null),
    'working',
  );
  assert.equal(worktreeChatStatus(session('idle', '/repo', { phase: 'completed' }), null), 'idle');
});
