import { useEffect } from 'react';
import { useStore } from '../../hooks/useStore';
import { useDesignStore } from '../../hooks/useDesignStore';
import {
  createSession,
  loadSessionHistory,
  newClientRef,
  sendToSession,
  updateAgentSettings,
} from '../../lib/commands';
import type { ReasoningEffort, SessionSummary, TranscriptEvent } from '../../types/bridge';
import { pendingStudioClientRef, studioSessionTitle } from './studioSession';

/**
 * The project's design session — a normal chat (interactionMode 'auto', never
 * Mission Control). Sessions are keyed by `sessionKey` (the live project
 * path) even when the agent process runs in an isolated worktree at `cwd`.
 *
 * Empty string in design.sessions[key] means the user explicitly started a new
 * thread — do not re-adopt the main-window active chat.
 */
export function useDesignSession(cwd: string, sessionKey?: string) {
  const { state, dispatch } = useStore();
  const { design, designDispatch } = useDesignStore();
  const key = sessionKey ?? cwd;
  const mapped = design.sessions[key] ?? design.sessions[cwd];
  // '' = intentional new thread; missing key = not decided yet; id = active thread.
  const intentionalNew = design.sessions[key] === '' || design.sessions[cwd] === '';
  const sessionId = intentionalNew ? null : mapped || null;
  const hasMapping = key in design.sessions || cwd in design.sessions;
  const transcript = sessionId ? (state.transcripts[sessionId] ?? []) : [];
  const session = sessionId ? state.sessions[sessionId] : null;
  const pendingClientRef = sessionId
    ? undefined
    : pendingStudioClientRef(design.expected, state.pendingCompose, [key, cwd]);
  const pendingCompose = pendingClientRef ? state.pendingCompose[pendingClientRef] : undefined;
  const isCreating = pendingCompose !== undefined;
  const visibleTranscript: TranscriptEvent[] =
    pendingCompose && pendingClientRef
      ? [
          {
            id: `pending-${pendingClientRef}`,
            appSessionId: `pending-${pendingClientRef}`,
            sourceSessionId: 'user',
            role: 'primary',
            ts: Date.now(),
            kind: 'text',
            text: pendingCompose.text,
            author: 'user',
          },
        ]
      : transcript;

  // Auto-adopt only when we have never set a session for this project (first open).
  // After New thread (sessions[key] === '') or an explicit switch, leave it alone.
  useEffect(() => {
    if (!cwd || hasMapping || isCreating) return;
    const activeId = state.activeAppSessionId;
    if (!activeId) return;
    const active = state.sessions[activeId] as SessionSummary | undefined;
    if (!active) return;
    if (active.sessionPurpose === 'mission-control') return;
    const matches =
      active.cwd === cwd ||
      active.cwd === key ||
      Object.values(design.workspaces).some(
        (ws) =>
          (ws.liveCwd === key || ws.liveCwd === cwd || ws.path === cwd) &&
          (active.cwd === ws.liveCwd || active.cwd === ws.path),
      );
    if (!matches) return;
    designDispatch({ type: 'ADOPT_SESSION', cwd: key, appSessionId: activeId });
  }, [
    cwd,
    key,
    hasMapping,
    state.activeAppSessionId,
    state.sessions,
    design.workspaces,
    designDispatch,
    isCreating,
  ]);

  useEffect(() => {
    if (!sessionId) return;
    if (state.historyLoaded[sessionId]) return;
    const existing = state.transcripts[sessionId] as TranscriptEvent[] | undefined;
    if ((existing?.length ?? 0) > 0) return;
    loadSessionHistory(sessionId);
  }, [sessionId, state.historyLoaded, state.transcripts]);

  const echoUser = (appSessionId: string, text: string) => {
    // Optimistic local bubble so the prompt is visible immediately — same pattern
    // as PromptInput. Without this, design sends only appear after the sidecar
    // stream (or not at all if history/seed races).
    dispatch({
      type: 'SESSION_TRANSCRIPT',
      event: {
        id: `local-${String(Date.now())}`,
        appSessionId,
        sourceSessionId: 'user',
        role: 'primary',
        ts: Date.now(),
        kind: 'text',
        text,
        author: 'user',
      },
    });
  };

  const send = (
    text: string,
    modelId?: string,
    reasoningEffort?: ReasoningEffort,
    displayText = text,
  ) => {
    if (!text.trim()) return;
    if (isCreating) return;
    if (sessionId) {
      // Only push settings that actually changed — pickModel already applied
      // live picks, so re-sending stale composer values here would race it.
      const changed =
        (modelId !== undefined && modelId !== session?.modelId) ||
        (reasoningEffort !== undefined && reasoningEffort !== session?.reasoningEffort);
      if (changed) {
        updateAgentSettings({
          appSessionId: sessionId,
          agent: 'primary',
          modelId: modelId ?? null,
          reasoningEffort,
        });
      }
      echoUser(sessionId, displayText);
      sendToSession(sessionId, text);
      return;
    }
    const clientRef = newClientRef();
    // Seed the first user bubble via pendingCompose so SESSION_CREATED shows it
    // even before the stream starts (mirrors normal chat create path).
    dispatch({
      type: 'SET_PENDING_COMPOSE',
      clientRef,
      text: displayText,
      skills: [],
      files: [],
    });
    designDispatch({ type: 'EXPECT_SESSION', clientRef, cwd: key });
    createSession({
      clientRef,
      cwd,
      title: studioSessionTitle(displayText),
      goal: text,
      sessionPurpose: 'design',
      interactionMode: 'auto',
      // High autonomy so design turns don't stop for tool/MCP permission prompts.
      autonomy: 'high',
      modelId,
      reasoningEffort,
    });
  };

  const setModel = (modelId?: string, reasoningEffort?: ReasoningEffort) => {
    if (!sessionId) return;
    // Optimistic dispatch first (same as the main-chat picker): the label
    // updates instantly and sessionSettingOverrides protects the pick from
    // stale session.updated/list rebroadcasts.
    dispatch({ type: 'SESSION_SET_MODEL', appSessionId: sessionId, modelId });
    if (reasoningEffort !== undefined) {
      dispatch({
        type: 'SESSION_SET_REASONING',
        appSessionId: sessionId,
        reasoning: reasoningEffort,
      });
    }
    updateAgentSettings({
      appSessionId: sessionId,
      agent: 'primary',
      modelId: modelId ?? null,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
  };

  return {
    sessionId,
    transcript: visibleTranscript,
    isCreating,
    send,
    setModel,
    modelId: session?.modelId,
    reasoningEffort: session?.reasoningEffort,
  };
}
