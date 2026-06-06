import { useStore } from '../hooks/useStore';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, GitBranch, Hash, Zap, Activity,
  Server, Cpu, Bot, FolderGit, CheckCircle2
} from 'lucide-react';

/* ── Subagent icon colors (muted, matching app palette) ── */
const AGENT_COLORS = [
  '#7a8a9a', '#9a8a7a', '#7a9a8a', '#8a7a9a', '#9a7a8a', '#7a9a9a',
];

function AgentIcon({ index, role }: { index: number; role: string }) {
  const color = AGENT_COLORS[index % AGENT_COLORS.length];
  const Icon = role === 'orchestrator' ? Cpu : Bot;
  return (
    <span
      className="inline-flex items-center justify-center w-4 h-4 rounded-md"
      style={{ backgroundColor: `${color}18`, color }}
    >
      <Icon className="w-2.5 h-2.5" />
    </span>
  );
}

function SectionHeader({ label, count }: { label: string; count?: string }) {
  return (
    <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
      <span className="text-[11px] font-medium text-droid-text-muted/70">{label}</span>
      {count && <span className="font-mono text-[10px] text-droid-text-muted/30">{count}</span>}
    </div>
  );
}

function Row({
  icon, label, meta, onClick, active
}: {
  icon: React.ReactNode;
  label: string;
  meta?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
        active ? 'bg-droid-accent/5' : 'hover:bg-droid-elevated/40'
      }`}
    >
      <span className="shrink-0 text-droid-text-muted/40">{icon}</span>
      <span className="text-[11px] text-droid-text-secondary truncate">{label}</span>
      {meta && <span className="ml-auto font-mono text-[10px] text-droid-text-muted/30">{meta}</span>}
    </button>
  );
}

export default function RightPanel() {
  const { state, dispatch } = useStore();
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const progress = activeMission ? state.progress[activeMission.id] ?? [] : [];
  const features = activeMission?.features ?? [];

  const completed = features.filter(f => f.status === 'completed').length;
  const total = features.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Derive workers from features
  const workerSet = new Set<string>();
  features.forEach(f => f.workerSessionIds?.forEach(id => workerSet.add(id)));
  const workers = Array.from(workerSet);

  return (
    <div className="flex flex-col bg-droid-surface shrink-0 overflow-hidden w-[260px] h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 border-b border-droid-border/20">
        <span className="text-[11px] font-medium text-droid-text-muted/50">
          {activeMission ? 'Mission Control' : 'Context'}
        </span>
        <button
          onClick={() => dispatch({ type: 'SET_RIGHT_PANEL', open: false })}
          className="p-1 rounded text-droid-text-muted/30 hover:text-droid-text-muted/60 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
          {/* ── Progress ── */}
          {activeMission && total > 0 && (
            <div className="px-3 pt-3 pb-2">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-droid-text-muted/50">{completed} of {total}</span>
                <span className="font-mono text-[10px] text-droid-accent/70">{pct}%</span>
              </div>
              <div className="h-[3px] bg-droid-border/30 rounded-full overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-droid-accent/60"
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.6, ease: 'easeOut' }}
                />
              </div>
            </div>
          )}

          {/* ── Features ── */}
          {activeMission && (
            <div className="border-t border-droid-border/15">
              <SectionHeader label="Features" count={total > 0 ? `${completed}/${total}` : undefined} />
              <div className="px-1 pb-2">
                {features.slice(0, 6).map((f) => (
                  <Row
                    key={f.id}
                    icon={<CheckCircle2 className="w-3.5 h-3.5" style={{
                      color: f.status === 'completed' ? '#7a8a7a'
                        : f.status === 'in_progress' ? '#a89878'
                        : '#2a2a2a'
                    }} />}
                    label={f.description}
                    meta={f.status === 'in_progress' ? '…' : undefined}
                    onClick={() => dispatch({ type: 'SELECT_FEATURE', id: state.selectedFeatureId === f.id ? null : f.id })}
                    active={state.selectedFeatureId === f.id}
                  />
                ))}
                {features.length > 6 && (
                  <div className="px-3 py-1 text-[10px] text-droid-text-muted/30">
                    Show {features.length - 6} more
                  </div>
                )}
                {features.length === 0 && (
                  <div className="px-3 py-1 text-[10px] text-droid-text-muted/20">No features yet</div>
                )}
              </div>
            </div>
          )}

          {/* ── Selected Feature Detail ── */}
          <AnimatePresence>
            {activeMission && state.selectedFeatureId && (() => {
              const f = activeMission.features.find(x => x.id === state.selectedFeatureId);
              if (!f) return null;
              return (
                <motion.div
                  key={f.id}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden border-t border-droid-border/15"
                >
                  <div className="px-3 py-2.5 space-y-2">
                    <div className="text-[11px] text-droid-text/90 leading-relaxed">{f.description}</div>
                    {f.skillName && (
                      <div className="flex items-center gap-2">
                        <Hash className="w-3.5 h-3.5 text-droid-text-muted/30" />
                        <span className="font-mono text-[10px] text-droid-text-muted/50">{f.skillName}</span>
                      </div>
                    )}
                    {f.currentWorkerSessionId && (
                      <div className="flex items-center gap-2">
                        <Activity className="w-3.5 h-3.5 text-droid-accent/40" />
                        <span className="font-mono text-[10px] text-droid-accent/50">{f.currentWorkerSessionId.slice(0, 12)}</span>
                      </div>
                    )}
                    {f.preconditions.length > 0 && (
                      <div className="space-y-1">
                        {f.preconditions.map((p, i) => (
                          <div key={i} className="text-[10px] text-droid-text-muted/40 pl-3 border-l-2 border-droid-border/20">{p}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            })()}
          </AnimatePresence>

          {/* ── Subagents ── */}
          {activeMission && workers.length > 0 && (
            <div className="border-t border-droid-border/15">
              <SectionHeader label="Subagents" count={`${workers.length}`} />
              <div className="px-1 pb-2">
                {workers.map((wid, i) => (
                  <Row
                    key={wid}
                    icon={<AgentIcon index={i} role="worker" />}
                    label={wid.slice(0, 16)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── Progress Log ── */}
          {progress.length > 0 && (
            <div className="border-t border-droid-border/15">
              <SectionHeader label="Progress" />
              <div className="px-3 pb-3 space-y-1">
                {progress.slice(-5).map((entry, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="font-mono text-[9px] text-droid-text-muted/20 shrink-0">
                      {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="text-[10px] text-droid-text-muted/50 leading-4">
                      {entry.title ?? entry.type}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Environment ── */}
          {activeMission && (
            <div className="border-t border-droid-border/15">
              <SectionHeader label="Environment" />
              <div className="px-1 pb-2">
                <Row
                  icon={<FolderGit className="w-3.5 h-3.5" />}
                  label={activeMission.cwd.split('/').slice(-2).join('/')}
                />
                <Row
                  icon={<GitBranch className="w-3.5 h-3.5" />}
                  label="main"
                />
                <Row
                  icon={<Server className="w-3.5 h-3.5" />}
                  label={activeMission.modelId ?? 'default'}
                  meta={activeMission.autonomy}
                />
              </div>
            </div>
          )}

          {/* ── Tokens ── */}
          {activeMission && (
            <div className="border-t border-droid-border/15 px-3 py-2.5 flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-droid-text-muted/20" />
                <span className="font-mono text-[10px] text-droid-text-muted/40">{activeMission.tokensIn.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-droid-text-muted/15">→</span>
                <span className="font-mono text-[10px] text-droid-text-muted/40">{activeMission.tokensOut.toLocaleString()}</span>
              </div>
            </div>
          )}
        </div>
    </div>
  );
}

