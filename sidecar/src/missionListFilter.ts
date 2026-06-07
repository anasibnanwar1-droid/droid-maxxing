import type { MissionSummary } from './protocol.js';

const DEFAULT_LIMIT_PER_WORKSPACE = 5;

export interface MissionListFilterOptions {
  workspaceCwds?: string[];
  limitPerWorkspace?: number;
}

export function filterMissionListSummaries(
  summaries: MissionSummary[],
  options: MissionListFilterOptions = {},
): MissionSummary[] {
  if (!options.workspaceCwds) return summaries;

  const workspaceCwds = [...new Set(options.workspaceCwds.filter(Boolean))];
  if (workspaceCwds.length === 0) return [];

  const limit = Math.max(1, Math.min(options.limitPerWorkspace ?? DEFAULT_LIMIT_PER_WORKSPACE, 50));
  const requested = new Set(workspaceCwds);
  const grouped = new Map<string, MissionSummary[]>();

  for (const summary of summaries) {
    if (!requested.has(summary.cwd)) continue;
    const group = grouped.get(summary.cwd) ?? [];
    group.push(summary);
    grouped.set(summary.cwd, group);
  }

  return workspaceCwds
    .flatMap((cwd) => (grouped.get(cwd) ?? []).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
