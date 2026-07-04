import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, Send, X } from 'lucide-react';
import { useDesignStore } from '../../hooks/useDesignStore';
import { requestDesignSwap, scanComponentRegistry } from '../../lib/commands';
import type {
  ComponentRegistryEntry,
  DesignSwapReplacementRef,
  DesignSwapStrategy,
  DesignSwapTarget,
} from '../../types/bridge';

const inputClass =
  'h-8 min-w-0 rounded-md border border-droid-border bg-droid-bg/60 px-2.5 text-[12.5px] text-droid-text placeholder:text-droid-text-muted/50 outline-none focus:border-droid-accent';

const STRATEGIES: { id: DesignSwapStrategy; label: string; description: string }[] = [
  {
    id: 'preserve-api',
    label: 'Preserve API',
    description: 'Rewrites the visuals but keeps the component\u2019s props and behavior intact.',
  },
  {
    id: 'exact-copy',
    label: 'Exact copy',
    description: 'Mirrors the replacement exactly, replacing the target wholesale.',
  },
];

export default function ComponentsTab({
  cwd,
  missionId,
}: {
  cwd: string;
  missionId: string | null;
}) {
  const { design } = useDesignStore();
  const registry = design.registry[cwd] ?? [];
  const libraryItems = design.libraryItems[cwd] ?? [];

  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<DesignSwapTarget | null>(null);
  const [replacement, setReplacement] = useState<DesignSwapReplacementRef | null>(null);
  const [strategy, setStrategy] = useState<DesignSwapStrategy>('preserve-api');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(false), 4000);
    return () => clearTimeout(timer);
  }, [sent]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return registry;
    return registry.filter(
      (entry) => entry.name.toLowerCase().includes(q) || entry.file.toLowerCase().includes(q),
    );
  }, [registry, query]);

  const strategyInfo = STRATEGIES.find((s) => s.id === strategy) ?? STRATEGIES[0];

  const replacementReference =
    replacement?.kind === 'reference'
      ? libraryItems.find((item) => item.id === replacement.id)
      : null;

  const canSend = target !== null && replacement !== null && missionId !== null;

  const send = () => {
    if (!target || !replacement || !missionId) return;
    requestDesignSwap({
      cwd,
      missionId,
      target,
      replacement,
      strategy,
      note: note.trim() || undefined,
    });
    setTarget(null);
    setReplacement(null);
    setNote('');
    setSent(true);
  };

  const isTarget = (entry: ComponentRegistryEntry) =>
    target?.component === entry.name && target?.file === entry.file && target?.line === entry.line;

  const isReplacement = (entry: ComponentRegistryEntry) =>
    replacement?.kind === 'component' &&
    replacement.name === entry.name &&
    replacement.file === entry.file;

  return (
    <div className="max-w-3xl space-y-5">
      <header>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-droid-text">Component Registry</h2>
            <p className="mt-1 text-[12px] text-droid-text-muted">
              Exported components discovered in the project. Pick a target and a replacement and the
              agent performs the design swap.
            </p>
          </div>
          <button
            onClick={() => scanComponentRegistry(cwd)}
            className="p-1.5 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
            title="Rescan components"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="relative mt-3 w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-droid-text-muted/60 pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search components"
            className={`${inputClass} w-full pl-8`}
          />
        </div>
      </header>

      <section className="rounded-xl border border-droid-border bg-droid-surface p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-droid-text-muted">
              Target
            </div>
            {target ? (
              <SlotChip
                title={target.label}
                detail={
                  target.file ? `${target.file}${target.line ? `:${target.line}` : ''}` : undefined
                }
                onClear={() => setTarget(null)}
              />
            ) : (
              <div className="text-[12px] text-droid-text-muted">Choose a component below</div>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-droid-text-muted">
              Replacement
            </div>
            {replacement ? (
              <SlotChip
                title={
                  replacement.kind === 'component'
                    ? replacement.name
                    : (replacementReference?.name ?? 'Saved reference')
                }
                detail={
                  replacement.kind === 'component' ? replacement.file : replacementReference?.url
                }
                onClear={() => setReplacement(null)}
              />
            ) : (
              <div className="text-[12px] text-droid-text-muted">Choose a component below</div>
            )}
            {libraryItems.length > 0 && (
              <div className="mt-2">
                <label className="block text-[11px] text-droid-text-muted mb-1">
                  or use a saved reference
                </label>
                <select
                  value={replacement?.kind === 'reference' ? replacement.id : ''}
                  onChange={(e) =>
                    e.target.value && setReplacement({ kind: 'reference', id: e.target.value })
                  }
                  className="h-8 w-full rounded-md border border-droid-border bg-droid-bg/60 px-2 text-[12.5px] text-droid-text outline-none focus:border-droid-accent"
                >
                  <option value="">{'Saved references\u2026'}</option>
                  {libraryItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="flex flex-wrap gap-1.5">
            {STRATEGIES.map((s) => {
              const active = strategy === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setStrategy(s.id)}
                  className={`px-3 py-1 rounded-full border text-[12px] transition-colors ${
                    active
                      ? 'border-droid-accent/50 bg-droid-accent/15 text-droid-accent'
                      : 'border-droid-border text-droid-text-muted hover:text-droid-text'
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 text-[11px] text-droid-text-muted">{strategyInfo.description}</div>
        </div>

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note for the agent"
          className={`${inputClass} w-full`}
        />

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {sent ? (
              <span className="text-[12px] text-droid-accent">Swap prompt sent to the agent.</span>
            ) : !missionId ? (
              <span className="text-[11px] text-droid-text-muted">
                Open a session to send swaps
              </span>
            ) : null}
          </div>
          <button
            onClick={send}
            disabled={!canSend}
            className="flex items-center gap-1.5 h-8 px-3.5 rounded-md bg-droid-accent text-white text-[12.5px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            Send swap to agent
          </button>
        </div>
      </section>

      {registry.length === 0 ? (
        <div className="rounded-xl border border-dashed border-droid-border px-4 py-10 text-center text-[12px] text-droid-text-muted">
          No components discovered yet. Hit refresh to scan the project for exported components.
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-droid-border px-3 py-4 text-center text-[12px] text-droid-text-muted">
              No components match &ldquo;{query.trim()}&rdquo;.
            </div>
          ) : (
            filtered.map((entry) => (
              <div
                key={`${entry.file}:${entry.line}:${entry.name}`}
                className="flex items-center gap-3 rounded-lg border border-droid-border bg-droid-surface px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-medium text-droid-text">{entry.name}</span>
                    <span className="rounded bg-droid-elevated px-1.5 py-0.5 text-[10px] uppercase text-droid-text-muted">
                      {entry.exportKind}
                    </span>
                  </div>
                  <div className="font-mono text-[10.5px] text-droid-text-muted truncate">
                    {entry.file}:{entry.line}
                  </div>
                  {entry.props && (
                    <div className="font-mono text-[10.5px] text-droid-text-muted truncate">
                      {entry.props}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() =>
                      setTarget({
                        label: entry.name,
                        component: entry.name,
                        file: entry.file,
                        line: entry.line,
                      })
                    }
                    className={`text-[11px] transition-colors ${
                      isTarget(entry)
                        ? 'text-droid-accent'
                        : 'text-droid-text-muted hover:text-droid-text'
                    }`}
                  >
                    Set target
                  </button>
                  <button
                    onClick={() =>
                      setReplacement({ kind: 'component', name: entry.name, file: entry.file })
                    }
                    className={`text-[11px] transition-colors ${
                      isReplacement(entry)
                        ? 'text-droid-accent'
                        : 'text-droid-text-muted hover:text-droid-text'
                    }`}
                  >
                    Use as replacement
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SlotChip({
  title,
  detail,
  onClear,
}: {
  title: string;
  detail?: string;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-droid-border bg-droid-bg/60 px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-droid-text truncate">{title}</div>
        {detail && (
          <div className="font-mono text-[10.5px] text-droid-text-muted truncate">{detail}</div>
        )}
      </div>
      <button
        onClick={onClear}
        className="shrink-0 p-1 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors"
        title="Clear"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
