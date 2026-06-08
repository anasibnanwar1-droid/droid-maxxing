import type { MissionSummary } from './protocol.js';

export interface MissionListFilterOptions {
  workspaceCwds?: string[];
  includePlainChats?: boolean;
  limitPerWorkspace?: number;
}

export function filterMissionListSummaries(
  summaries: MissionSummary[],
  options: MissionListFilterOptions = {},
): MissionSummary[] {
  if (!options.workspaceCwds && !options.includePlainChats) return summaries;

  const workspaceCwds = [...new Set((options.workspaceCwds ?? []).filter(Boolean))];
  if (workspaceCwds.length === 0 && !options.includePlainChats) return [];

  const limit = options.limitPerWorkspace === undefined
    ? undefined
    : Math.max(1, Math.min(options.limitPerWorkspace, 50));
  const requested = new Set(workspaceCwds);
  const grouped = new Map<string, MissionSummary[]>();
  const plain: MissionSummary[] = [];

  for (const summary of summaries) {
    if (!summary.cwd) {
      if (options.includePlainChats) plain.push(summary);
      continue;
    }
    if (!requested.has(summary.cwd)) continue;
    const group = grouped.get(summary.cwd) ?? [];
    group.push(summary);
    grouped.set(summary.cwd, group);
  }

  return [
    ...limitRows(plain.sort((a, b) => b.updatedAt - a.updatedAt), limit),
    ...workspaceCwds
      .flatMap((cwd) => limitRows((grouped.get(cwd) ?? []).sort((a, b) => b.updatedAt - a.updatedAt), limit)),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function limitRows<T>(rows: T[], limit?: number): T[] {
  return limit === undefined ? rows : rows.slice(0, limit);
}
