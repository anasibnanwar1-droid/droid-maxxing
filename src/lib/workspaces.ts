import type { SessionSummary } from '../types/bridge';

// How many sessions a sidebar section shows before collapsing the rest behind
// a "Show more" control. This is a display default, not a hard cap: every
// loaded session stays available.
export const SIDEBAR_VISIBLE_SESSION_LIMIT = 5;

export interface WorkspaceSection {
  cwd: string;
  name: string;
  sessions: SessionSummary[];
}

// Child sessions (workers, validators, and Task-tool children) are
// never standalone conversations, so they must not appear in the sidebar.
export function isChildSession(summary: SessionSummary): boolean {
  return (
    summary.role === 'worker' || summary.role === 'validator' || !!summary.parentProviderSessionId
  );
}

export function workspaceName(cwd: string): string {
  const base = cwd.split('/').filter(Boolean).pop();
  return base || 'Home';
}

export function addWorkspaceCwd(existing: string[], cwd: string): string[] {
  const next = cwd.trim();
  if (!next) return existing;
  return [next, ...existing.filter((item) => item !== next)];
}

function repositoryWorkspaceCwd(cwd: string): string {
  const marker = cwd.match(/[\\/]\.worktrees[\\/]/);
  return marker ? cwd.slice(0, marker.index) : cwd;
}

export function buildWorkspaceSections(
  workspaceCwds: string[],
  sessions: SessionSummary[],
  limit?: number,
): WorkspaceSection[] {
  const seen = new Set<string>();
  const workspaces = workspaceCwds.map(repositoryWorkspaceCwd).filter((cwd) => {
    if (!cwd || seen.has(cwd)) return false;
    seen.add(cwd);
    return true;
  });
  const ownerFor = (sessionCwd: string) => {
    const normalizedSessionCwd = sessionCwd.replace(/\\/g, '/');
    return workspaces
      .filter((cwd) => {
        const normalizedCwd = cwd.replace(/\\/g, '/');
        return (
          normalizedSessionCwd === normalizedCwd ||
          normalizedSessionCwd.startsWith(`${normalizedCwd}/`)
        );
      })
      .sort((a, b) => b.length - a.length)[0];
  };

  return workspaces.map((cwd) => ({
    cwd,
    name: workspaceName(cwd),
    sessions: maybeLimit(
      sessions
        .filter((session) => ownerFor(session.cwd) === cwd)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      limit,
    ),
  }));
}

function maybeLimit<T>(items: T[], limit?: number): T[] {
  return limit === undefined ? items : items.slice(0, Math.max(0, limit));
}
