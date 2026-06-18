import type { MissionSummary } from '../types/bridge';

export function selectedAgentSessionIdForMission(
  mission: Pick<MissionSummary, 'kind'> | null | undefined,
  selectedAgentSessionId: string | null | undefined,
): string | null {
  if (!mission || mission.kind === 'mission_orchestrator') return null;
  if (!selectedAgentSessionId || selectedAgentSessionId === 'orchestrator') return null;
  return selectedAgentSessionId;
}

export function compactTargetSessionIdForMission(
  mission: Pick<MissionSummary, 'id' | 'kind'> | null | undefined,
  selectedAgentSessionId: string | null | undefined,
): string | null {
  if (!mission) return null;
  if (selectedAgentSessionId && selectedAgentSessionId !== 'orchestrator')
    return selectedAgentSessionId;
  return mission.id;
}
