import { useEffect, useState } from 'react';
import { Check, MessagesSquare, RefreshCw, ScanLine } from 'lucide-react';
import { useDesignStore } from '../../hooks/useDesignStore';
import { applyDnaLibrary, scanDesignDna, writeDesignDna } from '../../lib/commands';
import type { DnaLibrarySummary } from '../../types/bridge';
import { FontLine, Header, Swatches } from './DnaPrimitives';
import DnaDraftProposal from './DnaDraftProposal';
import DnaInterview from './DnaInterview';
import { toBriefMarkdown } from './designBrief';
import MotionPreview from './MotionPreview';

/**
 * Libraries tab — the Design DNA surface and its intake. Scan the codebase into
 * a visual proposal, apply a curated system, or view the project's current DNA
 * as swatches. Everything is visual; the markdown lives in the repo.
 */
export default function DnaShelf({ cwd }: { cwd: string }) {
  const { design } = useDesignStore();
  const dna = design.dna[cwd];
  const draft = design.drafts[cwd];
  const libraries = design.libraries;
  const hasCurrent = !!dna?.design.exists;
  const currentColors = dna?.tokens ? Object.values(dna.tokens.colors) : [];

  const [dismissed, setDismissed] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [interview, setInterview] = useState(false);
  const showDraft = !!draft && dismissed !== draft.content;

  // Clear the scanning state once a fresh draft lands for this project.
  useEffect(() => {
    if (draft) setScanning(false);
  }, [draft?.content]);

  const scan = () => {
    setScanning(true);
    setDismissed(null);
    scanDesignDna(cwd);
  };

  return (
    <div className="space-y-5">
      {showDraft && draft && (
        <DnaDraftProposal
          draft={draft}
          onApply={() => {
            writeDesignDna(cwd, 'design', draft.content);
            // Seed MOTION.md only when the project has none, so a curated motion
            // system is never clobbered by the scan default.
            if (!dna?.motion.exists) writeDesignDna(cwd, 'motion', draft.motion);
            setDismissed(draft.content);
          }}
          onDismiss={() => setDismissed(draft.content)}
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
            onClose={() => setInterview(false)}
            onComplete={(brief) => {
              writeDesignDna(cwd, 'design', toBriefMarkdown(brief));
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
                <span className={dna?.motion.exists ? 'text-[#6a8a6a]' : 'text-droid-text-muted'}>
                  {dna?.motion.exists ? 'motion' : 'no motion'}
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
            {dna?.tokens?.fonts && <FontLine fonts={dna.tokens.fonts} />}
          </div>
        ) : (
          <IntakeCta scanning={scanning} onScan={scan} onInterview={() => setInterview(true)} />
        )}
      </div>

      <div>
        <Header title="Motion" />
        <MotionPreview colors={dna?.tokens?.colors} />
      </div>

      <div>
        <Header title="Starting points" />
        <div className="space-y-2">
          {libraries.map((lib) => (
            <LibraryCard key={lib.id} lib={lib} onApply={() => applyDnaLibrary(cwd, lib.id)} />
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
