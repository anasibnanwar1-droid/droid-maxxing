import { useEffect } from 'react';
import { useStore } from '../../hooks/useStore';
import { useDesignStore } from '../../hooks/useDesignStore';
import {
  createMission,
  loadMissionHistory,
  newClientRef,
  sendToMission,
  updateAgentSettings,
} from '../../lib/commands';
import type { ReasoningEffort } from '../../types/bridge';

/**
 * The project's design session — a normal chat (interactionMode 'auto', never
 * the mission orchestrator). Sessions are keyed by `sessionKey` (the live project
 * path) even when the agent process runs in an isolated worktree at `cwd`.
 *
 * Empty string in design.sessions[key] means the user explicitly started a new
 * thread — do not re-adopt the main-window active chat.
 */
export function useDesignSession(cwd: string, sessionKey?: string) {
  const { state, dispatch } = useStore();
  const { design, designDispatch } = useDesignStore();
  const key = sessionKey || cwd;
  const mapped = design.sessions[key] ?? design.sessions[cwd];
  // '' = intentional new thread; missing key = not decided yet; id = active thread.
  const intentionalNew = design.sessions[key] === '' || design.sessions[cwd] === '';
  const sessionId = intentionalNew ? null : mapped || null;
  const hasMapping = key in design.sessions || cwd in design.sessions;
  const transcript = sessionId ? (state.transcripts[sessionId] ?? []) : [];
  const mission = sessionId ? state.missions[sessionId] : null;

  // Auto-adopt only when we have never set a session for this project (first open).
  // After New thread (sessions[key] === '') or an explicit switch, leave it alone.
  useEffect(() => {
    if (!cwd || hasMapping) return;
    const activeId = state.activeMissionId;
    if (!activeId) return;
    const active = state.missions[activeId];
    if (!active) return;
    if (active.kind === 'mission_orchestrator') return;
    const matches =
      active.cwd === cwd ||
      active.cwd === key ||
      Object.values(design.workspaces).some(
        (ws) =>
          (ws.liveCwd === key || ws.liveCwd === cwd || ws.path === cwd) &&
          (active.cwd === ws.liveCwd || active.cwd === ws.path),
      );
    if (!matches) return;
    designDispatch({ type: 'ADOPT_SESSION', cwd: key, missionId: activeId });
  }, [
    cwd,
    key,
    hasMapping,
    state.activeMissionId,
    state.missions,
    design.workspaces,
    designDispatch,
  ]);

  useEffect(() => {
    if (!sessionId) return;
    if (state.historyLoaded[sessionId]) return;
    if ((state.transcripts[sessionId]?.length ?? 0) > 0) return;
    loadMissionHistory(sessionId);
  }, [sessionId, state.historyLoaded, state.transcripts]);

  const echoUser = (missionId: string, text: string) => {
    // Optimistic local bubble so the prompt is visible immediately — same pattern
    // as PromptInput. Without this, design sends only appear after the sidecar
    // stream (or not at all if history/seed races).
    dispatch({
      type: 'MISSION_TRANSCRIPT',
      event: {
        id: `local-${Date.now()}`,
        missionId,
        agentSessionId: 'user',
        role: 'orchestrator',
        ts: Date.now(),
        kind: 'text',
        text,
        author: 'user',
      },
    });
  };

  const send = (text: string, modelId?: string, reasoningEffort?: ReasoningEffort) => {
    if (!text.trim()) return;
    if (sessionId) {
      if (modelId !== undefined || reasoningEffort !== undefined) {
        updateAgentSettings({
          missionId: sessionId,
          agent: 'orchestrator',
          modelId: modelId ?? null,
          reasoningEffort,
        });
      }
      echoUser(sessionId, text);
      sendToMission(sessionId, text);
      return;
    }
    const clientRef = newClientRef();
    // Seed the first user bubble via pendingCompose so MISSION_CREATED shows it
    // even before the stream starts (mirrors normal chat create path).
    dispatch({
      type: 'SET_PENDING_COMPOSE',
      clientRef,
      text,
      skills: [],
      files: [],
    });
    designDispatch({ type: 'EXPECT_SESSION', clientRef, cwd: key });
    createMission({
      clientRef,
      cwd,
      title: 'Design',
      goal: text,
      interactionMode: 'auto',
      // High autonomy so design turns don't stop for tool/MCP permission prompts.
      autonomy: 'high',
      modelId,
      reasoningEffort,
    });
  };

  const setModel = (modelId?: string, reasoningEffort?: ReasoningEffort) => {
    if (!sessionId) return;
    updateAgentSettings({
      missionId: sessionId,
      agent: 'orchestrator',
      modelId: modelId ?? null,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
  };

  return {
    sessionId,
    transcript,
    send,
    setModel,
    modelId: mission?.modelId,
    reasoningEffort: mission?.reasoningEffort,
  };
}
