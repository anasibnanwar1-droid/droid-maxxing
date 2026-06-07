import { useRef, useEffect, useMemo, useState } from 'react';
import { useStore } from '../hooks/useStore';
import { interruptMission, setMissionAutonomy } from '../lib/commands';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Settings, FileDiff, Monitor, GitBranch, GitCommitHorizontal, ChevronDown, ChevronRight,
  Maximize2, X, PanelLeftClose, PanelLeft, Boxes, Globe, Loader2,
  ArrowLeft, CheckCircle2, Check,
} from 'lucide-react';

interface AgentEntry {
  id: string;
  label: string;
  role: 'orchestrator' | 'worker' | 'validator';
}

interface RoleAgent {
  role: AgentRole;
  sessionId: string | null;
  working: boolean;
  subAgents: AgentEntry[];
}
import type { TranscriptEvent, BridgeFeature, MissionSummary, AgentRole, ProgressEntry, ModelInfo, Autonomy } from '../types/bridge';
import { extractFileChange, type FileChange } from '../lib/diff';
import { DiffFull } from './DiffView';
import { ModelIcon, providerOf } from './ModelIcon';
import { CAT_ICON, CAT_LABEL, toolMeta } from '../lib/tools';
import { MessageFeed } from './chat';
import PromptInput from './PromptInput';

const ACCENT = 'var(--droid-accent)';
const accentMix = (pct: number) => `color-mix(in srgb, var(--droid-accent) ${pct}%, transparent)`;

/* ════════════════════════ chat ════════════════════════ */

function featureAgentRole(feature: BridgeFeature): AgentEntry['role'] {
  const text = `${feature.id} ${feature.skillName} ${feature.description}`.toLowerCase();
  return text.includes('validator') || text.includes('validation') || text.includes('scrutiny') ? 'validator' : 'worker';
}

