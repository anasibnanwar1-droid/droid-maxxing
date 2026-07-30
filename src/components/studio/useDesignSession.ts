import { useEffect, useRef } from 'react';
import { useStore } from '../../hooks/useStore';
import { useDesignStore } from '../../hooks/useDesignStore';
import {
  createSession,
  loadSessionHistory,
  newClientRef,
  resumeSession,
  sendToSession,
  sendToSessionNow,
  updateAgentSettings,
} from '../../lib/commands';
import type {
  BrowserTranscriptReference,
  ReasoningEffort,
  SessionSummary,
  TranscriptEvent,
} from '../../types/bridge';
import { markGitTurnStart } from '../../lib/git';
import { createLocalDesignTranscriptEvent, newQueueId } from '../../lib/promptQueue';
import {
  createQueuedStudioPrompt,
  pendingStudioClientRef,
  shouldDeliverStudioQueue,
  studioSessionTitle,
} from './studioSession';

interface DesignSessionSendOptions {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  displayText?: string;
  browserRefs?: BrowserTranscriptReference[];
  mode?: 'queue' | 'now';
}

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
  const isLive = !!session?.streaming;
  const promptQueueRef = useRef<Partial<typeof state.promptQueue>>(state.promptQueue);
  promptQueueRef.current = state.promptQueue;
  const previousLiveRef = useRef<{ appSessionId: string | null; live: boolean }>({
    appSessionId: null,
    live: false,
  });
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
            browserRefs: pendingCompose.browserRefs,
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
    resumeSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    if (state.historyLoaded[sessionId]) return;
    const existing = state.transcripts[sessionId] as TranscriptEvent[] | undefined;
    if ((existing?.length ?? 0) > 0) return;
    loadSessionHistory(sessionId);
  }, [sessionId, state.historyLoaded, state.transcripts]);

  useEffect(() => {
    const previous = previousLiveRef.current;
    const current = { appSessionId: sessionId, live: isLive };
    previousLiveRef.current = current;
    if (!shouldDeliverStudioQueue(previous, current) || !sessionId) return;

    const deliverQueuedPrompt = async () => {
      if (cwd) await markGitTurnStart(cwd, sessionId);
      const head = promptQueueRef.current[sessionId]?.at(0);
      if (!head?.studio) return;
      try {
        sendToSession(sessionId, head.studio.prompt);
      } catch (error) {
        console.error('[useDesignSession] queued Studio send failed:', error);
        return;
      }
      dispatch({
        type: 'SESSION_TRANSCRIPT',
        event: createLocalDesignTranscriptEvent(
          sessionId,
          head.text,
          head.studio.browserRefs ?? [],
        ),
      });
      dispatch({ type: 'REMOVE_QUEUED_PROMPT', appSessionId: sessionId, id: head.id });
    };

    void deliverQueuedPrompt();
  }, [cwd, dispatch, isLive, sessionId]);

  const echoUser = (
    appSessionId: string,
    text: string,
    browserRefs?: BrowserTranscriptReference[],
    steered = false,
  ) => {
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
        browserRefs,
        steered,
      },
    });
  };

  const send = (text: string, options: DesignSessionSendOptions = {}) => {
    const { modelId, reasoningEffort, displayText = text, browserRefs, mode = 'queue' } = options;
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
      if (isLive && mode === 'queue') {
        dispatch({
          type: 'QUEUE_PROMPT',
          appSessionId: sessionId,
          prompt: createQueuedStudioPrompt({
            id: newQueueId(),
            displayText,
            prompt: text,
            browserRefs,
          }),
        });
        return;
      }
      echoUser(sessionId, displayText, browserRefs, mode === 'now');
      sendDesignCommand(sessionId, text, mode);
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
      browserRefs,
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

function sendDesignCommand(appSessionId: string, text: string, mode: 'queue' | 'now'): void {
  if (mode === 'now') sendToSessionNow(appSessionId, text);
  else sendToSession(appSessionId, text);
}
