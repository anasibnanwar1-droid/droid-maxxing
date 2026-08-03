import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

const EASE = [0.16, 1, 0.3, 1] as const;

// "What's new" spotlight floating beside the context bar, shown once per
// profile. The visual header is a pure-CSS miniature of the checklist below,
// so it always matches the current theme. NotesSection portals it to the body
// and owns its positioning; this is the pure presentational half.
export function NotesIntroCard({
  style,
  caretTop,
  onTry,
  onClose,
}: {
  style: CSSProperties;
  caretTop: number;
  onTry: () => void;
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.98 }}
      transition={{ duration: 0.22, ease: EASE }}
      style={style}
      className="z-50"
    >
      <div className="relative overflow-hidden rounded-2xl border border-droid-border bg-droid-elevated shadow-[0_8px_28px_rgba(0,0,0,0.45)]">
        {/* Visual: soft accent glow + a tiny notes card peeking from the bottom */}
        <div className="relative h-24 overflow-hidden border-b border-droid-border/60 bg-droid-bg">
          <div className="absolute -left-6 -top-10 h-28 w-28 rounded-full bg-droid-accent/25 blur-2xl" />
          <div className="absolute -right-4 top-2 h-20 w-24 rounded-full bg-droid-accent/10 blur-2xl" />
          <div className="pointer-events-none absolute inset-x-8 bottom-0 rounded-t-xl border border-b-0 border-droid-border/70 bg-droid-elevated/90 px-2.5 pt-2 shadow-[0_-1px_6px_rgba(0,0,0,0.25)]">
            <div className="flex items-center gap-1.5 pb-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full bg-droid-accent" />
              <span className="h-1.5 w-2/3 rounded-full bg-droid-border/80" />
            </div>
            <div className="flex items-center gap-1.5 pb-2">
              <span className="h-2 w-2 shrink-0 rounded-full border border-droid-text-muted/50" />
              <span className="h-1.5 w-1/2 rounded-full bg-droid-border/60" />
            </div>
          </div>
        </div>

        <div className="px-3.5 pb-3 pt-2.5">
          <div className="flex items-center gap-2">
            <span className="rounded bg-droid-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-droid-accent">
              New
            </span>
            <span className="text-[13.5px] font-semibold text-droid-text">Meet Notes</span>
          </div>
          <p className="mt-1 text-[12px] leading-snug text-droid-text-muted">
            Write reminders in the pad below while you work, then click a saved note to drop it into
            the composer as a prompt.
          </p>
          <button
            type="button"
            onClick={onTry}
            className="mt-2.5 rounded-lg bg-droid-accent px-3 py-1.5 text-[12px] font-medium text-droid-bg transition-opacity hover:opacity-90"
          >
            Try it now
          </button>
        </div>

        <button
          type="button"
          aria-label="Dismiss"
          onClick={onClose}
          className="absolute right-2 top-2 rounded-md p-1 text-droid-text-muted transition-colors hover:bg-droid-hover hover:text-droid-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Caret pointing at the Notes card */}
      <span
        aria-hidden
        className="absolute -right-[5px] h-2.5 w-2.5 rotate-45 border-r border-t border-droid-border bg-droid-elevated"
        style={{ top: caretTop }}
      />
    </motion.div>
  );
}
