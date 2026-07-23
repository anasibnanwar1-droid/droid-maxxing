import { useStore } from '../hooks/useStore';
import ContextMeter from './ContextMeter';

// Compact context/status cluster for the prompt-input toolbar: a queued-send
// badge plus the context-usage meter (a ring; its hover tooltip carries the
// compaction count and window size, and clicking opens the full breakdown).
// Extracted from the old full-width bottom status strip so the app shell can
// stretch to the bottom edge while this stays tucked in a corner of the composer.
export default function ContextStatusCluster() {
  const { state } = useStore();
  const mission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const contextSessionId =
    state.selectedAgentSessionId && state.selectedAgentSessionId !== 'orchestrator'
      ? state.selectedAgentSessionId
      : mission?.id;
  const contextStats = contextSessionId ? state.contextStats[contextSessionId] : undefined;
  const contextMission =
    mission && contextSessionId !== mission.id && !contextStats
      ? {
          ...mission,
          contextTokens: 0,
          contextRemainingTokens: undefined,
          contextAccuracy: undefined,
          contextUpdatedAt: undefined,
          maxContextTokens: undefined,
        }
      : mission;
  if (!contextMission) return null;

  return (
    <div className="flex shrink-0 items-center gap-2">
      {mission?.queuedSends ? (
        <span className="rounded-md border border-droid-border bg-droid-elevated/70 px-1.5 py-0.5 font-mono text-[10px] text-droid-text-secondary">
          {mission.queuedSends} queued
        </span>
      ) : null}
      <ContextMeter mission={contextMission} stats={contextStats} sessionKey={contextSessionId} />
    </div>
  );
}
