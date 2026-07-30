import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { listModels } from '../../lib/commands';
import type { ModelInfo } from '../../types/bridge';
import { ModelIcon, providerOf } from '../ModelIcon';
import { Popover } from '../environment/Popover';
import { resolveStudioDefaultModel } from './studioModels';

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const models = state.models;

  useEffect(() => {
    if (models.length === 0) listModels();
  }, [models.length]);

  const selected = value ? models.find((m) => m.id === value) : undefined;
  const defaultModel = resolveStudioDefaultModel(models, state.agentConfig.primary.modelId);
  const activeModel = selected ?? defaultModel;
  const label = value
    ? (selected?.displayName ?? value)
    : defaultModel
      ? `Default · ${defaultModel.displayName}`
      : 'Default model';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [models, query]);

  return (
    <div className="shrink-0">
      <button
        ref={triggerRef}
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-label={`Model: ${label}`}
        className="flex items-center gap-1.5 rounded-lg border border-droid-border bg-droid-surface px-2 py-1.5 text-[11.5px] text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
      >
        <ModelIcon provider={providerOf(activeModel)} size={13} />
        <span className="max-w-[150px] truncate">{label}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        anchorRef={triggerRef}
        label="Select model"
        align="left"
        width={272}
        className="studio-popover"
      >
        <div data-studio-dismissable-layer className="min-h-0">
          <div className="flex items-center gap-2 border-b border-droid-border px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              placeholder="Search models"
              className="w-full bg-transparent text-[12px] text-droid-text placeholder:text-droid-text-muted focus:outline-none"
            />
          </div>
          <div className="max-h-[260px] overflow-y-auto p-1">
            <Row
              label="Default"
              sub={defaultModel ? `Uses ${defaultModel.displayName}` : 'Uses Factory CLI default'}
              model={defaultModel}
              selected={!value}
              onClick={() => {
                onChange(undefined);
                setOpen(false);
                setQuery('');
              }}
            />
            {models.length === 0 && (
              <div className="px-2 py-3 text-center text-[11px] text-droid-text-muted">
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
                  setQuery('');
                }}
              />
            ))}
          </div>
        </div>
      </Popover>
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
        selected ? 'bg-droid-accent/10' : 'hover:bg-droid-active/70'
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <ModelIcon provider={providerOf(model)} size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[12px] ${selected ? 'text-droid-accent' : 'text-droid-text'}`}
        >
          {label}
        </span>
        {sub && <span className="block truncate text-[10px] text-droid-text-muted">{sub}</span>}
      </span>
      {selected && <Check className="h-3 w-3 shrink-0 text-droid-accent" strokeWidth={3} />}
    </button>
  );
}
