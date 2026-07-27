import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../hooks/useStore';
import { parseTodos, isTodoTool, hasTodoPayload, type TodoItem } from '../lib/tools';
import { useSessionLive } from '../hooks/useSessionLive';
import { useGitEnvironment } from '../hooks/useGitEnvironment';
import { usePullRequest } from '../hooks/usePullRequest';
import { interruptChild } from '../lib/commands';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Hash,
  Activity,
  Loader2,
  ChevronRight,
  CornerDownRight,
  CheckCircle2,
  Circle,
  Square,
  FileText,
} from 'lucide-react';
import { ModelIcon, providerOf } from './ModelIcon';
import { Row, SectionHeader, Divider } from './environment/primitives';
import { EnvironmentSection } from './environment/EnvironmentSection';
import { PullRequestPanel } from './environment/PullRequestPanel';
import type { DiffStatMode } from '../types/vcs';
import { diffModeToReviewScope } from '../lib/reviewScopes';

// Mirrors the sub-agent row design used in the left sidebar.
function AgentRow({
  label,
  meta,
  prompt,
  running,
  selected,
  depth,
  onClick,
  onStop,
}: {
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
            <span className="mt-0.5 block truncate font-mono text-[10px] text-droid-text-muted/70">
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
          title="Stop subagent"
          onClick={onStop}
          className="shrink-0 rounded p-1 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          <Square className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function statusIcon(status: string) {
  if (status === 'completed')
    return <CheckCircle2 className="w-4 h-4" style={{ color: '#6f8f6f' }} />;
  if (status === 'in_progress')
    return <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#b0985f' }} />;
  return <Circle className="w-4 h-4 text-droid-text-muted/50" />;
}

export default function RightPanel() {
  const { state, dispatch } = useStore();
  const activeSession = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  const features = activeSession?.features ?? [];
  const cwd = activeSession?.cwd ?? '';

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

  // Mission control owns its own feature-based progress; for chat/spec sessions
  // we always prefer the model's own TodoWrite list as the source of truth.
  const transcript = activeSession ? (state.transcripts[activeSession.appSessionId] ?? []) : [];
  const selectedAgent = state.selectedProviderSessionId;
  const todoResult = useMemo(() => {
    if (!activeSession || activeSession.sessionPurpose === 'mission-control')
      return { todos: [] as TodoItem[], foundPayload: false };
    const scoped =
      selectedAgent && selectedAgent !== 'primary'
        ? transcript.filter((t) => t.sourceSessionId === selectedAgent)
        : transcript.filter((t) => t.role === 'primary');
    // The latest real Todo update wins, even if it emptied the list; skip only
    // partial/streaming calls that haven't received the `todos` payload yet.
    for (let i = scoped.length - 1; i >= 0; i--) {
      const e = scoped[i];
      if (e.kind === 'tool_call' && isTodoTool(e.toolName) && hasTodoPayload(e.toolArgs)) {
        return { todos: parseTodos(e.toolArgs), foundPayload: true };
      }
    }
    return { todos: [] as TodoItem[], foundPayload: false };
  }, [activeSession, transcript, selectedAgent]);
  const todos = todoResult.todos;
  const useTodos = todoResult.foundPayload;

  const completed = useTodos
    ? todos.filter((t) => t.status === 'completed').length
    : features.filter((f) => f.status === 'completed').length;
  const total = useTodos ? todos.length : features.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Authoritative "is the model generating right now" signal — respects the
  // backend `streaming` flag and terminal phases, so the spinner stops on reply.
  const working = useSessionLive(activeSession?.appSessionId ?? null);

  // Auto-expand the step list while the model is working; otherwise collapse it.
  const [progressManual, setProgressManual] = useState<boolean | null>(null);
  const progressOpen = progressManual ?? working;

  // Sub-agents spawned in this session (same source the sidebar uses).
  const workers = activeSession ? (state.workers[activeSession.appSessionId] ?? []) : [];
  const agentsRunning = workers.some((w) => w.status === 'running');
  const [agentsOpen, setAgentsOpen] = useState(true);

  const modelInfo = activeSession?.modelId
    ? state.models.find((m) => m.id === activeSession.modelId)
    : undefined;
  const modelLabel = activeSession
    ? (modelInfo?.displayName ?? activeSession.modelId ?? 'default')
    : 'default';

  return (
    <div className="shrink-0 w-[300px] pt-11 pb-3 pr-3 h-full flex items-start">
      <div className="droid-card w-full max-h-full">
        {/* Header (no close button — the top toolbar button toggles this panel) */}
        <div className="flex items-center justify-between pl-3 pr-3 h-11 shrink-0">
          <span className="text-[13px] font-semibold text-droid-text">Context</span>
          {working && <Loader2 className="w-4 h-4 animate-spin text-droid-accent" />}
        </div>

        {view === 'pr' && pr.pr ? (
          <div className="min-h-0 flex-1">
            <PullRequestPanel
              cwd={cwd}
              pr={pr.pr}
              checks={pr.checks}
              comments={pr.comments}
              loadingDetail={pr.loadingDetail || !pr.detailLoaded}
              checksError={pr.checksError}
              commentsError={pr.commentsError}
              onBack={() => setView('context')}
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
                  cwd={activeSession.cwd}
                  env={git.env}
                  branches={git.branches}
                  worktrees={git.worktrees}
                  diffStat={git.diffStat}
                  diffMode={diffMode}
                  onDiffModeChange={setDiffMode}
                  refresh={git.refresh}
                  live={working || agentsRunning}
                  pr={pr.pr}
                  onOpenPr={() => setView('pr')}
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
                  meta={activeSession.autonomy}
                />

                {/* Agents — collapsible, nested under the model */}
                {workers.length > 0 && (
                  <div>
                    <button
                      onClick={() => setAgentsOpen((v) => !v)}
                      className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left"
                    >
                      <ChevronRight
                        className={`w-3.5 h-3.5 text-droid-text-muted transition-transform ${agentsOpen ? 'rotate-90' : ''}`}
                      />
                      <span className="text-[12px] font-medium text-droid-text-muted">Agents</span>
                      <span className="font-mono text-[11px] text-droid-text-muted/70">
                        {workers.length}
                      </span>
                      {agentsRunning && (
                        <Loader2 className="ml-auto w-3 h-3 shrink-0 animate-spin text-droid-accent" />
                      )}
                    </button>
                    <AnimatePresence initial={false}>
                      {agentsOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          {workers.map((w, i) => (
                            <AgentRow
                              key={w.providerSessionId}
                              label={w.label ?? `Sub-agent ${i + 1}`}
                              meta={
                                [
                                  w.modelId
                                    ? (state.models.find((m) => m.id === w.modelId)?.displayName ??
                                      w.modelId)
                                    : undefined,
                                  w.reasoningEffort,
                                ]
                                  .filter(Boolean)
                                  .join(' · ') || undefined
                              }
                              prompt={w.prompt}
                              running={w.status === 'running'}
                              depth={0}
                              selected={state.selectedProviderSessionId === w.providerSessionId}
                              onClick={() => {
                                const next =
                                  state.selectedProviderSessionId === w.providerSessionId
                                    ? null
                                    : w.providerSessionId;
                                dispatch({ type: 'SELECT_PROVIDER_SESSION', id: next });
                              }}
                              onStop={() =>
                                activeSession &&
                                interruptChild(activeSession.appSessionId, w.providerSessionId)
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
            {activeSession && state.sessionSpecs[activeSession.appSessionId] && (
              <div>
                <Divider />
                <button
                  onClick={() =>
                    dispatch({ type: 'SPEC_OPEN_WIKI', appSessionId: activeSession.appSessionId })
                  }
                  className="w-full flex items-center gap-1.5 px-3 pt-2 pb-1.5 text-[12.5px] font-medium text-droid-text-muted hover:text-droid-text transition-colors"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Spec
                  <ChevronRight className="w-3.5 h-3.5 ml-auto" />
                </button>
              </div>
            )}

            {/* Progress (collapsible) — under Environment */}
            {activeSession && (
              <div>
                <Divider />
                <button
                  onClick={() => setProgressManual(!progressOpen)}
                  className="w-full flex items-center justify-between px-3 pt-2 pb-1.5"
                >
                  <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-droid-text-muted">
                    <ChevronRight
                      className={`w-3.5 h-3.5 transition-transform ${progressOpen ? 'rotate-90' : ''}`}
                    />
                    Progress
                  </span>
                  <span className="flex items-center gap-2">
                    {working && <Loader2 className="w-3.5 h-3.5 animate-spin text-droid-accent" />}
                    {total > 0 && (
                      <span className="font-mono text-[11px] text-droid-text-muted">
                        {completed}/{total}
                      </span>
                    )}
                  </span>
                </button>

                <AnimatePresence initial={false}>
                  {progressOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      {total > 0 && (
                        <div className="px-3 pt-1 pb-2">
                          <div className="h-1.5 bg-droid-border/50 rounded-full overflow-hidden">
                            <motion.div
                              className="h-full rounded-full bg-droid-accent"
                              initial={false}
                              animate={{ width: `${pct}%` }}
                              transition={{ duration: 0.5, ease: 'easeOut' }}
                            />
                          </div>
                        </div>
                      )}
                      {useTodos
                        ? todos.map((t, i) => (
                            <div key={i} className="flex items-start gap-2.5 px-3 py-1.5">
                              <span className="mt-0.5 shrink-0">{statusIcon(t.status)}</span>
                              <span
                                className={`text-[12.5px] leading-snug ${
                                  t.status === 'completed'
                                    ? 'text-droid-text-muted line-through'
                                    : t.status === 'in_progress'
                                      ? 'text-droid-text'
                                      : 'text-droid-text-secondary'
                                }`}
                              >
                                {t.text}
                              </span>
                            </div>
                          ))
                        : features.map((f) => (
                            <Row
                              key={f.id}
                              icon={statusIcon(f.status)}
                              label={f.description}
                              onClick={() =>
                                dispatch({
                                  type: 'SELECT_FEATURE',
                                  id: state.selectedFeatureId === f.id ? null : f.id,
                                })
                              }
                              active={state.selectedFeatureId === f.id}
                            />
                          ))}
                      {total === 0 && (
                        <div className="px-3 py-1.5 text-[12px] text-droid-text-muted">
                          {working ? 'Working…' : 'No steps yet'}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
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
                            <span className="font-mono text-[11px] text-droid-text-secondary">
                              {f.skillName}
                            </span>
                          </div>
                        )}
                        {f.currentWorkerProviderSessionId && (
                          <div className="flex items-center gap-2">
                            <Activity className="w-3.5 h-3.5 text-droid-accent" />
                            <span className="font-mono text-[11px] text-droid-accent">
                              {f.currentWorkerProviderSessionId.slice(0, 12)}
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
