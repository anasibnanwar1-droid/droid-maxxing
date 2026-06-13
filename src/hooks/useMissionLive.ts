import { useStore } from './useStore';

// Phases where the mission is waiting on the user (or finished) — never "working".
const INACTIVE = ['paused', 'completed', 'failed', 'awaiting_plan_approval', 'awaiting_run_start'];
// Phases that unambiguously mean a turn is in flight, used as a fallback for the
// brief window before the backend reports `streaming` over the bridge.
const CLEARLY_ACTIVE = ['planning', 'initializing', 'orchestrator_turn'];

/**
 * Whether a mission is *actively generating* right now.
 *
 * The sidecar reports an authoritative `streaming` flag that is true for the
 * whole turn (from send until the stream ends). It wins over stale phase updates:
 * a paused phase received mid-stream must not make active work look completed.
 */
export function useMissionLive(missionId: string | null): boolean {
  const { state } = useStore();
  const mission = missionId ? state.missions[missionId] : null;

  if (!mission) return false;
  if (mission.streaming) return true;
  if (INACTIVE.includes(mission.phase)) return false;
  return CLEARLY_ACTIVE.includes(mission.phase);
}
