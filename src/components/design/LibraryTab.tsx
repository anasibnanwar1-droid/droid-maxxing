import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Image as ImageIcon, Trash2, Wand2, X } from 'lucide-react';
import { useDesignStore } from '../../hooks/useDesignStore';
import { deleteDesignLibraryItem, extractDesignLibraryTokens } from '../../lib/commands';
import type { DesignLibraryItem } from '../../types/bridge';

function LibraryCard({ item, cwd }: { item: DesignLibraryItem; cwd: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const chip = item.selector || item.source?.component;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="bg-droid-surface border border-droid-border rounded-xl overflow-hidden"
    >
      <div className="h-32 bg-droid-elevated/40 flex items-center justify-center">
        {item.screenshotPath && !imageFailed ? (
          <img
            src={`file://${item.screenshotPath}`}
            alt={item.name}
            className="h-full w-full object-cover"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <ImageIcon className="w-5 h-5 text-droid-text-muted/50" />
        )}
      </div>

      <div className="p-3 space-y-1">
        <div className="text-[12.5px] font-medium text-droid-text truncate">{item.name}</div>
        <div className="text-[11px] text-droid-text-muted truncate">{item.url}</div>
        {item.note && <div className="text-[11px] text-droid-text-muted">{item.note}</div>}
        <div className="text-[10.5px] text-droid-text-muted">
          {new Date(item.createdAt).toLocaleDateString()}
        </div>
        {chip && (
          <div className="inline-block max-w-full font-mono text-[10.5px] text-droid-text-muted bg-droid-elevated rounded px-1.5 py-0.5 truncate">
            {chip}
          </div>
        )}
      </div>

      <div className="border-t border-droid-border px-3 py-2 flex items-center justify-between">
        <button
          onClick={() => extractDesignLibraryTokens(cwd, item.id)}
          className="flex items-center gap-1 text-[12px] text-droid-accent hover:opacity-80 transition-opacity"
        >
          <Wand2 className="w-3.5 h-3.5" />
          Extract tokens
        </button>
        {confirmingDelete ? (
          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-droid-text-muted">Delete?</span>
            <button
              onClick={() => deleteDesignLibraryItem(cwd, item.id)}
              className="text-red-400 hover:opacity-80 transition-opacity"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="text-droid-text-muted hover:text-droid-text transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingDelete(true)}
            className="p-1 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors"
            title="Delete reference"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </motion.div>
  );
}

export default function LibraryTab({ cwd, missionId }: { cwd: string; missionId: string | null }) {
  void missionId;
  const { design } = useDesignStore();
  const items = design.libraryItems[cwd] ?? [];
  const extracted = design.extracted[cwd];
  const [dismissedExtractionId, setDismissedExtractionId] = useState<string | null>(null);

  const showExtraction = extracted && extracted.id !== dismissedExtractionId;
  const extractedSource = extracted ? items.find((i) => i.id === extracted.id) : undefined;
  const tokens = extracted?.tokens;
  const colorEntries = Object.entries(tokens?.colors ?? {});
  const fontEntries = Object.entries(tokens?.fonts ?? {}).filter(([, v]) => v);

  return (
    <div className="max-w-4xl space-y-5">
      <header>
        <h2 className="text-[15px] font-semibold text-droid-text">Reference Library</h2>
        <p className="mt-1 text-[12px] text-droid-text-muted">
          Design references captured from the live browser, saved per project and exposed to agents
          through the design-system MCP server.
        </p>
      </header>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-droid-border px-4 py-10 text-center text-[12px] text-droid-text-muted">
          No references saved yet. Use design mode in the browser pane to capture elements and pages
          you want agents to reference.
        </div>
      ) : (
        <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
          {items.map((item) => (
            <LibraryCard key={item.id} item={item} cwd={cwd} />
          ))}
        </div>
      )}

      <AnimatePresence initial={false}>
        {showExtraction && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="rounded-xl border border-droid-border bg-droid-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="text-[12.5px] font-medium text-droid-text">
                Extracted tokens
                {extractedSource && (
                  <span className="ml-1.5 text-droid-text-muted font-normal">
                    from {extractedSource.name}
                  </span>
                )}
              </div>
              <button
                onClick={() => setDismissedExtractionId(extracted.id)}
                className="p-1 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors"
                title="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <p className="mt-2 text-[12px] text-droid-text">{extracted.summary}</p>

            {colorEntries.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {colorEntries.map(([name, value]) => (
                  <div key={name} className="flex items-center gap-1.5">
                    <span
                      className="w-5 h-5 rounded border border-droid-border"
                      style={{ backgroundColor: value }}
                    />
                    <span className="font-mono text-[10.5px] text-droid-text-muted">{value}</span>
                  </div>
                ))}
              </div>
            )}

            {fontEntries.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {fontEntries.map(([role, family]) => (
                  <span
                    key={role}
                    className="bg-droid-elevated rounded px-1.5 py-0.5 text-[10.5px] font-mono text-droid-text-muted"
                  >
                    {role}: {family}
                  </span>
                ))}
              </div>
            )}

            {(['typeScale', 'spacing', 'radii'] as const).map((key) => {
              const values = tokens?.[key];
              if (!values || values.length === 0) return null;
              return (
                <div key={key} className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10.5px] text-droid-text-muted">{key}</span>
                  {values.map((v, i) => (
                    <span
                      key={`${v}-${i}`}
                      className="bg-droid-elevated rounded px-1.5 py-0.5 text-[10.5px] font-mono text-droid-text-muted"
                    >
                      {v}
                    </span>
                  ))}
                </div>
              );
            })}
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}
