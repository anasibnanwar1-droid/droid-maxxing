import { useEffect, useState } from 'react';
import { BookOpen, Check, MessagesSquare, RefreshCw, Save, ScanLine, Trash2 } from 'lucide-react';
import { useDesignStore } from '../../hooks/useDesignStore';
import {
  applyDnaLibrary,
  applySavedDna,
  deleteSavedDna,
  finalizeDesignDna,
  listSavedDna,
  readDesignDna,
  renderDesignPreview,
  scanDesignDna,
  writeDesignDna,
} from '../../lib/commands';
import type { DnaDraft, DnaLibrarySummary, DnaState, SavedDnaEntry } from '../../types/bridge';
import { useStudioCanvas } from './StudioCanvasContext';
import { useDesignSession } from './useDesignSession';
import { FontLine, Header, Swatches } from './DnaPrimitives';
import DnaDraftProposal from './DnaDraftProposal';
import DnaInterview from './DnaInterview';
import { authoringInstruction, toBriefMarkdown } from './designBrief';
import MotionPreview from './MotionPreview';

/**
 * Libraries tab — the Design DNA surface and its intake. Scan the codebase into
 * a visual proposal, apply a curated system, or view the project's current DNA
 * as swatches. Everything is visual; the markdown lives in the repo.
 */
