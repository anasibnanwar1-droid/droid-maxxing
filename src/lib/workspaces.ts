import type { MissionSummary } from '../types/bridge';

export const WORKSPACE_SESSION_LIMIT = 5;

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
  limit = WORKSPACE_SESSION_LIMIT,
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
      sessions: missions
        .filter((mission) => mission.cwd === cwd)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit),
    }));
}
