import { Blocks, RefreshCw } from 'lucide-react';
import { useDesignStore } from '../../hooks/useDesignStore';
import { scanComponentRegistry } from '../../lib/commands';
import { useStudioCanvas } from './StudioCanvasContext';

/**
 * The component shelf — the project's real exported components, sourced from the
 * repo scan. Clicking one drops it into the composer as reference context (the
 * supply side of swaps and mentions).
 */
export default function ComponentShelf({ cwd }: { cwd: string }) {
  const { design } = useDesignStore();
  const { studioDispatch } = useStudioCanvas();
  const components = design.registry[cwd] ?? [];

  return (
    <div>
      <SectionHeader
        title="Components"
        count={components.length}
        onRefresh={() => { scanComponentRegistry(cwd); }}
      />
      {components.length === 0 ? (
        <EmptyShelf onScan={() => { scanComponentRegistry(cwd); }} />
      ) : (
        <div className="space-y-1">
          {components.map((c) => (
            <button
              key={`${c.file}:${c.line}`}
              onClick={() =>
                { studioDispatch({
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
                }); }
              }
              className="group flex w-full items-start gap-2.5 rounded-lg border border-droid-border bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-droid-border hover:bg-white/[0.04]"
            >
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-b from-white/[0.08] to-transparent text-droid-text-muted group-hover:text-[#ee6018]">
                <Blocks className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium text-droid-text">
                    {c.name}
                  </span>
                  <span className="shrink-0 rounded bg-white/[0.06] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-droid-text-muted">
                    {c.exportKind}
                  </span>
                </div>
                <div className="truncate font-mono text-[10.5px] text-droid-text-muted">
                  {shortFile(c.file)}:{c.line}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
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
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-droid-text-muted">
          {title}
        </span>
        {count > 0 && <span className="font-mono text-[10.5px] text-droid-text-muted">{count}</span>}
      </div>
      <button
        onClick={onRefresh}
        title="Rescan components"
        className="flex h-6 w-6 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-white/[0.06] hover:text-droid-text-secondary"
      >
        <RefreshCw className="h-3 w-3" />
      </button>
    </div>
  );
}

function EmptyShelf({ onScan }: { onScan: () => void }) {
  return (
    <div className="mt-6 flex flex-col items-center px-4 text-center">
      <Blocks className="h-6 w-6 text-droid-text-muted" />
      <div className="mt-2 text-[12.5px] text-droid-text-secondary">No components indexed yet</div>
      <div className="mt-1 text-[11.5px] leading-relaxed text-droid-text-muted">
        Scan the repo to pull in exported components with their source locations.
      </div>
      <button
        onClick={onScan}
        className="mt-3 rounded-md border border-droid-border px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:border-[#ee6018]/50 hover:text-droid-text"
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
