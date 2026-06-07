import { useState } from 'react';
import { useStore } from '../hooks/useStore';
import { useMissionLive } from '../hooks/useMissionLive';
import { subscribeWorker } from '../lib/commands';
import { motion, AnimatePresence } from 'framer-motion';
import {
  GitBranch, Hash, Activity, Loader2, ChevronRight, CornerDownRight,
  FolderGit, CheckCircle2, Circle
} from 'lucide-react';
import { ModelIcon, providerOf } from './ModelIcon';

function SectionHeader({ label, trailing }: { label: string; trailing?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pt-4 pb-1.5">
      <span className="text-[12.5px] font-medium text-droid-text-muted">{label}</span>
      {trailing}
    </div>
  );
}

function Divider() {
  return <div className="mx-3 my-1.5 h-px bg-droid-border/70" />;
}

function RunningDot() {
  return (
    <motion.span
      className="w-1.5 h-1.5 rounded-full bg-droid-accent shrink-0"
      animate={{ opacity: [0.3, 1, 0.3] }}
      transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

function Row({
  icon, label, meta, onClick, active, trailing,
}: {
  icon: React.ReactNode;
  label: string;
  meta?: string;
  onClick?: () => void;
  active?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`group w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
        active ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
      }`}
    >
      <span className="shrink-0 text-droid-text-muted group-hover:text-droid-text-secondary transition-colors">{icon}</span>
      <span className="min-w-0 flex-1 text-[13px] text-droid-text leading-snug">{label}</span>
      {meta && <span className="font-mono text-[11px] text-droid-text-muted shrink-0">{meta}</span>}
      {trailing}
    </button>
  );
}

// Mirrors the sub-agent row design used in the left sidebar.
function AgentRow({ label, running, selected, depth, onClick }: {
  label: string; running: boolean; selected: boolean; depth: number; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`group w-full flex items-center gap-1.5 pr-3 py-1.5 rounded-lg text-left transition-colors ${
        selected ? 'bg-droid-elevated/70' : 'hover:bg-droid-elevated/40'
      }`}
      style={{ paddingLeft: 16 + depth * 14 }}
    >
      <CornerDownRight className={`w-3 h-3 shrink-0 ${selected ? 'text-droid-accent' : 'text-droid-text-muted/60'}`} />
      <span className={`min-w-0 flex-1 truncate text-[12px] ${selected ? 'text-droid-text' : 'text-droid-text-muted group-hover:text-droid-text-secondary'}`}>
        {label}
      </span>
      {running && <RunningDot />}
    </button>
  );
}

function statusIcon(status: string) {
  if (status === 'completed') return <CheckCircle2 className="w-4 h-4" style={{ color: '#6f8f6f' }} />;
  if (status === 'in_progress') return <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#b0985f' }} />;
  return <Circle className="w-4 h-4 text-droid-text-muted/50" />;
}

