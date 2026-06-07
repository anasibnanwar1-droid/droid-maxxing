import { useStore } from '../hooks/useStore';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, GitBranch, Hash, Zap, Activity, ArrowRight, Loader2,
  Server, Cpu, Bot, FolderGit, CheckCircle2, Circle
} from 'lucide-react';

const AGENT_COLORS = [
  '#7a8a9a', '#9a8a7a', '#7a9a8a', '#8a7a9a', '#9a7a8a', '#7a9a9a',
];

function AgentIcon({ index, role }: { index: number; role: string }) {
  const color = AGENT_COLORS[index % AGENT_COLORS.length];
  const Icon = role === 'orchestrator' ? Cpu : Bot;
  return (
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded-md"
      style={{ backgroundColor: `${color}1f`, color }}
    >
      <Icon className="w-3 h-3" />
    </span>
  );
}

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
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-droid-text">{label}</span>
      {meta && <span className="font-mono text-[11px] text-droid-text-muted shrink-0">{meta}</span>}
      {trailing}
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
  const progress = activeMission ? state.progress[activeMission.id] ?? [] : [];
  const features = activeMission?.features ?? [];

  const completed = features.filter((f) => f.status === 'completed').length;
  const total = features.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const workerSet = new Set<string>();
  features.forEach((f) => f.workerSessionIds?.forEach((id) => workerSet.add(id)));
  const workers = Array.from(workerSet);

  return (
    <div className="shrink-0 h-full w-[300px] py-3 pr-3">
      <div className="h-full droid-card">
        {/* Header */}
        <div className="flex items-center justify-between pl-3 pr-2 h-11 shrink-0">
          <span className="text-[13px] font-semibold text-droid-text">Context</span>
          <button
            onClick={() => dispatch({ type: 'SET_RIGHT_PANEL', open: false })}
            className="p-1.5 rounded-lg text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-1.5 pb-2">
          {/* Progress bar */}
          {activeMission && total > 0 && (
            <div className="px-3 pt-1 pb-2">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[12px] text-droid-text-secondary">{completed} of {total} done</span>
                <span className="font-mono text-[12px] text-droid-accent">{pct}%</span>
              </div>
              <div className="h-1.5 bg-droid-border/50 rounded-full overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-droid-accent"
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.6, ease: 'easeOut' }}
                />
              </div>
            </div>
          )}

          {/* Features */}
          {activeMission && (
            <div>
              <SectionHeader
                label="Features"
                trailing={total > 0 ? <span className="font-mono text-[11px] text-droid-text-muted">{completed}/{total}</span> : undefined}
              />
              <div>
                {features.slice(0, 6).map((f) => (
                  <Row
                    key={f.id}
                    icon={statusIcon(f.status)}
                    label={f.description}
                    onClick={() => dispatch({ type: 'SELECT_FEATURE', id: state.selectedFeatureId === f.id ? null : f.id })}
                    active={state.selectedFeatureId === f.id}
                  />
                ))}
                {features.length > 6 && (
                  <div className="px-3 py-1.5 text-[12px] text-droid-text-muted">Show {features.length - 6} more</div>
                )}
                {features.length === 0 && (
                  <div className="px-3 py-1.5 text-[12px] text-droid-text-muted">No features yet</div>
                )}
              </div>
            </div>
          )}

          {/* Selected feature detail */}
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

          {/* Subagents */}
          {activeMission && workers.length > 0 && (
            <div>
              <Divider />
              <SectionHeader
                label="Subagents"
                trailing={<span className="font-mono text-[11px] text-droid-text-muted">{workers.length}</span>}
              />
              <div>
                {workers.map((wid, i) => (
                  <Row key={wid} icon={<AgentIcon index={i} role="worker" />} label={wid.slice(0, 16)} />
                ))}
              </div>
            </div>
          )}

          {/* Progress log */}
          {progress.length > 0 && (
            <div>
              <Divider />
              <SectionHeader label="Progress" />
              <div className="px-3 pb-2 space-y-2">
                {progress.slice(-5).map((entry, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <span className="font-mono text-[10px] text-droid-text-muted shrink-0 pt-0.5">
                      {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="text-[12.5px] text-droid-text-secondary leading-snug">
                      {entry.title ?? entry.type}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Environment */}
          {activeMission && (
            <div>
              <Divider />
              <SectionHeader label="Environment" />
              <div>
                <Row icon={<FolderGit className="w-4 h-4" />} label={activeMission.cwd.split('/').slice(-2).join('/')} />
                <Row icon={<GitBranch className="w-4 h-4" />} label="main" />
                <Row icon={<Server className="w-4 h-4" />} label={activeMission.modelId ?? 'default'} meta={activeMission.autonomy} />
              </div>
            </div>
          )}

          {/* Tokens */}
          {activeMission && (
            <div>
              <Divider />
              <div className="px-3 py-2 flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-droid-text-muted" />
                  <span className="font-mono text-[12px] text-droid-text-secondary">{activeMission.tokensIn.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-2">
                  <ArrowRight className="w-3.5 h-3.5 text-droid-text-muted" />
                  <span className="font-mono text-[12px] text-droid-text-secondary">{activeMission.tokensOut.toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
