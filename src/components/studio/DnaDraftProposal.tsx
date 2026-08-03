import { motion } from 'framer-motion';
import { Check, ScanLine, X } from 'lucide-react';
import type { DnaDraft } from '../../types/bridge';
import { FontLine, Swatches, TypeScale } from './DnaPrimitives';

/**
 * The visual result of scanning the codebase for a Design DNA — palette, fonts,
 * and type scale derived from what the project already ships, ready to apply or
 * dismiss. A proposal to look at, not a form to fill.
 */
export default function DnaDraftProposal({
  draft,
  onApply,
  onDismiss,
}: {
  draft: DnaDraft;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const colors = Object.values(draft.tokens.colors);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-xl border border-droid-accent/25 bg-droid-accent/[0.05] p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScanLine className="h-4 w-4 text-droid-accent" />
          <div>
            <div className="text-[12.5px] font-medium text-droid-text">Proposed from your code</div>
            <div className="mt-0.5 text-[10px] text-droid-text-muted">
              {draft.sources.length} source{draft.sources.length === 1 ? '' : 's'} scanned
            </div>
          </div>
        </div>
        <button
          onClick={onDismiss}
          title="Dismiss"
          className="flex h-6 w-6 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-active/70 hover:text-droid-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <Swatches colors={colors} />
      <TypeScale scale={draft.tokens.typeScale} />
      <FontLine fonts={draft.tokens.fonts} />

      {draft.sources.length > 0 && (
        <div className="mt-2.5 space-y-0.5">
          {draft.sources.slice(0, 3).map((s) => (
            <div key={s} className="truncate text-[10px] text-droid-text-muted">
              {s}
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          onClick={onApply}
          className="flex items-center gap-1.5 rounded-lg bg-droid-accent px-3 py-1.5 text-[12px] font-medium text-droid-bg transition-opacity hover:opacity-90"
        >
          <Check className="h-3.5 w-3.5" />
          Apply to project
        </button>
        <button
          onClick={onDismiss}
          className="rounded-lg px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:text-droid-text"
        >
          Not now
        </button>
      </div>
    </motion.div>
  );
}
