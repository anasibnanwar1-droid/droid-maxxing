import { useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback } from 'react';
import { GripVertical, ChevronRight, Square } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { useMissionLive } from '../hooks/useMissionLive';
import { motion } from 'framer-motion';
import {
  MessageFeed,
  WorkingIndicator,
  UserBubble,
  ChatSkeleton,
  TranscriptSkeleton,
  buildGroupedFeed,
  finalResponseAnchorsFromItems,
} from './chat';
import { readFile } from '../lib/desktop';
import { interruptAgent, loadMissionHistory, loadOlderMissionHistory } from '../lib/commands';
import { findWorkerForTarget, resolveWorkers, subagentActivityForTarget } from '../lib/subagents';
import type { FileChange } from '../lib/diff';
import { ConversationTimeline } from './ConversationTimeline';

function DroidWordmark() {
  return (
    <div
      className="font-mono font-black tracking-[0.2em] select-none"
      style={{
        fontSize: 'clamp(48px, 10vw, 120px)',
        lineHeight: 1.1,
        background: 'radial-gradient(circle, #3a3a3a 1.5px, transparent 1.5px)',
        backgroundSize: '8px 8px',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
      }}
    >
      DROID
    </div>
  );
}

function EmptyState({ folder }: { folder?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8">
      <DroidWordmark />
      <div className="mt-6 flex items-center gap-4 text-xs text-droid-text-muted">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-droid-green" />
          <span>Local</span>
        </div>
        <div className="flex items-center gap-1.5">
          <FolderIcon />
          <span>{folder || 'anas'}</span>
        </div>
      </div>
    </div>
  );
}

// While a conversation restores we show an animated placeholder instead of a
// "Restoring…" label, so switching chats feels like content loading in (the way
// most chat apps do) rather than a blank or busy screen.
function RestoringState() {
  return (
    <div className="mx-auto min-w-0 max-w-2xl px-6 py-6">
      <TranscriptSkeleton />
    </div>
  );
}

function RestoreFailedState({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="text-[13px] text-droid-text">Couldn't restore this conversation</span>
      {message && <span className="max-w-md text-[12px] text-droid-text-muted">{message}</span>}
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-droid-border px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60"
      >
        Retry
      </button>
    </div>
  );
}

