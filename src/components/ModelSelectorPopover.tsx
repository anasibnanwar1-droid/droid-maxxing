import { useState, useMemo, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Search, Check, SlidersHorizontal } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import type { AgentKind } from '../hooks/useStore';
import type { ReasoningEffort, ModelInfo } from '../types/bridge';
import { ModelIcon, providerOf } from './ModelIcon';
import { updateAgentSettings, listModels } from '../lib/commands';

const ACCENT = 'var(--droid-accent)';
const accentMix = (pct: number) => `color-mix(in srgb, var(--droid-accent) ${pct}%, transparent)`;

type ModelCategory = 'core' | 'factory' | 'custom';

const CATEGORY_LABEL: Record<ModelCategory, string> = {
  core: 'Droid core',
  factory: 'Factory',
  custom: 'Custom',
};

function categoryOf(model: ModelInfo): ModelCategory {
  if (model.isCustom || model.id.startsWith('custom:')) return 'custom';
  const provider = (model.provider ?? '').toLowerCase();
  if (provider === 'droid-core' || model.displayName.toLowerCase().startsWith('droid core')) return 'core';
  return 'factory';
}

const AGENTS: { kind: AgentKind; label: string; hint: string }[] = [
  { kind: 'orchestrator', label: 'Orchestrator', hint: 'Plans the mission & delegates' },
  { kind: 'worker', label: 'Worker', hint: 'Executes each feature' },
  { kind: 'validator', label: 'Validator', hint: 'Verifies the work' },
];

const BASE_REASONING: ReasoningEffort[] = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'dynamic'];

