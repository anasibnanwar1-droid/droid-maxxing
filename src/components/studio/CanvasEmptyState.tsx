import { motion } from 'framer-motion';
import StudioMark from './StudioMark';

/**
 * Shown on a fresh canvas — an invitation to design, not a form. Points at both
 * ways in: describe a design to the agent (left composer) or drop in a live URL.
 */
export default function CanvasEmptyState({ onAddFrame }: { onAddFrame: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="pointer-events-auto flex max-w-sm flex-col items-center text-center"
      >
        <div className="relative mb-7">
          <div className="absolute -inset-10 rounded-full bg-[#ee6018]/12 blur-3xl" />
          <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-droid-border bg-gradient-to-b from-white/[0.08] to-transparent">
            <StudioMark className="h-8 w-8 text-droid-text-secondary" />
          </div>
        </div>
        <h2 className="text-[17px] font-medium tracking-tight text-droid-text">
          A canvas for directions, not documents
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-droid-text-muted">
          Describe a screen in the composer and the agent designs it into a live frame — or drop
          in a running route to start from what already ships.
        </p>
        <button
          onClick={onAddFrame}
          className="mt-6 rounded-lg border border-droid-border bg-white/[0.04] px-4 py-2 text-[13px] text-droid-text transition-colors hover:border-[#ee6018]/50 hover:bg-[#ee6018]/[0.08] hover:text-droid-text"
        >
          Add a live frame
        </button>
        <div className="mt-4 font-mono text-[11px] text-droid-text-muted">
          ⌘⇧D to toggle · space-drag to pan · ⌘-scroll to zoom
        </div>
      </motion.div>
    </div>
  );
}