function ChatArea({ events, live, pending, onOpenDiff, big }: { events: TranscriptEvent[]; live: boolean; pending: boolean; onOpenDiff?: (c: FileChange) => void; big?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const renderEvents = events.length > 900 ? events.slice(-900) : events;
  const hidden = events.length - renderEvents.length;
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events.length, pending]);

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-8 py-7">
      <div className={`mx-auto min-w-0 ${big ? 'max-w-3xl' : 'max-w-2xl'}`}>
        {hidden > 0 && (
          <div className="mb-4 text-center text-[12px] text-droid-text-muted">
            Showing latest {renderEvents.length.toLocaleString()} of {events.length.toLocaleString()} events.
          </div>
        )}

        <MessageFeed events={renderEvents} pending={pending} onOpenDiff={onOpenDiff} />

        {events.length === 0 && !pending && (
          <div className="py-24 text-center text-[13px] text-droid-text-muted">
            {live ? 'Waiting for the agent…' : 'Direct the orchestrator to begin.'}
          </div>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════ left: features ════════════════════════ */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[12px] font-medium text-droid-text-muted">{children}</span>;
}

function FeaturesColumn({
  features, selectedId, onSelect, big, paused,
}: {
  features: BridgeFeature[];
  selectedId: string | null;
  onSelect: (f: BridgeFeature) => void;
  big?: boolean;
  paused?: boolean;
}) {
  const milestones = useMemo(() => {
    const map = new Map<string, BridgeFeature[]>();
    features.forEach((f) => {
      const m = f.milestone ?? 'Tasks';
      if (!map.has(m)) map.set(m, []);
      map.get(m)!.push(f);
    });
    return Array.from(map.entries());
  }, [features]);

  const numberOf = useMemo(() => {
    const map = new Map<string, number>();
    features.forEach((f, i) => map.set(f.id, i + 1));
    return map;
  }, [features]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-4 pt-2 space-y-4">
      {milestones.map(([milestone, feats]) => (
        <div key={milestone}>
          <span className="block px-2 mb-1 text-[10px] font-mono text-droid-text-muted/70 uppercase tracking-wider">{milestone}</span>
          <div className="space-y-px">
            {feats.map((f) => {
              const active = selectedId === f.id;
              const completed = f.status === 'completed';
              const running = f.status === 'in_progress';
              return (
                <button
                  key={f.id}
                  onClick={() => onSelect(f)}
                  className="group relative w-full flex items-center gap-2 text-left pl-3 pr-2 py-1.5 rounded-md transition-colors"
                  style={active ? { background: accentMix(7) } : undefined}
                >
                  <span
                    className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full transition-opacity"
                    style={{ background: ACCENT, opacity: active ? 1 : running ? 0.45 : 0 }}
                  />
                  <span className="font-mono text-[10px] text-droid-text-muted/70 w-4 shrink-0 text-right">
                    {numberOf.get(f.id)}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate ${big ? 'text-[12.5px]' : 'text-[12px]'} ${
                      completed ? 'text-droid-text-muted' : active ? 'text-droid-text' : 'text-droid-text-secondary group-hover:text-droid-text'
                    }`}
                  >
                    {f.skillName || f.description}
                  </span>
                  {running && !paused ? (
                    <span className="shimmer-text font-mono text-[9px] tracking-wide shrink-0">working</span>
                  ) : completed ? (
                    <Check className="w-3 h-3 shrink-0 text-droid-text-muted/60" strokeWidth={2.5} />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {features.length === 0 && <div className="px-3 py-8 text-[12px] text-droid-text-muted">Planning features…</div>}
    </div>
  );
}

/* ════════════════════════ right: environment / subagents / sources ════════════════════════ */

function EnvRow({ icon, label, chevron, onClick }: { icon: React.ReactNode; label: string; chevron?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-2 py-2 rounded-lg text-droid-text-secondary hover:text-droid-text hover:bg-droid-elevated/60 transition-colors"
    >
      <span className="text-droid-text-muted shrink-0">{icon}</span>
      <span className="text-[13.5px] leading-none">{label}</span>
      {chevron && <ChevronDown className="w-3.5 h-3.5 ml-1 text-droid-text-muted/60" />}
    </button>
  );
}

function ContextColumn({
  mission, roleAgents, progress, viewedAgent, activeAgentId, onSelectAgent, big,
}: {
  mission: MissionSummary;
  roleAgents: RoleAgent[];
  progress: ProgressEntry[];
  viewedAgent: string;
  activeAgentId: string | null;
  onSelectAgent: (id: string) => void;
  big?: boolean;
}) {
  const skills = Array.from(new Set(mission.features.map((f) => f.skillName).filter(Boolean)));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-5">
      {/* Environment */}
      <section>
        <div className="flex items-center justify-between px-2 mb-1">
          <SectionLabel>Environment</SectionLabel>
          <button className="p-1 rounded-md text-droid-text-muted/60 hover:text-droid-text hover:bg-droid-elevated/60 transition-colors">
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
        <EnvRow icon={<FileDiff className="w-4 h-4" />} label="Changes" />
        <EnvRow icon={<Monitor className="w-4 h-4" />} label="Local" chevron />
        <EnvRow icon={<GitBranch className="w-4 h-4" />} label="main" chevron />
        <EnvRow icon={<GitCommitHorizontal className="w-4 h-4" />} label="Commit or push" />
      </section>

      {/* Agents (model + live status merged) */}
      <AgentsSection
        mission={mission}
        roleAgents={roleAgents}
        viewedAgent={viewedAgent}
        activeAgentId={activeAgentId}
        onSelectAgent={onSelectAgent}
      />

      {/* Progress log */}
      <ProgressSection progress={progress} big={big} />

      {/* Sources */}
      <section>
        <div className="px-2 mb-2"><SectionLabel>Sources</SectionLabel></div>
        <div className="flex items-center gap-1 px-1">
          <button title={`${skills.length} skills`} className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors">
            <Boxes className="w-4 h-4" />
            {skills.length > 0 && <span className="text-[11px] font-mono">{skills.length}</span>}
          </button>
          <button title="Web" className="p-1.5 rounded-lg text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors">
            <Globe className="w-4 h-4" />
          </button>
        </div>
        {big && skills.length > 0 && (
          <div className="flex flex-wrap gap-1 px-1 mt-2">
            {skills.map((s) => (
              <span key={s} className="px-1.5 py-0.5 rounded font-mono text-[10px] text-droid-text-muted bg-droid-elevated">{s}</span>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function modelOf(role: AgentRole, mission: MissionSummary): { id?: string; reasoning?: string } {
  if (role === 'validator') return { id: mission.validatorModelId, reasoning: mission.validatorReasoningEffort };
  if (role === 'worker') return { id: mission.workerModelId, reasoning: mission.workerReasoningEffort };
  return { id: mission.modelId, reasoning: mission.reasoningEffort };
}

function modelLabel(models: ModelInfo[], id?: string): string {
  if (!id) return 'Factory default';
  return models.find((m) => m.id === id)?.displayName ?? id;
}

const ROLE_TITLE: Record<AgentRole, string> = { orchestrator: 'Orchestrator', worker: 'Worker', validator: 'Validator' };
const AUTONOMY_CYCLE: Autonomy[] = ['off', 'low', 'medium', 'high'];

function AgentsSection({
  mission, roleAgents, viewedAgent, activeAgentId, onSelectAgent,
}: {
  mission: MissionSummary;
  roleAgents: RoleAgent[];
  viewedAgent: string;
  activeAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const { state, dispatch } = useStore();

  const cycleAutonomy = () => {
    const i = AUTONOMY_CYCLE.indexOf(mission.autonomy);
    const next = AUTONOMY_CYCLE[(i + 1) % AUTONOMY_CYCLE.length];
    dispatch({ type: 'MISSION_UPDATED', mission: { ...mission, autonomy: next } });
    setMissionAutonomy(mission.id, next);
  };

  return (
    <section>
      <div className="flex items-center justify-between px-2 mb-1.5">
        <SectionLabel>Agents</SectionLabel>
        <button
          onClick={cycleAutonomy}
          title="Cycle autonomy (off → low → medium → high)"
          className="px-2 py-0.5 rounded-md font-mono text-[10px] capitalize text-droid-text-secondary hover:text-droid-text hover:bg-droid-elevated/60 transition-colors"
        >
          {mission.autonomy} autonomy
        </button>
      </div>

      <div className="space-y-0.5">
        {roleAgents.map((ra) => (
          <RoleBlock key={ra.role} mission={mission} role={ra} models={state.models} viewedAgent={viewedAgent} activeAgentId={activeAgentId} onSelectAgent={onSelectAgent} />
        ))}
      </div>
    </section>
  );
}

function RoleBlock({
  mission, role, models, viewedAgent, activeAgentId, onSelectAgent,
}: {
  mission: MissionSummary;
  role: RoleAgent;
  models: ModelInfo[];
  viewedAgent: string;
  activeAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { id, reasoning } = modelOf(role.role, mission);

  return (
    <div>
      <AgentRow
        role={role.role}
        title={ROLE_TITLE[role.role]}
        id={id}
        reasoning={reasoning}
        models={models}
        selected={role.sessionId !== null && viewedAgent === role.sessionId}
        working={role.working}
        disabled={role.sessionId === null}
        onClick={() => role.sessionId && onSelectAgent(role.sessionId)}
      />

      {role.subAgents.length > 0 && (
        <div className="ml-[19px] pl-2 border-l border-droid-border/60">
          <button
            onClick={() => setOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-2 py-1 rounded-lg text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/50 transition-colors"
          >
            <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
            {!open ? (
              <span className="shimmer-text text-[12px]">{role.subAgents.length} sub-agent{role.subAgents.length > 1 ? 's' : ''} running</span>
            ) : (
              <span className="text-[12px]">{role.subAgents.length} sub-agent{role.subAgents.length > 1 ? 's' : ''} running</span>
            )}
          </button>

          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden space-y-0.5"
              >
                {role.subAgents.map((w) => (
                  <AgentRow
                    key={w.id}
                    role={w.role}
                    title={w.label}
                    id={id}
                    reasoning={reasoning}
                    models={models}
                    selected={viewedAgent === w.id}
                    working={activeAgentId === w.id}
                    onClick={() => onSelectAgent(w.id)}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function AgentRow({
  title, id, reasoning, models, selected, working, disabled, onClick,
}: {
  role: AgentRole;
  title: string;
  id?: string;
  reasoning?: string;
  models: ModelInfo[];
  selected: boolean;
  working: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const provider = providerOf(models.find((m) => m.id === id), id);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`group w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg transition-colors text-left ${disabled ? 'opacity-45 cursor-default' : 'hover:bg-droid-elevated/50'}`}
      style={selected ? { background: accentMix(7) } : undefined}
    >
      <span className="relative shrink-0">
        <ModelIcon provider={provider} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={`text-[13px] leading-none truncate ${selected ? 'text-droid-text' : 'text-droid-text-secondary'}`}>{title}</span>
          {working && <span className="shimmer-text text-[10px] leading-none font-medium">working</span>}
        </span>
        <span className="mt-1 block font-mono text-[10px] text-droid-text-muted truncate">
          {modelLabel(models, id)}{reasoning ? ` · ${reasoning}` : ''}
        </span>
      </span>
    </button>
  );
}

function ProgressSection({ progress, big }: { progress: ProgressEntry[]; big?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const COLLAPSED = 4;
  const ordered = [...progress].reverse();
  const shown = big || showAll ? ordered : ordered.slice(0, COLLAPSED);
  const hidden = ordered.length - shown.length;

  return (
    <section>
      <div className="flex items-center justify-between px-2 mb-1.5">
        <SectionLabel>Progress</SectionLabel>
        {progress.length > 0 && <span className="font-mono text-[10px] text-droid-text-muted">{progress.length}</span>}
      </div>
      <div className="space-y-0.5">
        {shown.map((entry, index) => (
          <div key={`${entry.timestamp}-${entry.type}-${index}`} className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-droid-elevated/35 transition-colors">
            <span className="font-mono text-[9.5px] text-droid-text-muted/70 shrink-0">{formatTime(entry.timestamp)}</span>
            <span className="min-w-0 truncate text-[12px] text-droid-text-secondary">
              {entry.title ?? entry.message ?? entry.type.replace(/_/g, ' ')}
            </span>
          </div>
        ))}
        {shown.length === 0 && <div className="px-2 py-4 text-[12px] text-droid-text-muted">No progress log yet.</div>}
        {!big && hidden > 0 && (
          <button onClick={() => setShowAll(true)} className="w-full text-left px-2 py-1 text-[11.5px] text-droid-text-muted hover:text-droid-text transition-colors">
            Show {hidden} more
          </button>
        )}
        {!big && showAll && ordered.length > COLLAPSED && (
          <button onClick={() => setShowAll(false)} className="w-full text-left px-2 py-1 text-[11.5px] text-droid-text-muted hover:text-droid-text transition-colors">
            Show less
          </button>
        )}
      </div>
    </section>
  );
}

/* ════════════════════════ expand modal ════════════════════════ */

function ExpandModal({ title, onClose, children, headerExtra }: { title: string; onClose: () => void; children: React.ReactNode; headerExtra?: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0, y: 8 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.97, opacity: 0, y: 8 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-3xl h-[82vh] flex flex-col rounded-2xl border border-droid-border bg-droid-surface shadow-2xl shadow-black/60 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 h-12 border-b border-droid-border shrink-0">
          <span className="text-[13px] font-medium text-droid-text">{title}</span>
          <div className="flex items-center gap-1">
            {headerExtra}
            <button onClick={onClose} className="p-1.5 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      </motion.div>
    </motion.div>
  );
}

/* ════════════════════════ panel header ════════════════════════ */

function PanelHeader({ title, count, onExpand, onCollapse }: { title: string; count?: string; onExpand: () => void; onCollapse?: () => void }) {
  return (
    <div data-electron-drag-region className="flex items-center justify-between px-4 h-11 shrink-0 border-b border-droid-border/50">
      <span className="flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-[0.09em] text-droid-text-secondary uppercase">{title}</span>
        {count && <span className="font-mono text-[10px] text-droid-text-muted">{count}</span>}
      </span>
      <div className="flex items-center gap-0.5">
        <button onClick={onExpand} title="Expand" className="p-1 rounded-md text-droid-text-muted/60 hover:text-droid-text hover:bg-droid-elevated transition-colors">
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
        {onCollapse && (
          <button onClick={onCollapse} title="Collapse" className="p-1 rounded-md text-droid-text-muted/60 hover:text-droid-text hover:bg-droid-elevated transition-colors">
            <PanelLeftClose className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════ feature focus ════════════════════════ */

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function StatusDot({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" style={{ color: ACCENT }} />;
  if (status === 'in_progress') return <Loader2 className="w-4 h-4 mt-0.5 shrink-0 animate-spin" style={{ color: ACCENT }} />;
  return <span className="mt-1.5 w-2.5 h-2.5 rounded-full border border-droid-border shrink-0" />;
}

function ActionRow({ event, onOpenDiff }: { event: TranscriptEvent; onOpenDiff?: (c: FileChange) => void }) {
  const { cat, detail } = toolMeta(event.toolName, event.toolArgs);
  const Icon = CAT_ICON[cat];
  const change = extractFileChange(event.toolName, event.toolArgs);
  const clickable = !!change && !!onOpenDiff;
  return (
    <button
      disabled={!clickable}
      onClick={() => change && onOpenDiff?.(change)}
      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left ${clickable ? 'hover:bg-droid-elevated/60 cursor-pointer' : 'cursor-default'}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0 text-droid-text-muted" />
      <span className="text-[12px] font-medium text-droid-text-secondary shrink-0">{CAT_LABEL[cat]}</span>
      <span className="text-[12px] font-mono text-droid-text-muted truncate">{detail || event.toolName}</span>
      {clickable && <FileDiff className="w-3 h-3 ml-auto shrink-0 text-droid-text-muted/60" />}
    </button>
  );
}

function SpecList({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-droid-text-muted mb-1.5">{title}</div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2 text-[13px] text-droid-text-secondary leading-relaxed">
            <span className="mt-[7px] w-1 h-1 rounded-full bg-droid-text-muted shrink-0" />
            <span className="[overflow-wrap:anywhere]">{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeatureFocus({ feature, events, onBack, onOpenDiff }: {
  feature: BridgeFeature; events: TranscriptEvent[]; onBack: () => void; onOpenDiff?: (c: FileChange) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const sessionIds = new Set(
    [feature.currentWorkerSessionId, feature.completedWorkerSessionId, ...(feature.workerSessionIds ?? [])].filter(Boolean) as string[],
  );
  const toolCalls = events.filter((e) => e.kind === 'tool_call' && sessionIds.has(e.agentSessionId));
  const curated = toolCalls.filter((e) => toolMeta(e.toolName, e.toolArgs).cat !== 'other');
  const shown = showAll ? toolCalls : curated;
  const noSpec = feature.preconditions.length === 0 && feature.expectedBehavior.length === 0 && feature.verificationSteps.length === 0;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-6">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[12px] text-droid-text-muted hover:text-droid-text transition-colors mb-4">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to chat
        </button>

        <div className="flex items-start gap-3 mb-5">
          <StatusDot status={feature.status} />
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-droid-text leading-snug [overflow-wrap:anywhere]">{feature.description}</h2>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {feature.skillName && (
                <span className="px-1.5 py-0.5 rounded font-mono text-[11px]" style={{ color: ACCENT, background: accentMix(10) }}>[{feature.skillName}]</span>
              )}
              {feature.milestone && <span className="font-mono text-[11px] text-droid-text-muted">{feature.milestone}</span>}
              <span className="font-mono text-[11px] text-droid-text-muted capitalize">{feature.status.replace(/_/g, ' ')}</span>
            </div>
          </div>
        </div>

        <div className="space-y-4 rounded-xl bg-droid-elevated/25 p-4 mb-6">
          {noSpec ? (
            <div className="text-[12.5px] text-droid-text-muted">No spec details provided for this feature.</div>
          ) : (
            <>
              <SpecList title="Preconditions" items={feature.preconditions} />
              <SpecList title="Expected behavior" items={feature.expectedBehavior} />
              <SpecList title="Verification" items={feature.verificationSteps} />
            </>
          )}
        </div>

        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-droid-text-secondary">Worker actions</span>
            <span className="font-mono text-[10px] text-droid-text-muted">{shown.length}</span>
          </div>
          {toolCalls.length > curated.length && (
            <button onClick={() => setShowAll((v) => !v)} className="text-[11px] text-droid-text-muted hover:text-droid-text transition-colors">
              {showAll ? 'Show key actions' : `Reveal all (${toolCalls.length})`}
            </button>
          )}
        </div>
        <div className="space-y-1">
          {shown.map((e) => <ActionRow key={e.id} event={e} onOpenDiff={onOpenDiff} />)}
          {shown.length === 0 && <div className="py-8 text-center text-[12.5px] text-droid-text-muted">No worker activity recorded yet.</div>}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════ main ════════════════════════ */

export default function MissionControl() {
  const { state } = useStore();
  const mission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const [viewedAgent, setViewedAgent] = useState<string>('orchestrator');
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<'features' | 'context' | null>(null);
  const [openDiff, setOpenDiff] = useState<FileChange | null>(null);

  const features = mission?.features ?? [];
  const allTx = mission ? state.transcripts[mission.id] ?? [] : [];
  const progress = mission ? state.progress[mission.id] ?? [] : [];
  const phaseLive = mission ? ['running', 'initializing', 'orchestrator_turn'].includes(mission.phase) : false;

  // Track real generation activity (streaming text grows in place, so watch text length too).
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

  const inactive = mission
    ? ['paused', 'completed', 'failed', 'awaiting_plan_approval', 'awaiting_run_start'].includes(mission.phase)
    : true;
  const isLive = !inactive && (phaseLive || Date.now() - lastChangeRef.current < 1500);
  const phaseLabel = mission
    ? mission.phase === 'completed'
      ? 'Completed'
      : mission.phase === 'failed'
      ? 'Failed'
      : mission.phase === 'paused'
      ? 'Paused'
      : mission.phase === 'awaiting_plan_approval'
      ? 'Awaiting approval'
      : mission.phase === 'awaiting_run_start'
      ? 'Awaiting start'
      : 'Idle'
    : 'Idle';

  const workerRoles = useMemo(() => {
    const map = new Map<string, AgentEntry['role']>();
    features.forEach((f) => {
      const role = featureAgentRole(f);
      f.workerSessionIds?.forEach((id) => map.set(id, role));
      if (f.currentWorkerSessionId) map.set(f.currentWorkerSessionId, role);
      if (f.completedWorkerSessionId) map.set(f.completedWorkerSessionId, role);
    });
    progress.forEach((entry) => {
      if (entry.workerSessionId && !map.has(entry.workerSessionId)) map.set(entry.workerSessionId, 'worker');
    });
    return map;
  }, [features, progress]);

  // Stable 1-based numbering for every worker session id ever seen (so labels don't reshuffle).
  const workerNumber = useMemo(() => {
    const order: string[] = [];
    const add = (id?: string | null) => {
      if (id && id !== 'orchestrator' && id !== 'user' && !order.includes(id)) order.push(id);
    };
    features.forEach((f) => {
      (f.workerSessionIds ?? []).forEach(add);
      add(f.currentWorkerSessionId);
      add(f.completedWorkerSessionId);
    });
    progress.forEach((p) => add(p.workerSessionId));
    allTx.forEach((t) => { if (t.role !== 'orchestrator') add(t.agentSessionId); });
    const map = new Map<string, number>();
    order.forEach((id, i) => map.set(id, i + 1));
    return map;
  }, [features, progress, allTx]);

  // Only one agent is active at a time → the most recent meaningful transcript emitter while live.
  const activeAgentId = useMemo<string | null>(() => {
    if (!isLive) return null;
    for (let i = allTx.length - 1; i >= 0; i--) {
      const t = allTx[i];
      if (t.author === 'user' || t.kind === 'status') continue;
      return t.role === 'orchestrator' ? 'orchestrator' : t.agentSessionId;
    }
    return 'orchestrator';
  }, [isLive, allTx]);

  // Three fixed roles always shown. Each resolves to a session to open on click,
  // and worker/validator expose only their currently-live sub-agent sessions.
  const roleAgents = useMemo<RoleAgent[]>(() => {
    const roleOf = (id: string): AgentRole => (id === 'orchestrator' ? 'orchestrator' : workerRoles.get(id) ?? 'worker');
    const activeRole = activeAgentId ? roleOf(activeAgentId) : null;
    const liveSessions = (role: AgentRole) => {
      const ids: string[] = [];
      features.forEach((f) => {
        const id = f.currentWorkerSessionId;
        if (f.status === 'in_progress' && id && featureAgentRole(f) === role && !ids.includes(id)) ids.push(id);
      });
      return ids;
    };
    const allSessions = (role: AgentRole) => Array.from(workerNumber.keys()).filter((id) => (workerRoles.get(id) ?? 'worker') === role);
    const build = (role: AgentRole): RoleAgent => {
      if (role === 'orchestrator') return { role, sessionId: 'orchestrator', working: activeAgentId === 'orchestrator', subAgents: [] };
      const live = liveSessions(role);
      const all = allSessions(role);
      const working = activeRole === role;
      const sessionId = working && activeAgentId ? activeAgentId : live[0] ?? all[all.length - 1] ?? null;
      const subAgents = live.map((id) => ({ id, role, label: `Sub-agent ${workerNumber.get(id) ?? '?'}` }));
      return { role, sessionId, working, subAgents };
    };
    return [build('orchestrator'), build('worker'), build('validator')];
  }, [features, activeAgentId, workerRoles, workerNumber]);

  const activeAgentLabel = !activeAgentId || activeAgentId === 'orchestrator'
    ? 'Orchestrator'
    : `Sub-agent ${workerNumber.get(activeAgentId) ?? '?'}`;

  if (!mission) return null;

  const onOrchestrator = viewedAgent === 'orchestrator';
  const visible = (t: TranscriptEvent) =>
    t.author === 'user' || t.kind === 'text' || t.kind === 'thinking' || t.kind === 'tool_call' ||
    t.kind === 'tool_result' || t.kind === 'status' || t.kind === 'error' || t.isError;
  const events = (onOrchestrator
    ? allTx.filter((t) => t.role === 'orchestrator')
    : allTx.filter((t) => t.agentSessionId === viewedAgent)
  ).filter(visible);

  const selectFeature = (f: BridgeFeature) => {
    setSelectedFeatureId(f.id);
    const session = f.currentWorkerSessionId ?? f.completedWorkerSessionId ?? null;
    setViewedAgent(session ?? 'orchestrator');
    setFocusOpen(true);
  };

  const selectedFeature = features.find((f) => f.id === selectedFeatureId) ?? null;
  const done = features.filter((f) => f.status === 'completed').length;

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
      <div className="flex-1 flex min-h-0 min-w-0">
        {/* ─── Features rail ─── */}
        {railCollapsed ? (
          <div className="w-11 shrink-0 flex flex-col items-center py-3 border-r border-droid-border bg-droid-surface/20">
            <button onClick={() => setRailCollapsed(false)} title="Expand features" className="p-1.5 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated transition-colors">
              <PanelLeft className="w-4 h-4" />
            </button>
            <span className="mt-3 text-[10px] font-medium tracking-[0.15em] text-droid-text-muted uppercase [writing-mode:vertical-rl]">Features</span>
          </div>
        ) : (
          <aside className="w-[248px] shrink-0 flex flex-col border-r border-droid-border bg-droid-surface/20">
            <PanelHeader title="Features" count={features.length > 0 ? `${done}/${features.length}` : undefined} onExpand={() => setExpanded('features')} onCollapse={() => setRailCollapsed(true)} />
            <FeaturesColumn features={features} selectedId={selectedFeatureId} onSelect={selectFeature} paused={mission.phase === 'paused'} />
          </aside>
        )}

        {/* ─── Center chat ─── */}
        <section className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <div data-electron-drag-region className="shrink-0 flex items-center justify-between gap-3 pr-6 pl-6 h-12 border-b border-droid-border">
            <h1 className="text-[14px] font-medium text-droid-text truncate">{mission.title}</h1>
            <div className="flex items-center gap-2 shrink-0">
              {isLive ? (
                <>
                  <span className="shimmer-text text-[11.5px] font-medium leading-none">{activeAgentLabel} working</span>
                  <button onClick={() => interruptMission(mission.id)} className="px-2 py-1 rounded-md text-[11px] text-droid-text-muted hover:text-droid-text border border-droid-border hover:border-droid-border-hover transition-colors">
                    Stop
                  </button>
                </>
              ) : (
                <span className="text-[11px] text-droid-text-muted capitalize">
                  {phaseLabel}
                </span>
              )}
            </div>
          </div>
          {focusOpen && selectedFeature ? (
            <FeatureFocus feature={selectedFeature} events={allTx} onBack={() => setFocusOpen(false)} onOpenDiff={setOpenDiff} />
          ) : (
            <ChatArea
              events={events}
              live={isLive}
              pending={isLive && viewedAgent === activeAgentId}
              onOpenDiff={setOpenDiff}
            />
          )}
          <PromptInput />
        </section>

        {/* ─── Context panel ─── */}
        <aside className="w-[272px] shrink-0 flex flex-col border-l border-droid-border bg-droid-surface/20">
          <PanelHeader title="Context" onExpand={() => setExpanded('context')} />
          <ContextColumn mission={mission} roleAgents={roleAgents} progress={progress} viewedAgent={viewedAgent} activeAgentId={activeAgentId} onSelectAgent={setViewedAgent} />
        </aside>
      </div>

      {/* ─── Expand overlays ─── */}
      <AnimatePresence>
        {expanded === 'features' && (
          <ExpandModal title="Features" onClose={() => setExpanded(null)}>
            <FeaturesColumn features={features} selectedId={selectedFeatureId} onSelect={(f) => { selectFeature(f); setExpanded(null); }} big paused={mission.phase === 'paused'} />
          </ExpandModal>
        )}
        {expanded === 'context' && (
          <ExpandModal title="Context" onClose={() => setExpanded(null)}>
            <ContextColumn mission={mission} roleAgents={roleAgents} progress={progress} viewedAgent={viewedAgent} activeAgentId={activeAgentId} onSelectAgent={(id) => { setViewedAgent(id); setExpanded(null); }} big />
          </ExpandModal>
        )}
        {openDiff && (
          <ExpandModal title={openDiff.path} onClose={() => setOpenDiff(null)}>
            <DiffFull change={openDiff} />
          </ExpandModal>
        )}
      </AnimatePresence>
    </div>
  );
}