export default function ModelSelectorPopover({ onClose, singleAgent = false }: { onClose: () => void; singleAgent?: boolean }) {
  const { state, dispatch } = useStore();
  const [agent, setAgent] = useState<AgentKind>('orchestrator');
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<ModelCategory | 'all'>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  const active = AGENTS.find((a) => a.kind === agent)!;
  const cfg = state.agentConfig[agent];

  // For a single chat, the model/reasoning belong to that session, not the global default.
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const missionScoped = singleAgent && !!activeMission;
  const effModelId = missionScoped ? activeMission!.modelId : cfg.modelId;
  const effReasoning = missionScoped ? activeMission!.reasoningEffort ?? cfg.reasoning : cfg.reasoning;

  const hasRealModels = state.models.length > 0;
  const source = state.models;

  // The catalog is Droid CLI's source of truth; if it hasn't arrived yet, fetch it.
  useEffect(() => {
    if (!hasRealModels) listModels();
  }, [hasRealModels]);

  const catCounts = useMemo(() => {
    const counts: Record<ModelCategory, number> = { core: 0, factory: 0, custom: 0 };
    source.forEach((m) => { counts[categoryOf(m)] += 1; });
    return counts;
  }, [source]);

  const models = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter((m) => {
      if (cat !== 'all' && categoryOf(m) !== cat) return false;
      if (!q) return true;
      return m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
    });
  }, [source, query, cat]);

  const selectCat = (next: ModelCategory | 'all') => {
    setCat(next);
    setFilterOpen(false);
  };

  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [filterOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const selectedLabel = (() => {
    if (!effModelId) return 'Default';
    const m = source.find((x) => x.id === effModelId);
    return m?.displayName ?? effModelId;
  })();
  const selectedConfigModel = effModelId ? source.find((x) => x.id === effModelId) : undefined;
  const selectedSupportedReasoning = selectedConfigModel?.supportedReasoningEfforts;
  const reasoningOptions = selectedConfigModel
    ? selectedSupportedReasoning?.length
      ? selectedSupportedReasoning
      : [selectedConfigModel.defaultReasoningEffort ?? effReasoning]
    : BASE_REASONING;

  const updateReasoning = (reasoning: ReasoningEffort) => {
    if (missionScoped) dispatch({ type: 'MISSION_SET_REASONING', missionId: activeMission!.id, reasoning });
    else dispatch({ type: 'SET_AGENT_REASONING', agent, reasoning });
    updateAgentSettings({ missionId: state.activeMissionId ?? undefined, agent, reasoningEffort: reasoning });
  };

  const updateModel = (modelId?: string) => {
    if (missionScoped) dispatch({ type: 'MISSION_SET_MODEL', missionId: activeMission!.id, modelId });
    else dispatch({ type: 'SET_AGENT_MODEL', agent, modelId });
    updateAgentSettings({ missionId: state.activeMissionId ?? undefined, agent, modelId: modelId ?? null });

    // Snap reasoning to a value the new model actually supports.
    const next = modelId ? source.find((x) => x.id === modelId) : undefined;
    const supported = next?.supportedReasoningEfforts;
    if (supported?.length && !supported.includes(effReasoning)) {
      updateReasoning(next?.defaultReasoningEffort ?? supported[supported.length - 1]);
    } else if (!supported?.length && next?.defaultReasoningEffort && effReasoning !== next.defaultReasoningEffort) {
      updateReasoning(next.defaultReasoningEffort);
    }
  };

  // Keep the displayed reasoning valid if the model's supported set changes
  // (e.g. real catalog arrives after a mock placeholder was selected).
  useEffect(() => {
    const supported = selectedSupportedReasoning;
    if (supported?.length && !supported.includes(effReasoning)) {
      updateReasoning(selectedConfigModel?.defaultReasoningEffort ?? supported[supported.length - 1]);
    } else if (!supported?.length && selectedConfigModel?.defaultReasoningEffort && effReasoning !== selectedConfigModel.defaultReasoningEffort) {
      updateReasoning(selectedConfigModel.defaultReasoningEffort);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConfigModel?.id, selectedSupportedReasoning]);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      className="absolute bottom-full left-0 mb-3 w-[380px] z-50"
    >
      <div className="rounded-2xl border border-droid-border bg-droid-elevated shadow-2xl shadow-black/50 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="text-[11px] font-medium text-droid-text-secondary tracking-wide">{singleAgent ? 'Model' : 'Models'}</span>
          <span className="text-[10px] text-droid-text-muted">{singleAgent ? 'Used for this chat' : active.hint}</span>
        </div>

        {/* Agent tabs */}
        {!singleAgent && (
          <div className="px-3">
            <div className="flex gap-1 p-0.5 rounded-xl bg-droid-bg/60 border border-droid-border/60">
              {AGENTS.map((a) => {
                const on = a.kind === agent;
                return (
                  <button
                    key={a.kind}
                    onClick={() => setAgent(a.kind)}
                    className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors truncate ${
                      on ? 'bg-droid-surface text-droid-text' : 'text-droid-text-muted hover:text-droid-text-secondary'
                    }`}
                    style={on ? { boxShadow: `inset 0 0 0 1px ${accentMix(33)}` } : undefined}
                  >
                    {a.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Reasoning selector */}
        <div className="px-4 pt-3.5 pb-1">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-droid-text-muted uppercase tracking-wider">Reasoning</span>
            <span className="text-[10px] font-mono capitalize" style={{ color: ACCENT }}>{effReasoning}</span>
          </div>
          <div className="relative flex p-0.5 rounded-lg bg-droid-bg/60 border border-droid-border/60">
            {reasoningOptions.map((r) => {
              const on = effReasoning === r;
              return (
                <button
                  key={r}
                  onClick={() => updateReasoning(r)}
                  className={`relative flex-1 py-1.5 rounded-md text-[10px] capitalize transition-colors ${
                    on ? 'text-droid-text' : 'text-droid-text-muted hover:text-droid-text-secondary'
                  }`}
                >
                  {on && (
                    <motion.span
                      layoutId="reasoning-pill"
                      className="absolute inset-0 rounded-md"
                      style={{ backgroundColor: accentMix(13), boxShadow: `inset 0 0 0 1px ${accentMix(33)}` }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    />
                  )}
                  <span className="relative">{r}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Model search + list */}
        <div className="px-4 pt-3 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 px-3 h-9 rounded-lg bg-droid-bg/60 border border-droid-border focus-within:border-droid-border-hover transition-colors">
              <Search className="w-3.5 h-3.5 text-droid-text-muted shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search models · ${selectedLabel}`}
                className="flex-1 bg-transparent text-[12px] text-droid-text placeholder-droid-text-muted/70 focus:outline-none"
              />
            </div>

            <div className="relative shrink-0" ref={filterRef}>
              <button
                onClick={() => setFilterOpen((v) => !v)}
                title="Filter models by category"
                className={`flex items-center justify-center w-9 h-9 rounded-lg border transition-colors ${
                  filterOpen || cat !== 'all'
                    ? 'text-droid-text border-transparent'
                    : 'text-droid-text-muted border-droid-border hover:text-droid-text hover:border-droid-border-hover bg-droid-bg/60'
                }`}
                style={filterOpen || cat !== 'all' ? { backgroundColor: accentMix(13), boxShadow: `inset 0 0 0 1px ${accentMix(40)}` } : undefined}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
              </button>

              <AnimatePresence>
                {filterOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.98 }}
                    transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                    className="absolute right-0 top-full mt-1.5 w-44 z-50 rounded-xl border border-droid-border bg-droid-elevated shadow-2xl shadow-black/50 overflow-hidden p-1"
                  >
                    {([
                      { value: 'all' as const, label: 'All models', count: source.length },
                      { value: 'core' as const, label: CATEGORY_LABEL.core, count: catCounts.core },
                      { value: 'factory' as const, label: CATEGORY_LABEL.factory, count: catCounts.factory },
                      { value: 'custom' as const, label: CATEGORY_LABEL.custom, count: catCounts.custom },
                    ]).map((opt) => {
                      const on = cat === opt.value;
                      return (
                        <button
                          key={opt.value}
                          onClick={() => selectCat(opt.value)}
                          className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[12px] transition-colors ${
                            on ? 'bg-droid-surface text-droid-text' : 'text-droid-text-secondary hover:bg-droid-surface/60'
                          }`}
                        >
                          <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                            {on && <Check className="w-3 h-3" style={{ color: ACCENT }} strokeWidth={3.5} />}
                          </span>
                          <span className="flex-1">{opt.label}</span>
                          <span className="text-[10px] text-droid-text-muted">{opt.count}</span>
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="mt-2 max-h-[180px] overflow-y-auto -mx-1 px-1 space-y-0.5">
            <ModelRow
              label="Default"
              sub="Use Factory CLI default"
              selected={!effModelId}
              onClick={() => updateModel(undefined)}
            />
            {hasRealModels ? (
              <>
                {models.map((m) => (
                  <ModelRow
                    key={m.id}
                    label={m.displayName}
                    sub={m.provider ?? (m.isCustom ? 'custom' : m.id)}
                    model={m}
                    selected={effModelId === m.id}
                    onClick={() => updateModel(m.id)}
                  />
                ))}
                {models.length === 0 && (
                  <div className="px-2 py-3 text-[10px] text-droid-text-muted text-center">
                    No matches for “{query}”
                  </div>
                )}
              </>
            ) : (
              <div className="px-2 py-3 text-[10px] text-droid-text-muted text-center">
                Loading models from the daemon…
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tail */}
      <div className="absolute -bottom-1.5 left-7 w-3 h-3 rotate-45 bg-droid-elevated border-r border-b border-droid-border" />
    </motion.div>
  );
}

function ModelRow({
  label, sub, selected, onClick, model,
}: {
  label: string;
  sub?: string;
  selected: boolean;
  onClick: () => void;
  model?: ModelInfo;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left transition-colors ${
        selected ? 'bg-droid-surface' : 'hover:bg-droid-surface/60'
      }`}
    >
      <span className="w-4 h-4 shrink-0 flex items-center justify-center">
        <ModelIcon provider={providerOf(model)} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-droid-text truncate">{label}</span>
        {sub && <span className="block text-[10px] text-droid-text-muted truncate">{sub}</span>}
      </span>
      {selected && <Check className="w-3 h-3 shrink-0" style={{ color: ACCENT }} strokeWidth={3} />}
    </button>
  );
}
