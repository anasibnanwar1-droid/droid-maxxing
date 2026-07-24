import type { MissionSummary, WorkerSummary } from '../types/bridge';

// Phases where the mission is waiting on the user (or finished) — never "working".
const INACTIVE = ['paused', 'completed', 'failed', 'awaiting_plan_approval', 'awaiting_run_start'];
// Phases that unambiguously mean a turn is in flight, used as a fallback for the
// brief window before the backend reports `streaming` over the bridge.
const CLEARLY_ACTIVE = ['planning', 'initializing', 'orchestrator_turn'];

// Whether a mission is *actively generating* right now. Pure counterpart of the
// useMissionLive hook so non-React code can reuse the same rule.
export function missionIsLive(mission: Pick<MissionSummary, 'phase' | 'streaming'>): boolean {
  if (INACTIVE.includes(mission.phase)) return false;
  if (mission.streaming) return true;
  return CLEARLY_ACTIVE.includes(mission.phase);
}

// The cwds of sessions that genuinely occupy a directory right now: the open
// draft, the active chat, any mission with a live turn, and any mission with a
// still-running worker (subagents run in the mission's cwd, so they pin it even
// when the orchestrator itself is idle). Historical/idle chats are excluded so
// cleaning up their old worktrees stays possible.
export function activeSessionCwds(opts: {
  missions: MissionSummary[];
  activeMissionId: string | null;
  draftCwd?: string | null;
  workers?: Record<string, Pick<WorkerSummary, 'status'>[]>;
  pinnedCwds?: Iterable<string>;
}): string[] {
  const cwds: string[] = [];
  if (opts.draftCwd) cwds.push(opts.draftCwd);
  if (opts.pinnedCwds) {
    for (const cwd of opts.pinnedCwds) if (cwd) cwds.push(cwd);
  }
  for (const m of opts.missions) {
    if (!m.cwd) continue;
    const hasRunningWorker = (opts.workers?.[m.id] ?? []).some((w) => w.status === 'running');
    if (m.id === opts.activeMissionId || missionIsLive(m) || hasRunningWorker) cwds.push(m.cwd);
  }
  return cwds;
}
