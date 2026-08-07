import type { SessionSummary } from '../types/bridge';
import type { GitWorktree } from '../types/vcs';
import { isWorktreeInUse } from './git';
import { sessionIsLive } from './sessions';

export function linkedSessionsForWorktree(
  path: string | null,
  worktrees: GitWorktree[],
  sessions: SessionSummary[],
): SessionSummary[] {
  if (!path) return [];
  const worktreesByDepth = worktrees
    .filter((worktree) => worktree.path)
    .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0));
  return sessions
    .filter((session) => {
      const owner = worktreesByDepth.find(
        (worktree) => worktree.path && isWorktreeInUse(worktree.path, [session.cwd]),
      );
      return owner?.path === path;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function uniqueWorktreeRepositories(
  candidates: { cwd: string; worktrees: GitWorktree[] }[],
): { root: string; worktrees: GitWorktree[] }[] {
  const roots = new Set<string>();
  const repositories: { root: string; worktrees: GitWorktree[] }[] = [];
  for (const candidate of candidates) {
    const main = candidate.worktrees.find((worktree) => worktree.isMain);
    const root = main?.path ?? candidate.worktrees.at(0)?.path ?? candidate.cwd;
    if (!root || roots.has(root)) continue;
    roots.add(root);
    repositories.push({ root, worktrees: candidate.worktrees });
  }
  return repositories;
}

export function worktreeChatStatus(
  session: SessionSummary,
  activeAppSessionId: string | null,
): 'open' | 'working' | 'idle' {
  if (session.appSessionId === activeAppSessionId) return 'open';
  if (sessionIsLive(session)) return 'working';
  return 'idle';
}
