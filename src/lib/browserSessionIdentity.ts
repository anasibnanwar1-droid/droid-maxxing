import type { BrowserNativeRequest, MissionSummary } from '../types/bridge';

export function browserKeyForMission(mission: MissionSummary | undefined): string | undefined {
  if (!mission) return undefined;
  // The backend keys browser sessions by the stable app session id, which never
  // changes (compaction swaps mission.sessionId, but the browser key must not).
  return mission.id;
}

export function activeMissionAfterNativeBrowserRequest(
  activeMissionId: string | null,
  request: BrowserNativeRequest,
  missions: Record<string, MissionSummary> = {},
): string | null {
  return activeMissionId ?? missionIdForBrowserKey(missions, request.missionId);
}

export function missionIdForBrowserKey(missions: Record<string, MissionSummary>, browserKey: string): string {
  return Object.values(missions).find((mission) => browserKeyForMission(mission) === browserKey)?.id ?? browserKey;
}

export function nativeBrowserRequestTargetsVisibleSurface(input: {
  browserKey: string;
  visibleSessionId?: string;
  requestMissionId: string;
  requestSessionId: string;
}): boolean {
  return input.browserKey === input.requestMissionId || input.visibleSessionId === input.requestSessionId;
}
