import { useEffect, useState } from 'react';
import { useStore } from '../hooks/useStore';
import { useSessionLive } from '../hooks/useSessionLive';
import { useGitEnvironment } from '../hooks/useGitEnvironment';
import { useSessionWorkingDirectory } from '../hooks/useSessionWorkingDirectory';
import { usePullRequest } from '../hooks/usePullRequest';
import { interruptChild } from '../lib/commands';
import { resolveReasoningEffortDisplay } from '../lib/reasoningEffort';
import { motion, AnimatePresence } from 'framer-motion';
import { Hash, Loader2, ChevronRight, CornerDownRight, Square, FileText } from 'lucide-react';
import { ModelIcon, providerOf } from './ModelIcon';
import NotesSection from './NotesSection';
import { Row, SectionHeader, Divider } from './environment/primitives';
import { EnvironmentSection } from './environment/EnvironmentSection';
import { PullRequestPanel } from './environment/PullRequestPanel';
import type { DiffStatMode } from '../types/vcs';
import { diffModeToReviewScope } from '../lib/reviewScopes';
import {
  childSessionIsLive,
  childSessionLabel,
  childSessionMeta,
  orderedChildSessions,
  visibleSessionTarget,
} from '../lib/childSessions';

// Parent-owned children are shown only in the right context panel.
function ChildSessionRow({
  parentAppSessionId,
  childSessionId,
  label,
  meta,
  prompt,
  running,
  selected,
  depth,
  onClick,
  onStop,
}: {
  parentAppSessionId: string;
  childSessionId: string;
  label: string;
  meta?: string;
  prompt?: string;
  running: boolean;
  selected: boolean;
  depth: number;
  onClick: () => void;
  onStop?: () => void;
}) {
  return (
    <div
      data-testid="child-session-row"
      data-parent-app-session-id={parentAppSessionId}
      data-child-session-id={childSessionId}
      className={`group w-full flex items-center gap-1.5 pr-2 py-1.5 rounded-lg transition-colors ${
        selected ? 'bg-droid-elevated/70' : 'hover:bg-droid-elevated/40'
      }`}
      style={{ paddingLeft: 16 + depth * 14 }}
    >
      <button onClick={onClick} className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
        <CornerDownRight
          className={`mt-0.5 w-3 h-3 shrink-0 ${selected ? 'text-droid-accent' : 'text-droid-text-muted/60'}`}
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[12px] ${selected ? 'text-droid-text' : 'text-droid-text-muted group-hover:text-droid-text-secondary'}`}
          >
            {label}
          </span>
          {meta && (
            <span className="mt-0.5 block truncate text-[10px] text-droid-text-muted/70">
              {meta}
            </span>
          )}
          {prompt && (
            <span className="mt-0.5 block truncate text-[10.5px] text-droid-text-muted/80">
              {prompt}
            </span>
          )}
        </span>
      </button>
      {running && <Loader2 className="w-3 h-3 shrink-0 animate-spin text-droid-accent" />}
      {running && onStop && (
        <button
          type="button"
          title="Stop child session"
          onClick={onStop}
          className="shrink-0 rounded p-1 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          <Square className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export default function RightPanel() {
  const { state, dispatch } = useStore();
  const activeSession = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  const cwd = useSessionWorkingDirectory(activeSession);

  const [diffMode, setDiffMode] = useState<DiffStatMode>('worktree');
  const [view, setView] = useState<'context' | 'pr'>('context');
  const git = useGitEnvironment(cwd, diffMode);
  const isGitHub = !!git.env?.isGitHub;
  const pr = usePullRequest(cwd, git.env?.branch ?? null, {
    enabled: isGitHub,
    active: view === 'pr',
  });

  // A PR view belongs to one session+branch; reset it when either changes.
  useEffect(() => {
    setView('context');
  }, [activeSession?.appSessionId, git.env?.branch]);

  const visibleTarget = visibleSessionTarget(
    activeSession?.appSessionId,
    state.selectedChild,
    state.childSessions,
    state.childAccess,
  );
  const selectedAgent = visibleTarget.kind === 'child' ? visibleTarget.childSessionId : null;

  const sessionSpecsById: Partial<typeof state.sessionSpecs> = state.sessionSpecs;
  const activeSpec = activeSession ? sessionSpecsById[activeSession.appSessionId] : undefined;

  // Authoritative "is the model generating right now" signal — respects the
  // backend `streaming` flag and terminal phases, so the spinner stops on reply.
  const working = useSessionLive(activeSession?.appSessionId ?? null);

  // Child sessions spawned here (the same source the sidebar uses).
  const childSessions = activeSession
    ? orderedChildSessions(Object.values(state.childSessions[activeSession.appSessionId] ?? {}))
    : [];
  // Index access on these records is typed as always-present; Partial keeps the
  // lookup honest without changing runtime behavior.
  const childRuntimeByParent: Partial<typeof state.childRuntime> = state.childRuntime;
  const childSessionsRunning = childSessions.some((childSession) =>
    childSessionIsLive(
      childSession,
      childRuntimeByParent[childSession.parentAppSessionId]?.[childSession.childSessionId],
    ),
  );
  const [childSessionsOpen, setChildSessionsOpen] = useState(true);

  const modelInfo = activeSession?.modelId
    ? state.models.find((m) => m.id === activeSession.modelId)
    : undefined;
  const modelLabel = activeSession
    ? (modelInfo?.displayName ?? activeSession.modelId ?? 'default')
    : 'default';
  // The pill next to the model carries the session's reasoning effort, resolved
  // the same way as the composer badge: the session's own pinned effort, falling
  // back to the global default. Models without reasoning support show no pill.
  const reasoningEffort = activeSession
    ? resolveReasoningEffortDisplay(
        activeSession.reasoningEffort,
        state.agentConfig.primary.reasoning,
        modelInfo,
      )
    : undefined;

  return (
    <div
      data-testid="right-context-panel"
      className="shrink-0 w-[300px] pt-11 pb-3 pr-3 h-full flex items-start"
    >
      <div className={`droid-card w-full max-h-full ${view === 'pr' ? 'h-full min-h-0' : ''}`}>
        {/* Header (no close button — the top toolbar button toggles this panel) */}
        <div className="flex items-center justify-between pl-3 pr-3 h-11 shrink-0">
          <span className="text-[13px] font-semibold text-droid-text">Context</span>
          {working && <Loader2 className="w-4 h-4 animate-spin text-droid-accent" />}
        </div>

        {view === 'pr' && pr.pr ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <PullRequestPanel
              cwd={cwd}
              pr={pr.pr}
              checks={pr.checks}
              comments={pr.comments}
              loadingDetail={pr.loadingDetail || !pr.detailLoaded}
              checksError={pr.checksError}
              commentsError={pr.commentsError}
              onBack={() => {
                setView('context');
              }}
              onRefresh={pr.refresh}
            />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
            {/* Environment */}
            {activeSession && (
              <div>
                <SectionHeader label="Environment" />
                <EnvironmentSection
                  cwd={cwd}
                  env={git.env}
                  branches={git.branches}
                  worktrees={git.worktrees}
                  diffStat={git.diffStat}
                  diffMode={diffMode}
                  onDiffModeChange={setDiffMode}
                  refresh={git.refresh}
                  live={working || childSessionsRunning}
                  pr={pr.pr}
                  onOpenPr={() => {
                    setView('pr');
                  }}
                  onOpenReview={() => {
                    dispatch({ type: 'SET_REVIEW_SCOPE', scope: diffModeToReviewScope(diffMode) });
                    dispatch({ type: 'SET_REVIEW_OPEN', open: true });
                  }}
                  onPrCreated={pr.refresh}
                />
                <Row
                  icon={
                    <ModelIcon provider={providerOf(modelInfo, activeSession.modelId)} size={16} />
                  }
                  label={modelLabel}
                  meta={reasoningEffort}
                />

                {/* Child sessions — collapsible, nested under the model */}
                {childSessions.length > 0 && (
                  <div>
                    <button
                      onClick={() => {
                        setChildSessionsOpen((open) => !open);
                      }}
                      className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left"
                    >
                      <ChevronRight
                        className={`w-3.5 h-3.5 text-droid-text-muted transition-transform ${childSessionsOpen ? 'rotate-90' : ''}`}
                      />
                      <span className="text-[12px] font-medium text-droid-text-muted">
                        Child sessions
                      </span>
                      <span className="tabular-nums text-[11px] text-droid-text-muted/70">
                        {childSessions.length}
                      </span>
                      {childSessionsRunning && (
                        <Loader2 className="ml-auto w-3 h-3 shrink-0 animate-spin text-droid-accent" />
                      )}
                    </button>
                    <AnimatePresence initial={false}>
                      {childSessionsOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          {childSessions.map((childSession, index) => (
                            <ChildSessionRow
                              key={childSession.childSessionId}
                              parentAppSessionId={childSession.parentAppSessionId}
                              childSessionId={childSession.childSessionId}
                              label={childSessionLabel(childSession, index)}
                              meta={childSessionMeta(
                                childSession,
                                state.models.find((model) => model.id === childSession.modelId)
                                  ?.displayName ?? childSession.modelId,
                              )}
                              prompt={childSession.prompt}
                              running={childSessionIsLive(
                                childSession,
                                childRuntimeByParent[childSession.parentAppSessionId]?.[
                                  childSession.childSessionId
                                ],
                              )}
                              depth={0}
                              selected={selectedAgent === childSession.childSessionId}
                              onClick={() => {
                                dispatch({
                                  type: 'SELECT_CHILD',
                                  selection:
                                    selectedAgent === childSession.childSessionId
                                      ? null
                                      : {
                                          parentAppSessionId: childSession.parentAppSessionId,
                                          childSessionId: childSession.childSessionId,
                                        },
                                });
                              }}
                              onStop={
                                visibleTarget.kind === 'child' &&
                                visibleTarget.childSessionId === childSession.childSessionId &&
                                visibleTarget.canInterrupt
                                  ? () => {
                                      interruptChild(
                                        childSession.parentAppSessionId,
                                        childSession.childSessionId,
                                      );
                                    }
                                  : undefined
                              }
                            />
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            )}

            {/* Spec — opens the full wiki reader for sessions that produced one */}
            {activeSession && activeSpec && (
              <div>
                <Divider />
                <button
                  onClick={() => {
                    dispatch({ type: 'SPEC_OPEN_WIKI', appSessionId: activeSession.appSessionId });
                  }}
                  className="w-full flex items-center gap-1.5 px-3 pt-2 pb-1.5 text-[12.5px] font-medium text-droid-text-muted hover:text-droid-text transition-colors"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Spec
                  <ChevronRight className="w-3.5 h-3.5 ml-auto" />
                </button>
              </div>
            )}

            {/* Notes — scratch reminders that hand their text to the composer.
                Keyed by session so the pad's draft and chipped tag reset on a
                session switch instead of leaking into the next session. */}
            {activeSession && (
              <NotesSection
                key={activeSession.appSessionId}
                appSessionId={activeSession.appSessionId}
              />
            )}

            {/* Selected step detail */}
            <AnimatePresence>
              {activeSession &&
                state.selectedFeatureId &&
                (() => {
                  const f = activeSession.features.find((x) => x.id === state.selectedFeatureId);
                  if (!f) return null;
                  return (
                    <motion.div
                      key={f.id}
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="mx-3 my-1.5 rounded-xl bg-droid-elevated/50 px-3 py-2.5 space-y-2">
                        <div className="text-[12.5px] text-droid-text leading-relaxed">
                          {f.description}
                        </div>
                        {f.skillName && (
                          <div className="flex items-center gap-2">
                            <Hash className="w-3.5 h-3.5 text-droid-text-muted" />
                            <span className="text-[11px] font-medium text-droid-text-secondary">
                              {f.skillName}
                            </span>
                          </div>
                        )}
                        {f.preconditions.length > 0 && (
                          <div className="space-y-1">
                            {f.preconditions.map((p, i) => (
                              <div
                                key={i}
                                className="text-[11.5px] text-droid-text-muted pl-3 border-l-2 border-droid-border"
                              >
                                {p}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  );
                })()}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
