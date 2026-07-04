import { useStore } from '../../hooks/useStore';
import { useDesignStore } from '../../hooks/useDesignStore';
import { createMission, newClientRef, sendToMission } from '../../lib/commands';

/**
 * The project's design session — a normal chat (interactionMode 'auto', never
 * the mission orchestrator, so Mission Control never surfaces), keyed by cwd.
 * The first send creates it (the text becomes its goal); later sends continue it.
 * Its transcript streams back through the main store, so the studio can render it.
 */
export function useDesignSession(cwd: string) {
  const { state } = useStore();
  const { design, designDispatch } = useDesignStore();
  const sessionId = design.sessions[cwd] || null;
  const transcript = sessionId ? (state.transcripts[sessionId] ?? []) : [];

  const send = (text: string, modelId?: string) => {
    if (!text.trim()) return;
    if (sessionId) {
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
    });
  };

  return { sessionId, transcript, send };
}
