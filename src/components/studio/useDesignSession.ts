import { useEffect } from 'react';
import { useStore } from '../../hooks/useStore';
import { useDesignStore } from '../../hooks/useDesignStore';
import {
  createSession,
  loadSessionHistory,
  newClientRef,
  sendSessionPrompt,
  updateAgentSettings,
} from '../../lib/commands';
import type {
  BrowserTranscriptReference,
  ReasoningEffort,
  SessionSummary,
  TranscriptEvent,
} from '../../types/bridge';
import {
  createLocalUserTranscriptEvent,
  newQueueId,
  shouldQueueSessionPrompt,
  type SessionPromptMode,
} from '../../lib/promptQueue';
import { sessionIsLive } from '../../lib/sessions';
import {
  createQueuedStudioPrompt,
  latestStudioSessionId,
  pendingStudioClientRef,
  studioSessionTitle,
} from './studioSession';

interface DesignSessionSendOptions {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  displayText?: string;
  browserRefs?: BrowserTranscriptReference[];
  mode?: SessionPromptMode;
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
  const isLive = session ? sessionIsLive(session) : false;
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
    const projectPaths = new Set([cwd, key]);
    for (const workspace of Object.values(design.workspaces)) {
      if (
        projectPaths.has(workspace.liveCwd) ||
        projectPaths.has(workspace.path) ||
        workspace.liveCwd === cwd ||
        workspace.path === cwd
      ) {
        projectPaths.add(workspace.liveCwd);
        projectPaths.add(workspace.path);
      }
    }
    const activeId = state.activeAppSessionId;
    const active = activeId ? (state.sessions[activeId] as SessionSummary | undefined) : undefined;
    const activeMatch =
      active && active.sessionPurpose !== 'mission-control' && projectPaths.has(active.cwd)
        ? active.appSessionId
        : undefined;
    const recovered =
      activeMatch ?? latestStudioSessionId(Object.values(state.sessions), projectPaths);
    if (!recovered) return;
    designDispatch({ type: 'ADOPT_SESSION', cwd: key, appSessionId: recovered });
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
      event: createLocalUserTranscriptEvent({
        appSessionId,
        text,
        browserRefs,
        steered,
      }),
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
      if (shouldQueueSessionPrompt({ isLive, mode })) {
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
      sendSessionPrompt(sessionId, text, mode);
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
      modelId: modelId ?? state.agentConfig.primary.modelId,
      reasoningEffort: reasoningEffort ?? state.agentConfig.primary.reasoning,
      compactionModel:
        state.compactionModel === 'current-model' ? undefined : state.compactionModel,
      compactionTokenLimit: state.compactionTokenLimit,
      compactionTokenLimitPerModel: state.compactionTokenLimitPerModel,
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