export default function DnaShelf({ cwd, sessionKey }: { cwd: string; sessionKey?: string }) {
  const { design } = useDesignStore();
  // Record lookups can miss at runtime even though the index type says otherwise.
  const dna = design.dna[cwd] as DnaState | undefined;
  const draft = design.drafts[cwd] as DnaDraft | undefined;
  const libraries = design.libraries;
  const saved = design.savedDna[cwd] ?? [];
  const activeId = design.activeDnaId[cwd] ?? dna?.activeSavedId ?? null;
  const hasCurrent = dna?.design.exists ?? false;
  const motionExists = dna?.motion.exists ?? false;
  const tokens = dna?.tokens;
  const currentColors = tokens ? Object.values(tokens.colors) : [];

  const { studioDispatch } = useStudioCanvas();
  // Same key as AgentPanel so interview sends land in the panel's thread, not a
  // second session keyed by the worktree path.
  const { send, sessionId } = useDesignSession(cwd, sessionKey);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [interview, setInterview] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeName, setFinalizeName] = useState('');
  const showDraft = !!draft && dismissed !== draft.content;

  // Clear the scanning state once a fresh draft lands for this project.
  useEffect(() => {
    if (draft) setScanning(false);
  }, [draft]);

  // Pull saved directions + current DNA whenever this shelf mounts for a cwd.
  useEffect(() => {
    if (!cwd) return;
    readDesignDna(cwd);
    listSavedDna(cwd);
  }, [cwd]);

  // When the design session goes idle, re-read DNA — the agent may have written
  // DESIGN.md via file tools (not design.dna.write), so the shelf would otherwise
  // stay stale ("doesn't come as selected").
  const streaming = !!sessionId && cwd in design.sessions; // session exists; streaming checked via store in AgentPanel
  useEffect(() => {
    if (!cwd || !sessionId) return;
    // Soft re-fetch on session attach; AgentPanel's streaming edge is the real
    // idle signal, but a mount refresh already covers most cases.
    const t = setTimeout(() => {
      readDesignDna(cwd);
    }, 400);
    return () => {
      clearTimeout(t);
    };
  }, [cwd, sessionId, streaming]);

  const scan = () => {
    setScanning(true);
    setDismissed(null);
    scanDesignDna(cwd);
  };

  const openFinalize = () => {
    const fallback =
      cwd.split(/[/\\]/).filter(Boolean).pop()?.replace(/[-_]+/g, ' ') ?? 'Direction';
    setFinalizeName(fallback);
    setFinalizing(true);
  };

  const commitFinalize = () => {
    const name = finalizeName.trim() || 'Direction';
    finalizeDesignDna(cwd, name, { source: 'manual' });
    setFinalizing(false);
  };

  return (
    <div className="space-y-5">
      {draft && showDraft && (
        <DnaDraftProposal
          draft={draft}
          onApply={() => {
            writeDesignDna(cwd, 'design', draft.content);
            // Seed MOTION.md only when the project has none, so a curated motion
            // system is never clobbered by the scan default.
            if (!dna?.motion.exists) writeDesignDna(cwd, 'motion', draft.motion);
            setDismissed(draft.content);
          }}
          onDismiss={() => {
            setDismissed(draft.content);
          }}
        />
      )}

      <div>
        <Header
          title="This project"
          action={
            hasCurrent ? (
              <button
                onClick={scan}
                title="Re-scan the codebase"
                className="flex h-6 w-6 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-white/[0.06] hover:text-droid-text-secondary"
              >
                <RefreshCw className={`h-3 w-3 ${scanning ? 'animate-spin' : ''}`} />
              </button>
            ) : undefined
          }
        />
        {interview && (
          <DnaInterview
            onClose={() => {
              setInterview(false);
            }}
            onComplete={(brief) => {
              // Write the intake to DESIGN.md (the agent reads it), then hand off
              // to the design session to author the full system, and switch to the
              // Agent tab so the user watches it work.
              writeDesignDna(cwd, 'design', toBriefMarkdown(brief));
              send(authoringInstruction());
              studioDispatch({ type: 'SET_LEFT_TAB', tab: 'agent' });
              setInterview(false);
            }}
          />
        )}
        {hasCurrent ? (
          <div className="rounded-xl border border-droid-border bg-white/[0.02] p-3">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-droid-text">Design DNA</span>
              <div className="flex items-center gap-2 font-mono text-[10px]">
                <span className="text-[#6a8a6a]">design</span>
                <span className={motionExists ? 'text-[#6a8a6a]' : 'text-droid-text-muted'}>
                  {motionExists ? 'motion' : 'no motion'}
                </span>
              </div>
            </div>
            {currentColors.length > 0 ? (
              <Swatches colors={currentColors} />
            ) : (
              <div className="mt-2 text-[11.5px] text-droid-text-muted">
                DESIGN.md is present. Add a token block to unlock validation.
              </div>
            )}
            {tokens?.fonts && <FontLine fonts={tokens.fonts} />}
            {tokens && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => {
                    renderDesignPreview(cwd);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#ee6018] px-3 py-1.5 text-[12px] font-medium text-black transition-colors hover:bg-[#ff6a1e]"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  Generate brand book
                </button>
                <button
                  onClick={openFinalize}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-droid-border px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:border-[#ee6018]/50 hover:text-droid-text"
                >
                  <Save className="h-3.5 w-3.5" />
                  Keep this direction
                </button>
              </div>
            )}
            {finalizing && (
              <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-droid-border bg-droid-elevated p-2">
                <input
                  autoFocus
                  value={finalizeName}
                  onChange={(e) => {
                    setFinalizeName(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitFinalize();
                    if (e.key === 'Escape') setFinalizing(false);
                  }}
                  placeholder="Name this direction"
                  className="min-w-0 flex-1 bg-transparent px-1.5 text-[12.5px] text-droid-text placeholder:text-droid-text-muted focus:outline-none"
                />
                <button
                  onClick={commitFinalize}
                  className="rounded-md bg-[#ee6018] px-2.5 py-1 text-[11.5px] font-medium text-black"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setFinalizing(false);
                  }}
                  className="rounded-md px-2 py-1 text-[11.5px] text-droid-text-muted hover:text-droid-text"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        ) : (
          <IntakeCta
            scanning={scanning}
            onScan={scan}
            onInterview={() => {
              setInterview(true);
            }}
          />
        )}
      </div>

      <div>
        <Header title="Motion" />
        <MotionPreview colors={dna?.tokens?.colors} />
      </div>

      {saved.length > 0 && (
        <div>
          <Header title="Your directions" />
          <div className="space-y-2">
            {saved.map((entry) => (
              <SavedDnaCard
                key={entry.id}
                entry={entry}
                selected={activeId === entry.id}
                onApply={() => {
                  applySavedDna(cwd, entry.id);
                }}
                onDelete={() => {
                  deleteSavedDna(cwd, entry.id);
                }}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <Header title="Starting points" />
        <div className="space-y-2">
          {libraries.map((lib) => (
            <LibraryCard
              key={lib.id}
              lib={lib}
              onApply={() => {
                applyDnaLibrary(cwd, lib.id);
              }}
            />
          ))}
          {libraries.length === 0 && (
            <div className="text-[11.5px] text-droid-text-muted">Loading curated systems…</div>
          )}
        </div>
      </div>
    </div>
  );
}

function IntakeCta({
  scanning,
  onScan,
  onInterview,
}: {
  scanning: boolean;
  onScan: () => void;
  onInterview: () => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-droid-border bg-white/[0.01] p-4 text-center">
      <MessagesSquare className="mx-auto h-5 w-5 text-droid-text-muted" />
      <div className="mt-2 text-[12.5px] font-medium text-droid-text">Give this project a DNA</div>
      <div className="mt-1 text-[11.5px] leading-relaxed text-droid-text-muted">
        Answer a short design interview and the agent authors your tokens, motion, and a real brand
        guide — or scan the codebase, or start from a system below.
      </div>
      <div className="mt-3 flex items-center justify-center gap-2">
        <button
          onClick={onInterview}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#ee6018] px-3.5 py-1.5 text-[12px] font-medium text-black transition-colors hover:bg-[#ff6a1e]"
        >
          <MessagesSquare className="h-3.5 w-3.5" />
          Start the interview
        </button>
        <button
          onClick={onScan}
          disabled={scanning}
          className="inline-flex items-center gap-1.5 rounded-lg border border-droid-border px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:border-droid-border hover:text-droid-text disabled:opacity-60"
        >
          <ScanLine className="h-3.5 w-3.5" />
          {scanning ? 'Scanning…' : 'Scan'}
        </button>
      </div>
    </div>
  );
}

function LibraryCard({ lib, onApply }: { lib: DnaLibrarySummary; onApply: () => void }) {
  return (
    <div className="group rounded-xl border border-droid-border bg-white/[0.02] p-3 transition-colors hover:border-droid-border">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-droid-text">{lib.name}</div>
          <div className="mt-0.5 truncate text-[11px] text-droid-text-muted">{lib.tagline}</div>
        </div>
        <button
          onClick={onApply}
          className="flex shrink-0 items-center gap-1 rounded-md border border-droid-border px-2 py-1 text-[11px] text-droid-text-secondary opacity-0 transition-all group-hover:opacity-100 hover:border-[#ee6018]/50 hover:text-droid-text"
        >
          <Check className="h-3 w-3" />
          Apply
        </button>
      </div>
      <Swatches colors={lib.colors} />
      {lib.fonts.length > 0 && <FontLine fonts={{ sans: lib.fonts[0], display: lib.fonts[1] }} />}
    </div>
  );
}

function SavedDnaCard({
  entry,
  selected,
  onApply,
  onDelete,
}: {
  entry: SavedDnaEntry;
  selected: boolean;
  onApply: () => void;
  onDelete: () => void;
}) {
  const colors = Object.values(entry.tokens.colors).slice(0, 8);
  return (
    // The whole card is the switch: click a direction to make it active.
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!selected) onApply();
      }}
      onKeyDown={(e) => {
        if (!selected && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onApply();
        }
      }}
      className={`group rounded-xl border p-3 transition-colors ${
        selected
          ? 'border-[#ee6018]/50 bg-[#ee6018]/[0.08]'
          : 'cursor-pointer border-droid-border bg-white/[0.02] hover:border-[#ee6018]/30'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[12.5px] font-medium text-droid-text">{entry.name}</span>
            {selected && (
              <span className="rounded-full bg-[#ee6018]/20 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-[#f0a060]">
                Active
              </span>
            )}
          </div>
          {entry.tagline && (
            <div className="mt-0.5 truncate text-[11px] text-droid-text-muted">{entry.tagline}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!selected && (
            <span className="flex items-center gap-1 rounded-md border border-droid-border px-2 py-1 text-[11px] text-droid-text-secondary opacity-0 transition-all group-hover:opacity-100">
              <Check className="h-3 w-3" />
              Use
            </span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Remove saved direction"
            className="flex h-6 w-6 items-center justify-center rounded-md text-droid-text-muted opacity-0 transition-all group-hover:opacity-100 hover:bg-white/[0.06] hover:text-[#e0806a]"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      {colors.length > 0 && <Swatches colors={colors} />}
    </div>
  );
}