export default function RightPanel() {
  const { state, dispatch } = useStore();
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const features = activeMission?.features ?? [];

  const completed = features.filter((f) => f.status === 'completed').length;
  const total = features.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Authoritative "is the model generating right now" signal — respects the
  // backend `streaming` flag and terminal phases, so the spinner stops on reply.
  const working = useMissionLive(activeMission?.id ?? null);

  // Auto-expand the step list while the model is working; otherwise collapse it.
  const [progressManual, setProgressManual] = useState<boolean | null>(null);
  const progressOpen = progressManual ?? working;

  // Sub-agents spawned in this session (same source the sidebar uses).
  const workers = activeMission ? state.workers[activeMission.id] ?? [] : [];
  const agentsRunning = workers.some((w) => w.status === 'running');
  const [agentsOpen, setAgentsOpen] = useState(true);

  const modelInfo = activeMission?.modelId ? state.models.find((m) => m.id === activeMission.modelId) : undefined;
  const modelLabel = activeMission ? (modelInfo?.displayName ?? activeMission.modelId ?? 'default') : 'default';

  return (
    <div className="shrink-0 w-[300px] pt-11 pb-3 pr-3 h-full flex items-start">
      <div className="droid-card w-full max-h-full">
        {/* Header (no close button — the top toolbar button toggles this panel) */}
        <div className="flex items-center justify-between pl-3 pr-3 h-11 shrink-0">
          <span className="text-[13px] font-semibold text-droid-text">Context</span>
          {working && <Loader2 className="w-4 h-4 animate-spin text-droid-accent" />}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
          {/* Environment */}
          {activeMission && (
            <div>
              <SectionHeader label="Environment" />
              <div>
                <Row icon={<FolderGit className="w-4 h-4" />} label={activeMission.cwd.split('/').slice(-2).join('/') || 'No folder'} />
                <Row icon={<GitBranch className="w-4 h-4" />} label="main" />
                <Row icon={<ModelIcon provider={providerOf(modelInfo, activeMission.modelId)} size={16} />} label={modelLabel} meta={activeMission.autonomy} />

                {/* Agents — collapsible, nested under the model */}
                {workers.length > 0 && (
                  <div>
                    <button
                      onClick={() => setAgentsOpen((v) => !v)}
                      className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left"
                    >
                      <ChevronRight className={`w-3.5 h-3.5 text-droid-text-muted transition-transform ${agentsOpen ? 'rotate-90' : ''}`} />
                      <span className="text-[12px] font-medium text-droid-text-muted">Agents</span>
                      <span className="font-mono text-[11px] text-droid-text-muted/70">{workers.length}</span>
                      {agentsRunning && <span className="ml-auto"><RunningDot /></span>}
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
                              key={w.sessionId}
                              label={w.label ?? `Sub-agent ${i + 1}`}
                              running={w.status === 'running'}
                              depth={0}
                              selected={state.selectedAgentSessionId === w.sessionId}
                              onClick={() => {
                                const next = state.selectedAgentSessionId === w.sessionId ? null : w.sessionId;
                                dispatch({ type: 'SELECT_AGENT', id: next });
                                if (next) subscribeWorker(activeMission.id, w.sessionId);
                              }}
                            />
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Progress (collapsible) — under Environment */}
          {activeMission && (
            <div>
              <Divider />
              <button
                onClick={() => setProgressManual(!progressOpen)}
                className="w-full flex items-center justify-between px-3 pt-2 pb-1.5"
              >
                <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-droid-text-muted">
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${progressOpen ? 'rotate-90' : ''}`} />
                  Progress
                </span>
                <span className="flex items-center gap-2">
                  {working && <Loader2 className="w-3.5 h-3.5 animate-spin text-droid-accent" />}
                  {total > 0 && <span className="font-mono text-[11px] text-droid-text-muted">{completed}/{total}</span>}
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
                    {features.map((f) => (
                      <Row
                        key={f.id}
                        icon={statusIcon(f.status)}
                        label={f.description}
                        onClick={() => dispatch({ type: 'SELECT_FEATURE', id: state.selectedFeatureId === f.id ? null : f.id })}
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
            {activeMission && state.selectedFeatureId && (() => {
              const f = activeMission.features.find((x) => x.id === state.selectedFeatureId);
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
                    <div className="text-[12.5px] text-droid-text leading-relaxed">{f.description}</div>
                    {f.skillName && (
                      <div className="flex items-center gap-2">
                        <Hash className="w-3.5 h-3.5 text-droid-text-muted" />
                        <span className="font-mono text-[11px] text-droid-text-secondary">{f.skillName}</span>
                      </div>
                    )}
                    {f.currentWorkerSessionId && (
                      <div className="flex items-center gap-2">
                        <Activity className="w-3.5 h-3.5 text-droid-accent" />
                        <span className="font-mono text-[11px] text-droid-accent">{f.currentWorkerSessionId.slice(0, 12)}</span>
                      </div>
                    )}
                    {f.preconditions.length > 0 && (
                      <div className="space-y-1">
                        {f.preconditions.map((p, i) => (
                          <div key={i} className="text-[11.5px] text-droid-text-muted pl-3 border-l-2 border-droid-border">{p}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            })()}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
