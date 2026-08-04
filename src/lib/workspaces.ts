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

export function workspaceName(cwd: string): string {
  const base = cwd.split('/').filter(Boolean).pop();
  return base ?? 'Home';
}

// Sidebar "New chat" workspace context. When a top-level session is active it
// owns the next draft: workspace chats keep that folder, folder-less Chats
// (workspaceKind none / empty cwd) stay folder-less even if draftChat still
// holds a stale path. Draft cwd is only used when nothing is selected.
export function resolveNewChatCwd(
  activeSession: { cwd?: string | null; workspaceKind?: 'folder' | 'none' } | null | undefined,
  draftChat: { cwd?: string | null } | null | undefined,
): string {
  if (activeSession) {
    if (activeSession.workspaceKind === 'none') return '';
    return typeof activeSession.cwd === 'string' ? activeSession.cwd.trim() : '';
  }
  return typeof draftChat?.cwd === 'string' ? draftChat.cwd.trim() : '';
}

export function addWorkspaceCwd(existing: string[], cwd: string): string[] {
  const next = cwd.trim();
  if (!next) return existing;
  return [next, ...existing.filter((item) => item !== next)];
}

function repositoryWorkspaceCwd(cwd: string): string {
  const marker = /[\\/]\.worktrees[\\/]/.exec(cwd);
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
