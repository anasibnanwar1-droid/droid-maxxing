import type { SessionSummary } from './protocol.js';

export interface SessionListFilterOptions {
  workspaceCwds?: string[];
  includePlainChats?: boolean;
  limitPerWorkspace?: number;
}

// Task workers plus Mission Control workers and validators are child sessions.
// They never appear as standalone sidebar sessions.
export function isChildSessionSummary(summary: SessionSummary): boolean {
  return (
    summary.role === 'worker' || summary.role === 'validator' || !!summary.parentProviderSessionId
  );
}

export function filterSessionListSummaries(
  summaries: SessionSummary[],
  options: SessionListFilterOptions = {},
): SessionSummary[] {
  const visible = summaries.filter((summary) => !isChildSessionSummary(summary));
  if (!options.workspaceCwds && !options.includePlainChats) return visible;

  const workspaceCwds = [...new Set((options.workspaceCwds ?? []).filter(Boolean))];
  if (workspaceCwds.length === 0 && !options.includePlainChats) return [];

  // An explicit limit caps each workspace (used for bootstrap-style loads);
  // when omitted, every known session for the requested workspaces is returned
  // so the sidebar can reveal them on demand.
  const limit =
    options.limitPerWorkspace === undefined
      ? undefined
      : Math.max(1, Math.min(options.limitPerWorkspace, 50));
  const requested = new Set(workspaceCwds);
  const grouped = new Map<string, SessionSummary[]>();
  const plain: SessionSummary[] = [];

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
    ...workspaceCwds.flatMap((cwd) =>
      capped((grouped.get(cwd) ?? []).sort((a, b) => b.updatedAt - a.updatedAt)),
    ),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
}
