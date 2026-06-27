import { useStore, type WorkerInfo } from './useStore';
import type { MissionSummary } from '../types/bridge';

// Phases where the mission is waiting on the user (or finished) — never "working".
const INACTIVE = ['paused', 'completed', 'failed', 'awaiting_plan_approval', 'awaiting_run_start'];
// Phases that unambiguously mean a turn is in flight, used as a fallback for the
// brief window before the backend reports `streaming` over the bridge.
const CLEARLY_ACTIVE = ['planning', 'initializing', 'orchestrator_turn'];

/**
 * Whether a mission is *actively generating* right now.
 *
 * The sidecar now reports an authoritative `streaming` flag that is true for the
 * whole turn (from send until the stream ends), so we no longer have to guess
 * from transcript freshness. We still respect phase for terminal/awaiting states.
 */
export function isMissionLive(
  mission: MissionSummary | null | undefined,
  workers: WorkerInfo[] = [],
): boolean {
  if (!mission) return false;
  const workerLive = workers.some((worker) => worker.status === 'running');
  if (mission.compacting || workerLive) return true;
  if (INACTIVE.includes(mission.phase)) return false;
  if (mission.streaming) return true;
  return CLEARLY_ACTIVE.includes(mission.phase);
}

export function useMissionLive(missionId: string | null): boolean {
  const { state } = useStore();
  const mission = missionId ? state.missions[missionId] : null;
  return isMissionLive(mission, missionId ? state.workers[missionId] : undefined);
}
