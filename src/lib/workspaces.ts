import type { MissionSummary } from '../types/bridge';

export const WORKSPACE_BOOTSTRAP_SESSION_LIMIT = 5;

export interface WorkspaceSection {
  cwd: string;
  name: string;
  sessions: MissionSummary[];
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

export function buildWorkspaceSections(
  workspaceCwds: string[],
  missions: MissionSummary[],
  limit?: number,
): WorkspaceSection[] {
  const seen = new Set<string>();
  return workspaceCwds
    .filter((cwd) => {
      if (!cwd || seen.has(cwd)) return false;
      seen.add(cwd);
      return true;
    })
    .map((cwd) => ({
      cwd,
      name: workspaceName(cwd),
      sessions: maybeLimit(missions
        .filter((mission) => mission.cwd === cwd)
        .sort((a, b) => b.updatedAt - a.updatedAt), limit),
    }));
}

function maybeLimit<T>(items: T[], limit?: number): T[] {
  return limit === undefined ? items : items.slice(0, Math.max(0, limit));
}
