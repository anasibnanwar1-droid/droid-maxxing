import { missionIsLive } from '../lib/missions';
import { useStore } from './useStore';

/**
 * Whether a mission is *actively generating* right now.
 *
 * The sidecar now reports an authoritative `streaming` flag that is true for the
 * whole turn (from send until the stream ends), so we no longer have to guess
 * from transcript freshness. We still respect phase for terminal/awaiting states.
 */
export function useMissionLive(missionId: string | null): boolean {
  const { state } = useStore();
  const mission = missionId ? state.missions[missionId] : null;
  return mission ? missionIsLive(mission) : false;
}
