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
 * the mission orchestrator, so Mission Control never surfaces), keyed by cwd.
 * The first send creates it (the text becomes its goal); later sends continue it.
 * Its transcript streams back through the main store, so the studio can render it.
 *
 * When the studio opens with a normal chat already active for this cwd, we adopt
 * that mission as the design session so the same thread continues on the canvas.
 */
export function useDesignSession(cwd: string) {
  const { state } = useStore();
  const { design, designDispatch } = useDesignStore();
  const sessionId = design.sessions[cwd] || null;
  const transcript = sessionId ? (state.transcripts[sessionId] ?? []) : [];
  const mission = sessionId ? state.missions[sessionId] : null;

  // Adopt the active normal chat into the studio when it matches this cwd and
  // we don't already have a design session mapped.
  useEffect(() => {
    if (!cwd || sessionId) return;
    const activeId = state.activeMissionId;
    if (!activeId) return;
    const active = state.missions[activeId];
    if (!active || active.cwd !== cwd) return;
    if (active.kind === 'mission_orchestrator') return;
    designDispatch({ type: 'ADOPT_SESSION', cwd, missionId: activeId });
  }, [cwd, sessionId, state.activeMissionId, state.missions, designDispatch]);

  // Load transcript history when we adopt / reopen a session that isn't warm.
  useEffect(() => {
    if (!sessionId) return;
    if (state.historyLoaded[sessionId]) return;
    if ((state.transcripts[sessionId]?.length ?? 0) > 0) return;
    loadMissionHistory(sessionId);
  }, [sessionId, state.historyLoaded, state.transcripts]);

  const send = (text: string, modelId?: string, reasoningEffort?: ReasoningEffort) => {
    if (!text.trim()) return;
    if (sessionId) {
      // Apply model/reasoning to the live session before continuing the chat —
      // otherwise the studio picker only affects brand-new creates.
      if (modelId !== undefined || reasoningEffort !== undefined) {
        updateAgentSettings({
          missionId: sessionId,
          agent: 'orchestrator',
          modelId: modelId ?? null,
          reasoningEffort,
        });
      }
      sendToMission(sessionId, text);
      return;
    }
    const clientRef = newClientRef();
    designDispatch({ type: 'EXPECT_SESSION', clientRef, cwd });
    createMission({
      clientRef,
      cwd,
      title: 'Design',
      goal: text,
      interactionMode: 'auto',
      autonomy: 'medium',
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
      reasoningEffort,
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
