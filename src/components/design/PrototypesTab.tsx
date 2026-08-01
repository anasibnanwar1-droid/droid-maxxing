import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useDesignStore } from '../../hooks/useDesignStore';
import { listPrototypes } from '../../lib/commands';

type ViewportMode = 'desktop' | 'mobile';

const formatDate = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const basename = (path: string) => path.split('/').pop() ?? path;

export default function PrototypesTab({
  cwd,
  appSessionId,
}: {
  cwd: string;
  appSessionId: string | null;
}) {
  void appSessionId;
  const { design } = useDesignStore();
  const prototypes = useMemo(() => design.prototypes[cwd] ?? [], [design.prototypes, cwd]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportMode>('desktop');

  const selected = useMemo(
    () => prototypes.find((p) => p.id === selectedId) ?? prototypes[0] ?? null,
    [prototypes, selectedId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-droid-text">Prototypes</h2>
          <p className="mt-1 text-[12px] text-droid-text-muted">
            Self-contained HTML mockups agents draft into{' '}
            <span className="font-mono">.droidex/prototypes/</span> before touching real code.
          </p>
        </div>
        <button
          onClick={() => listPrototypes(cwd)}
          className="p-1.5 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
          title="Refresh prototypes"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </header>

      {prototypes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-droid-border px-4 py-10 text-center text-[12px] text-droid-text-muted">
          No prototypes yet. Ask the agent to draft one and it will appear here.
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 gap-4">
          <div className="w-64 shrink-0 overflow-y-auto space-y-1">
            {prototypes.map((proto) => {
              const active = selected?.id === proto.id;
              return (
                <button
                  key={proto.id}
                  onClick={() => setSelectedId(proto.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                    active
                      ? 'bg-droid-elevated text-droid-text'
                      : 'text-droid-text-muted hover:bg-droid-elevated/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12.5px] font-medium truncate">{proto.name}</span>
                    <span className="text-[10.5px] text-droid-text-muted shrink-0">
                      {formatDate(proto.updatedAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-droid-text-muted truncate">
                    {basename(proto.path)}
                  </div>
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="flex-1 min-w-0 flex flex-col rounded-xl border border-droid-border overflow-hidden">
              <div className="h-9 shrink-0 bg-droid-surface border-b border-droid-border px-3 flex items-center justify-between gap-3">
                <span className="text-[12px] text-droid-text truncate">{selected.name}</span>
                <div className="flex items-center gap-1 shrink-0">
                  {(['desktop', 'mobile'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setViewport(mode)}
                      className={`px-2.5 py-0.5 rounded-full text-[11px] capitalize transition-colors ${
                        viewport === mode
                          ? 'bg-droid-accent/15 text-droid-accent border border-droid-accent/50'
                          : 'text-droid-text-muted border border-transparent hover:text-droid-text'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 min-h-0 bg-droid-elevated/40">
                {viewport === 'desktop' ? (
                  <iframe
                    sandbox=""
                    srcDoc={selected.html}
                    title={selected.name}
                    className="h-full w-full border-0 bg-white"
                  />
                ) : (
                  <div className="flex justify-center py-4 h-full">
                    <iframe
                      sandbox=""
                      srcDoc={selected.html}
                      title={selected.name}
                      className="w-[390px] h-full rounded-lg overflow-hidden border border-droid-border bg-white"
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
