import type { MissionSummary } from './protocol.js';

export interface MissionListFilterOptions {
  workspaceCwds?: string[];
  includePlainChats?: boolean;
  limitPerWorkspace?: number;
}

// Subagents (Task workers / mission workers and validators) are spawned by a
// parent session and must never appear as standalone sidebar sessions.
export function isSubagentSummary(summary: MissionSummary): boolean {
  return (
    summary.role === 'worker' ||
    summary.role === 'validator' ||
    summary.kind === 'mission_worker' ||
    summary.kind === 'mission_validator' ||
    !!summary.parentSessionId
  );
}

export function filterMissionListSummaries(
  summaries: MissionSummary[],
  options: MissionListFilterOptions = {},
): MissionSummary[] {
  const visible = summaries.filter((summary) => !isSubagentSummary(summary));
  if (!options.workspaceCwds && !options.includePlainChats) return visible;

  const workspaceCwds = [...new Set((options.workspaceCwds ?? []).filter(Boolean))];
  if (workspaceCwds.length === 0 && !options.includePlainChats) return [];

  // An explicit limit caps each workspace (used for bootstrap-style loads);
  // when omitted, every known session for the requested workspaces is returned
  // so the sidebar can reveal them on demand.
  const limit = options.limitPerWorkspace === undefined
    ? undefined
    : Math.max(1, Math.min(options.limitPerWorkspace, 50));
  const requested = new Set(workspaceCwds);
  const grouped = new Map<string, MissionSummary[]>();
  const plain: MissionSummary[] = [];

  for (const summary of visible) {
    if (!summary.cwd) {
      if (options.includePlainChats) plain.push(summary);
      continue;
    }
    if (!requested.has(summary.cwd)) continue;
    const group = grouped.get(summary.cwd) ?? [];
    group.push(summary);
    grouped.set(summary.cwd, group);
  }

  const capped = <T>(items: T[]): T[] => (limit === undefined ? items : items.slice(0, limit));

  return [
    ...capped(plain.sort((a, b) => b.updatedAt - a.updatedAt)),
    ...workspaceCwds
      .flatMap((cwd) => capped((grouped.get(cwd) ?? []).sort((a, b) => b.updatedAt - a.updatedAt))),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
