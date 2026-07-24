// Lifecycle of the daemon's in-place auto-compaction as observed by the app:
// raise the compacting flag on the start notification, settle it on
// completion (or an idle working state, or a watchdog expiry), and drain
// whatever sends queued behind it. The MissionManager stays the owner of all
// state; this module only encodes the transitions against a narrow host view.

import { extractCompactionNotification, extractDroidWorkingState } from './normalize.js';
import {
  AUTO_COMPACTION_WATCHDOG_MS,
  type AutoCompactionWatchdogs,
} from './autoCompactionWatchdog.js';
import type { AgentRole } from './protocol.js';

interface SessionLike {
  sessionId: string;
}

export interface CompactingAgentState {
  session: SessionLike;
  agentSessionId: string;
  missionId: string;
  role: AgentRole;
  streaming: boolean;
  autoCompacting: boolean;
  pendingSends: string[];
  closeWhenIdle?: boolean;
}

export interface CompactingMissionState<A extends CompactingAgentState> {
  summary: { id: string; autoCompactions?: number };
  streaming: boolean;
  compacting?: boolean;
  autoCompacting: boolean;
  pendingSends: string[];
  agents: Map<string, A>;
}

// The slice of MissionManager the transitions need. Orchestrator state lives
// on the mission itself (keyed by the mission id); worker state lives on the
// agent (keyed by the agents-map id, which is also the watchdog key).
export interface AutoCompactionHost<
  A extends CompactingAgentState,
  M extends CompactingMissionState<A>,
  S extends SessionLike,
> {
  watchdogs: AutoCompactionWatchdogs;
  missions(): Iterable<M>;
  findMission(missionId: string): M | undefined;
  agentCompactions: Map<string, number>;
  emitCompactionStatus(
    missionId: string,
    text: string,
    agentSessionId: string,
    role: AgentRole,
  ): void;
  patchSummary(
    missionId: string,
    patch: {
      contextTokens?: number;
      contextAccuracy?: undefined;
      autoCompactions?: number;
      queuedSends?: number;
    },
  ): void;
  refreshContext(sessionId: string, session: S): Promise<void>;
  drive(missionId: string, text: string): Promise<void>;
  driveAgent(agent: A, text: string): Promise<void>;
  closeAgent(missionId: string, agentSessionId: string): Promise<void>;
  emitAgentPaused(agent: A): void;
}

// Returns true when the notification belonged to the compaction lifecycle and
// must not be normalized as ordinary session output.
export function handleCompactionNotification<
  A extends CompactingAgentState,
  M extends CompactingMissionState<A>,
  S extends SessionLike,
>(
  host: AutoCompactionHost<A, M, S>,
  missionId: string,
  agentSessionId: string,
  role: AgentRole,
  session: S,
  note: Record<string, unknown>,
): boolean {
  const compaction = extractCompactionNotification(note);
  if (!compaction) {
    // Safety net for a session_compacted that never arrives: only a report
    // of the daemon going idle settles the flag. Intermediate states such as
    // generating/thinking can surface mid-compaction, and settling on those
    // would drain a queued send into a session still being compacted.
    const state = extractDroidWorkingState(note);
    if (state === 'idle') setAutoCompacting(host, missionId, agentSessionId, role, false);
    return false;
  }
  if (compaction.kind === 'started') {
    setAutoCompacting(host, missionId, agentSessionId, role, true);
    host.emitCompactionStatus(missionId, 'Compacting conversation...', agentSessionId, role);
    return true;
  }
  // A completion without a matching in-flight start is a late/duplicate
  // note (typically the daemon echoing a manual compactSession after
  // runCompaction already reported it); acting on it would double-count the
  // compaction and emit a duplicate status.
  const mission = host.findMission(missionId);
  const active =
    agentSessionId === missionId
      ? mission?.autoCompacting
      : mission?.agents.get(agentSessionId)?.autoCompacting;
  if (!active) return true;
  setAutoCompacting(host, missionId, agentSessionId, role, false);
  host.emitCompactionStatus(missionId, 'Compaction complete.', agentSessionId, role);
  // In-place compaction keeps the session id, so the meter's ratchet only
  // resets when the generation counter moves; also drop the pre-compaction
  // exact reading so the refreshed estimate is not overridden by stale usage.
  if (agentSessionId === missionId) {
    if (mission) {
      host.patchSummary(missionId, {
        contextTokens: 0,
        contextAccuracy: undefined,
        autoCompactions: (mission.summary.autoCompactions ?? 0) + 1,
      });
    }
  } else {
    // Worker in-place compaction: the ratchet reset travels on the worker's
    // own context snapshots instead of the mission summary.
    host.agentCompactions.set(agentSessionId, (host.agentCompactions.get(agentSessionId) ?? 0) + 1);
  }
  void host.refreshContext(agentSessionId, session).catch(() => {});
  return true;
}

export function onAutoCompactionWatchdogExpired<
  A extends CompactingAgentState,
  M extends CompactingMissionState<A>,
  S extends SessionLike,
>(host: AutoCompactionHost<A, M, S>, sessionKey: string): void {
  const mission = host.findMission(sessionKey);
  if (mission?.autoCompacting) {
    console.warn(`[compaction] watchdog settled a stale auto-compaction on ${sessionKey}`);
    setAutoCompacting(host, mission.summary.id, mission.summary.id, 'orchestrator', false);
    return;
  }
  for (const owner of host.missions()) {
    const agent = owner.agents.get(sessionKey);
    if (agent?.autoCompacting) {
      console.warn(`[compaction] watchdog settled a stale auto-compaction on ${sessionKey}`);
      setAutoCompacting(host, owner.summary.id, sessionKey, agent.role, false);
      return;
    }
  }
}

function setAutoCompacting<
  A extends CompactingAgentState,
  M extends CompactingMissionState<A>,
  S extends SessionLike,
>(
  host: AutoCompactionHost<A, M, S>,
  missionId: string,
  agentSessionId: string,
  role: AgentRole,
  active: boolean,
): void {
  const mission = host.findMission(missionId);
  if (!mission) return;
  if (role === 'orchestrator') {
    const wasActive = mission.autoCompacting;
    mission.autoCompacting = active;
    if (active) host.watchdogs.arm(mission.summary.id, AUTO_COMPACTION_WATCHDOG_MS);
    else host.watchdogs.clear(mission.summary.id);
    if (active || !wasActive || mission.streaming || mission.compacting) return;
    const next = mission.pendingSends.shift();
    host.patchSummary(mission.summary.id, { queuedSends: mission.pendingSends.length });
    if (next !== undefined) void host.drive(mission.summary.id, next);
    return;
  }

  const agent = mission.agents.get(agentSessionId);
  if (!agent) return;
  const wasActive = agent.autoCompacting;
  agent.autoCompacting = active;
  if (active) host.watchdogs.arm(agentSessionId, AUTO_COMPACTION_WATCHDOG_MS);
  else host.watchdogs.clear(agentSessionId);
  if (active || !wasActive || agent.streaming) return;
  if (agent.pendingSends.length === 0 && agent.closeWhenIdle) {
    // closeAgent looks the worker up by the agents-map id, which is not
    // guaranteed to match the live session id.
    void host.closeAgent(agent.missionId, agent.agentSessionId);
    return;
  }
  const next = agent.pendingSends.shift();
  if (next !== undefined) void host.driveAgent(agent, next);
  else host.emitAgentPaused(agent);
}
