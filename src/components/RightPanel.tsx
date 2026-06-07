import { useEffect, useRef, useState } from 'react';
import { useStore } from '../hooks/useStore';
import { motion, AnimatePresence } from 'framer-motion';
import {
  GitBranch, Hash, Zap, Activity, ArrowRight, Loader2, ChevronRight,
  Server, Cpu, Bot, FolderGit, CheckCircle2, Circle
} from 'lucide-react';

const RUNNING_PHASES = ['running', 'initializing', 'orchestrator_turn', 'planning'];

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
      <span className="min-w-0 flex-1 text-[13px] text-droid-text leading-snug">{label}</span>
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
  const features = activeMission?.features ?? [];

  const completed = features.filter((f) => f.status === 'completed').length;
  const total = features.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Detect the model working from real generation activity: streaming text grows
  // in place, so watch the latest transcript event's length, not just phase.
  const allTx = activeMission ? state.transcripts[activeMission.id] ?? [] : [];
  const lastEv = allTx[allTx.length - 1];
  const activitySig = `${allTx.length}:${lastEv?.text?.length ?? 0}`;
  const lastChangeRef = useRef(0);
  const sigRef = useRef<string | null>(null);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (sigRef.current !== null && sigRef.current !== activitySig) lastChangeRef.current = Date.now();
    sigRef.current = activitySig;
  }, [activitySig]);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

  const phaseLive = !!activeMission && (!!activeMission.streaming || RUNNING_PHASES.includes(activeMission.phase));
  const inactive = !activeMission || ['paused', 'completed', 'failed'].includes(activeMission.phase);
  const working = !inactive && (phaseLive || Date.now() - lastChangeRef.current < 1500);

  // Auto-expand the step list while the model is working; otherwise collapse it
  // (minimal). The user can still override by clicking the section header.
  const [progressManual, setProgressManual] = useState<boolean | null>(null);
  const progressOpen = progressManual ?? working;

  const workerSet = new Set<string>();
  features.forEach((f) => f.workerSessionIds?.forEach((id) => workerSet.add(id)));
  const workers = Array.from(workerSet);

  return (
    <div className="shrink-0 w-[300px] py-3 pr-3 h-full flex items-start">
      <div className="droid-card w-full max-h-full">
        {/* Header (no close button — the top toolbar button toggles this panel) */}
        <div className="flex items-center justify-between pl-3 pr-3 h-11 shrink-0">
          <span className="text-[13px] font-semibold text-droid-text">Context</span>
          {working && <Loader2 className="w-4 h-4 animate-spin text-droid-accent" />}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
          {/* Progress (collapsible) */}
          {activeMission && (
            <div>
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

          {/* Environment */}
          {activeMission && (
            <div>
              <Divider />
              <SectionHeader label="Environment" />
              <div>
                <Row icon={<FolderGit className="w-4 h-4" />} label={activeMission.cwd.split('/').slice(-2).join('/') || 'No folder'} />
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