function RestoreFailedBanner({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-center gap-2 rounded-lg border border-droid-border bg-droid-elevated/40 px-3 py-2 text-center">
      <span className="text-[12px] text-droid-text-secondary">
        {message ? `Couldn't load earlier messages: ${message}` : "Couldn't load earlier messages"}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-droid-border px-2 py-0.5 text-[11px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60"
      >
        Retry
      </button>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ChatHeader({
  title,
  live,
  sub,
}: {
  title: string;
  live: boolean;
  sub?: { label: string; meta?: string; running: boolean; onBack: () => void; onStop?: () => void };
}) {
  return (
    <div data-electron-drag-region className="shrink-0 flex items-center gap-2 h-9 pr-4 pl-4">
      <div className="flex min-w-0 items-center gap-1.5 rounded-xl bg-droid-elevated/60 pl-2 pr-3 py-1.5">
        <GripVertical className="w-3.5 h-3.5 shrink-0 text-droid-text-muted/40" />
        {sub ? (
          <button
            type="button"
            onClick={sub.onBack}
            title="Back to main agent"
            className="truncate text-[13px] font-medium text-droid-text-muted transition-colors hover:text-droid-text max-w-[200px]"
          >
            {title}
          </button>
        ) : (
          <span
            className={`truncate text-[13px] font-medium max-w-[240px] ${live ? 'shimmer-text' : 'text-droid-text'}`}
          >
            {title}
          </span>
        )}
        {sub && (
          <>
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-droid-text-muted/50" />
            <span
              className={`truncate text-[13px] font-medium max-w-[200px] ${sub.running ? 'shimmer-text' : 'text-droid-text'}`}
            >
              {sub.label}
            </span>
            {sub.meta && (
              <span className="shrink-0 font-mono text-[10px] text-droid-text-muted/70">
                {sub.meta}
              </span>
            )}
          </>
        )}
      </div>
      {sub?.onStop && (
        <button
          type="button"
          onClick={sub.onStop}
          title="Stop subagent"
          className="flex shrink-0 items-center gap-1 rounded-lg bg-droid-elevated/60 px-2.5 py-1.5 text-[11px] text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          <Square className="h-3 w-3" />
          Stop
        </button>
      )}
    </div>
  );
}

export default function ChatView({ rightInset = false }: { rightInset?: boolean }) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const allTranscript = activeMission ? (state.transcripts[activeMission.id] ?? []) : [];

  const selectedAgent = state.selectedAgentSessionId;
  const viewingSub = !!selectedAgent && selectedAgent !== 'orchestrator';

  const missionWorkers = activeMission ? (state.workers[activeMission.id] ?? []) : [];
  // Historical chat/spec sessions don't receive live mission.worker events; seed
  // from the persisted exact mapping (in state.workers) and fall back to
  // transcript reconstruction for older history so subagent links stay navigable.
  const resolvedWorkers = useMemo(
    () => resolveWorkers(missionWorkers, allTranscript),
    [missionWorkers, allTranscript],
  );
  const workerIndex = resolvedWorkers.findIndex((w) => w.sessionId === selectedAgent);
  const selectedWorker = workerIndex >= 0 ? resolvedWorkers[workerIndex] : undefined;
  const subLabel = selectedWorker
    ? (selectedWorker.label ?? `Sub-agent ${workerIndex + 1}`)
    : 'Sub-agent';
  const subModel = selectedWorker?.modelId
    ? (state.models.find((m) => m.id === selectedWorker.modelId)?.displayName ??
      selectedWorker.modelId)
    : undefined;
  const subMeta = [subModel, selectedWorker?.reasoningEffort].filter(Boolean).join(' · ');

  // Click a spawn name → switch the main chat view to that subagent's session.
  const openSubagent = useCallback(
    (target: { toolUseId?: string; label?: string }) => {
      const worker = findWorkerForTarget(resolvedWorkers, target);
      if (worker) dispatch({ type: 'SELECT_AGENT', id: worker.sessionId });
    },
    [resolvedWorkers, dispatch],
  );

  // Open the Review pane scoped to the agent's last turn and jump to the clicked
  // file, reused by both the per-turn changes summary and inline diff cards.
  const openReviewFile = useCallback(
    (path: string) => dispatch({ type: 'OPEN_REVIEW_AT', scope: 'last_turn', path }),
    [dispatch],
  );
  const openDiff = useCallback(
    (change: FileChange) => openReviewFile(change.path),
    [openReviewFile],
  );

  // Latest activity for a spawn line's inline disclosure: the worker's status,
  // start time (for the timer), and its newest meaningful transcript event.
  const subagentActivity = useCallback(
    (target: { toolUseId?: string; label?: string }) => {
      return subagentActivityForTarget(resolvedWorkers, allTranscript, target);
    },
    [resolvedWorkers, allTranscript],
  );

  const transcript = useMemo(() => {
    if (viewingSub) return allTranscript.filter((t) => t.agentSessionId === selectedAgent);
    return allTranscript.filter(
      (t) => t.role === 'orchestrator' || (t.author === 'user' && t.agentSessionId === 'user'),
    );
  }, [allTranscript, viewingSub, selectedAgent]);

  // Lazily page older orchestrator history (across the compaction chain) in as
  // the user scrolls toward the top, prefetching well before the edge so the
  // scrollback feels endless and smooth rather than hitting a hard stop.
  const historyMissionId = activeMission?.id;
  const olderCursor = historyMissionId ? state.historyCursor[historyMissionId] : undefined;
  const loadingOlder = historyMissionId ? state.historyLoadingOlder[historyMissionId] : false;
  const restore = historyMissionId ? state.sessionRestore[historyMissionId] : undefined;
  const retryRestore = useCallback(() => {
    if (!historyMissionId) return;
    dispatch({ type: 'SESSION_RESTORE_START', missionId: historyMissionId });
    loadMissionHistory(historyMissionId);
  }, [historyMissionId, dispatch]);
  // Anchor captured when an older page is requested, used to keep the viewport
  // visually fixed once the prepended messages grow the scroll height.
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);
  const PREFETCH_PX = 800;
  // Auto-page older history until the conversation timeline has at least this
  // many anchors (or the chain ends); the rest fills in as the user scrolls up.
  const TIMELINE_TARGET_ANCHORS = 12;

  // Only auto-scroll when the user is already pinned to the bottom; if they've
  // scrolled up to read, leave their position alone while the model responds.
  const stickRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (
      !viewingSub &&
      historyMissionId &&
      olderCursor &&
      !loadingOlder &&
      el.scrollTop < PREFETCH_PX
    ) {
      prependAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
      dispatch({ type: 'MISSION_HISTORY_LOADING_OLDER', missionId: historyMissionId });
      loadOlderMissionHistory(historyMissionId, olderCursor);
    }
  };

  // Restore scroll position after an older page settles so the content the user
  // was reading stays put instead of jumping to the top. Keyed on the loading
  // flag too, so an empty (fully-deduped) page still clears the stale anchor.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || prependAnchor.current === null || loadingOlder) return;
    const delta = el.scrollHeight - prependAnchor.current.height;
    if (delta > 0) el.scrollTop = prependAnchor.current.top + delta;
    prependAnchor.current = null;
  }, [transcript.length, loadingOlder]);

  const tailLen = transcript.length > 0 ? (transcript[transcript.length - 1].text?.length ?? 0) : 0;
  useEffect(() => {
    if (scrollRef.current && stickRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript.length, tailLen]);

  const live = useMissionLive(activeMission?.id ?? null);
  const draftFolder = state.draftChat?.cwd.split('/').filter(Boolean).pop();

  // Between pressing send on a fresh chat and MISSION_CREATED arriving (the
  // sidecar spawns the session, ~1-2s), there is no active mission yet. Show the
  // user's message immediately with a starting cue instead of a blank screen;
  // the real feed (which seeds the same message) takes over once it exists.
  const startingCompose = !activeMission ? Object.values(state.pendingCompose).at(-1) : undefined;

  const isSpec = activeMission?.kind === 'spec';
  const capturedPlan = activeMission ? state.specPlans[activeMission.id] : undefined;
  const storedSpec = activeMission ? state.missionSpecs[activeMission.id] : undefined;
  // The spec stays available after exiting spec mode: keep detecting/loading it
  // whenever this mission ever produced one (live kind, captured plan, or a
  // previously stored spec).
  const hadSpec = isSpec || !!capturedPlan || !!storedSpec;

  // The real deliverable in spec mode is a markdown file written to disk
  // (e.g. ~/.factory/specs/<date>-<slug>.md). Detect that path anywhere in the
  // transcript (assistant prose or the write tool's args) and load the file.
  const specPath = useMemo(() => {
    if (!hadSpec) return null;
    const re = /(\/[^\s'"`)]*specs\/[^\s'"`)]+\.md)/;
    for (let i = allTranscript.length - 1; i >= 0; i--) {
      const t = allTranscript[i];
      const hay = `${t.text ?? ''} ${t.toolArgs ? JSON.stringify(t.toolArgs) : ''}`;
      const m = hay.match(re);
      if (m) return m[1];
    }
    return null;
  }, [hadSpec, allTranscript]);

  const [fileSpec, setFileSpec] = useState<{ path: string; content: string } | null>(null);
  // Re-read on `capturedPlan` changes too: a revised spec rewrites the same file
  // path, so the path alone wouldn't trigger a reload and the card would go stale.
  useEffect(() => {
    if (!specPath) return;
    let cancelled = false;
    readFile(specPath).then((content) => {
      if (!cancelled && content) setFileSpec({ path: specPath, content });
    });
    return () => {
      cancelled = true;
    };
  }, [specPath, capturedPlan]);

  const hasFileSpec = !!fileSpec && fileSpec.path === specPath;

  // Spec content is ONLY content explicitly produced/stored as spec (#14): the
  // saved spec file or the plan submitted via ExitSpecMode. Normal assistant
  // prose is never reclassified as spec, so pressing Spec can't capture chat.
  const specContent = useMemo(() => {
    if (!hadSpec) return '';
    // 1) The saved spec file (full doc with diagrams/tables) is the best source.
    if (hasFileSpec) return fileSpec!.content;
    // 2) The plan the agent submitted via ExitSpecMode.
    if (capturedPlan) return capturedPlan;
    // 3) Previously persisted spec (e.g. after switching missions and back).
    if (storedSpec?.content) return storedSpec.content;
    return '';
  }, [hadSpec, hasFileSpec, fileSpec, capturedPlan, storedSpec]);

  // Persist the best spec we have so the card, wiki reader, and right-panel
  // button survive exiting spec mode and switching between sessions.
  const missionId = activeMission?.id;
  useEffect(() => {
    if (!missionId || !specContent) return;
    const title = specContent.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() ?? 'Specification';
    // Preserve the existing file path when the current source is not file-backed
    // (e.g. a captured plan), so the store never loses a known path on refresh.
    const path = hasFileSpec ? fileSpec!.path : storedSpec?.path;
    dispatch({ type: 'SPEC_SET', missionId, path, title, content: specContent });
  }, [missionId, specContent, hasFileSpec, fileSpec, storedSpec?.path, dispatch]);

  // Build the grouped feed once and share it: MessageFeed renders it and the
  // timeline derives its anchors from the same items, so switching sessions
  // doesn't run buildFeed/groupTurns twice on every render.
  const feedItems = useMemo(
    () => buildGroupedFeed(transcript, true, live, specContent, true),
    [transcript, live, specContent],
  );
  // Dots for the conversation timeline: one per turn's final model response,
  // derived from the same feed the transcript renders so the rail stays in sync.
  const timelineAnchors = useMemo(
    () => (viewingSub ? [] : finalResponseAnchorsFromItems(feedItems)),
    [feedItems, viewingSub],
  );

  // Old/large chats restore only a recent window, which can hold too few final
  // responses for the rail to be useful. Page older history in (via the same
  // prepend-stable path as scroll prefetch) until there are enough anchors or
  // the compaction chain is exhausted, so the timeline works on any chat.
  useEffect(() => {
    if (viewingSub || !historyMissionId || !olderCursor || loadingOlder) return;
    if (timelineAnchors.length >= TIMELINE_TARGET_ANCHORS) return;
    const el = scrollRef.current;
    if (el) prependAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
    dispatch({ type: 'MISSION_HISTORY_LOADING_OLDER', missionId: historyMissionId });
    loadOlderMissionHistory(historyMissionId, olderCursor);
  }, [viewingSub, historyMissionId, olderCursor, loadingOlder, timelineAnchors.length, dispatch]);

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
      {activeMission && (
        <ChatHeader
          title={activeMission.title}
          live={live}
          sub={
            viewingSub
              ? {
                  label: subLabel,
                  meta: subMeta || undefined,
                  running: selectedWorker?.status === 'running',
                  onBack: () => dispatch({ type: 'SELECT_AGENT', id: null }),
                  onStop:
                    activeMission && selectedAgent && selectedWorker?.status === 'running'
                      ? () => interruptAgent(activeMission.id, selectedAgent)
                      : undefined,
                }
              : undefined
          }
        />
      )}
      <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
        {activeMission && timelineAnchors.length >= 2 && (
          <ConversationTimeline scrollRef={scrollRef} anchors={timelineAnchors} />
        )}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden"
          style={{
            paddingRight: rightInset ? 312 : undefined,
            transition: 'padding-right 0.2s ease',
          }}
        >
          {activeMission && transcript.length > 0 ? (
            <motion.div
              key={`${missionId ?? 'none'}:${viewingSub ? selectedAgent : 'main'}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="mx-auto min-w-0 px-6 py-6 max-w-2xl"
            >
              {!viewingSub && restore?.status === 'failed' && (
                <RestoreFailedBanner message={restore.error} onRetry={retryRestore} />
              )}
              {!viewingSub && loadingOlder && (
                <div className="mb-4 flex justify-center">
                  <span className="text-[11px] text-droid-text-muted">
                    Loading earlier messages…
                  </span>
                </div>
              )}
              <MessageFeed
                events={transcript}
                items={feedItems}
                pending={live}
                cwd={activeMission.cwd}
                onOpenDiff={openDiff}
                onOpenReviewFile={openReviewFile}
                onOpenSubagent={openSubagent}
                subagentActivity={subagentActivity}
                specContent={specContent}
                onOpenSpecWiki={
                  missionId ? () => dispatch({ type: 'SPEC_OPEN_WIKI', missionId }) : undefined
                }
              />
            </motion.div>
          ) : activeMission && restore?.status === 'failed' ? (
            <RestoreFailedState message={restore.error} onRetry={retryRestore} />
          ) : activeMission && viewingSub ? (
            <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 px-8 text-center">
              {selectedWorker?.prompt && (
                <div className="max-w-lg rounded-xl bg-droid-elevated/40 px-4 py-3 text-left">
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-droid-text-muted">
                    Task
                  </div>
                  <div className="text-[12.5px] leading-relaxed text-droid-text-secondary whitespace-pre-wrap break-words">
                    {selectedWorker.prompt}
                  </div>
                </div>
              )}
              {selectedWorker?.status === 'running' ? (
                <WorkingIndicator
                  label={`${subLabel} is working`}
                  startTs={selectedWorker.startedAt}
                />
              ) : selectedAgent && state.agentHistoryLoading[selectedAgent] ? (
                <WorkingIndicator label={`Loading ${subLabel} activity`} />
              ) : (
                <span className="text-[13px] text-droid-text-muted">
                  No activity captured for {subLabel}.
                </span>
              )}
            </div>
          ) : activeMission && restore?.status === 'loading' ? (
            <RestoringState />
          ) : startingCompose ? (
            <div className="mx-auto min-w-0 max-w-2xl px-6 py-6">
              <UserBubble event={startingCompose} />
              <div className="mt-5">
                <ChatSkeleton />
              </div>
            </div>
          ) : (
            <EmptyState folder={draftFolder} />
          )}
        </div>
      </div>
    </div>
  );
}
