import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { listModels } from '../../lib/commands';
import type { ModelInfo } from '../../types/bridge';
import { ModelIcon, providerOf } from '../ModelIcon';

/**
 * Model selector for the studio composer, fed by the real Droid CLI catalog
 * (`state.models`) — the same source the chat model picker uses — so every
 * model the CLI exposes shows up here. `undefined` = the CLI default.
 */
export default function StudioModelPicker({
  value,
  onChange,
}: {
  value?: string;
  onChange: (modelId?: string) => void;
}) {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const models = state.models;

  useEffect(() => {
    if (models.length === 0) listModels();
  }, [models.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const selected = value ? models.find((m) => m.id === value) : undefined;
  const label = value ? (selected?.displayName ?? value) : 'Auto';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [models, query]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1.5 text-[11.5px] text-white/65 transition-colors hover:border-white/15 hover:text-white/90"
      >
        <ModelIcon provider={providerOf(selected)} size={13} />
        <span className="max-w-[110px] truncate">{label}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: 'spring', damping: 24, stiffness: 340 }}
            className="absolute bottom-full left-0 z-30 mb-1.5 w-64 overflow-hidden rounded-xl border border-white/10 bg-[#1a1a1a] shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-2.5 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-white/35" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models"
                className="w-full bg-transparent text-[12px] text-white/85 placeholder:text-white/30 focus:outline-none"
              />
            </div>
            <div className="max-h-[220px] overflow-y-auto p-1">
              <Row
                label="Auto"
                sub="Factory CLI default"
                selected={!value}
                onClick={() => {
                  onChange(undefined);
                  setOpen(false);
                }}
              />
              {models.length === 0 && (
                <div className="px-2 py-3 text-center text-[11px] text-white/35">
                  Loading models…
                </div>
              )}
              {filtered.map((m) => (
                <Row
                  key={m.id}
                  label={m.displayName}
                  sub={m.provider ?? (m.isCustom ? 'custom' : m.id)}
                  model={m}
                  selected={value === m.id}
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Row({
  label,
  sub,
  selected,
  onClick,
  model,
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
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
        selected ? 'bg-[#ee6018]/[0.12]' : 'hover:bg-white/[0.05]'
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <ModelIcon provider={providerOf(model)} size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[12px] ${selected ? 'text-[#f0a060]' : 'text-white/85'}`}>
          {label}
        </span>
        {sub && <span className="block truncate text-[10px] text-white/35">{sub}</span>}
      </span>
      {selected && <Check className="h-3 w-3 shrink-0 text-[#ee6018]" strokeWidth={3} />}
    </button>
  );
}
