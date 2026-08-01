import { useMemo, useState } from 'react';
import { AtSign, Component, RefreshCw, Search } from 'lucide-react';
import { useDesignStore } from '../../hooks/useDesignStore';
import { previewComponent, scanComponentRegistry } from '../../lib/commands';
import type { ComponentRegistryEntry } from '../../types/bridge';
import { useStudioCanvas } from './StudioCanvasContext';

/**
 * The component shelf — the project's real exported components from the repo
 * scan, searchable like layers. Clicking one bundles and renders it LIVE on the
 * canvas (its own code + project CSS on a clean stage); the @ action attaches it
 * to the composer as reference context instead.
 */
export default function ComponentShelf({ cwd }: { cwd: string }) {
  const { design } = useDesignStore();
  const { studioDispatch } = useStudioCanvas();
  const [query, setQuery] = useState('');
  const components = design.registry[cwd] ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return components;
    return components.filter(
      (c) => c.name.toLowerCase().includes(q) || c.file.toLowerCase().includes(q),
    );
  }, [components, query]);

  const openOnCanvas = (c: ComponentRegistryEntry) => {
    previewComponent({ cwd, file: c.file, name: c.name, exportKind: c.exportKind });
  };

  const mention = (c: ComponentRegistryEntry) => {
    studioDispatch({
      type: 'ADD_SELECTION',
      additive: true,
      selection: {
        id: '',
        frameId: '',
        frameName: 'component',
        label: c.name,
        tag: c.exportKind,
        file: c.file,
        line: c.line,
      },
    });
  };

  return (
    <div>
      <SectionHeader
        title="Components"
        count={components.length}
        onRefresh={() => {
          scanComponentRegistry(cwd);
        }}
      />

      {components.length > 0 && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-droid-border bg-droid-elevated/25 px-2.5 py-1.5 focus-within:border-droid-border-hover">
          <Search className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            placeholder="Search components"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-droid-text placeholder:text-droid-text-muted focus:outline-none"
          />
        </div>
      )}

      {components.length === 0 ? (
        <EmptyShelf
          onScan={() => {
            scanComponentRegistry(cwd);
          }}
        />
      ) : filtered.length === 0 ? (
        <div className="px-2 py-4 text-center text-[11.5px] text-droid-text-muted">
          Nothing matches “{query.trim()}”.
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((c) => (
            <ComponentRow
              key={`${c.file}:${String(c.line)}`}
              entry={c}
              onOpen={() => {
                openOnCanvas(c);
              }}
              onMention={() => {
                mention(c);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ComponentRow({
  entry,
  onOpen,
  onMention,
}: {
  entry: ComponentRegistryEntry;
  onOpen: () => void;
  onMention: () => void;
}) {
  return (
    // Card click = render live on canvas (the primary, visual action).
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-droid-border/70 bg-droid-elevated/25 px-3 py-2.5 text-left transition-[background-color,border-color,transform] duration-150 hover:border-droid-border-hover hover:bg-droid-elevated/60 active:scale-[0.99]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-droid-active/50 text-droid-text-secondary transition-colors group-hover:bg-droid-active group-hover:text-droid-text">
        <Component className="h-4 w-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-droid-text">{entry.name}</div>
        <div className="mt-0.5 truncate text-[11px] text-droid-text-muted">
          {shortFile(entry.file)}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onMention();
        }}
        title="Attach as reference in the composer"
        aria-label={`Attach ${entry.name} as reference`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-droid-text-muted opacity-0 transition-all hover:bg-droid-active/70 hover:text-droid-text focus-visible:opacity-100 group-hover:opacity-100"
      >
        <AtSign className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}

function SectionHeader({
  title,
  count,
  onRefresh,
}: {
  title: string;
  count: number;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between pb-2 pt-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-medium text-droid-text-secondary">{title}</span>
        {count > 0 && <span className="text-[10.5px] text-droid-text-muted">{count}</span>}
      </div>
      <button
        onClick={onRefresh}
        title="Rescan components"
        className="flex h-6 w-6 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-active/70 hover:text-droid-text-secondary"
      >
        <RefreshCw className="h-3 w-3" />
      </button>
    </div>
  );
}

function EmptyShelf({ onScan }: { onScan: () => void }) {
  return (
    <div className="mt-8 flex flex-col items-center px-4 text-center">
      <div className="text-[12.5px] text-droid-text-secondary">No components indexed yet</div>
      <div className="mt-1 text-[11.5px] leading-relaxed text-droid-text-muted">
        Scan the repo to pull in exported components, then click one to see it live.
      </div>
      <button
        onClick={onScan}
        className="mt-3 rounded-md border border-droid-border px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:border-droid-accent/50 hover:text-droid-text"
      >
        Scan components
      </button>
    </div>
  );
}

function shortFile(file: string): string {
  const parts = file.split('/');
  return parts.slice(-2).join('/');
}
