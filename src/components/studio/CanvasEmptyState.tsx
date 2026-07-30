import { motion } from 'framer-motion';
/**
 * Shown on a fresh canvas. The canvas stays visually quiet and points to the two
 * real entry points: the agent composer and an existing live route.
 */
export default function CanvasEmptyState({
  onAddFrame,
  onAddImage,
}: {
  onAddFrame: () => void;
  onAddImage: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="pointer-events-auto flex max-w-md flex-col items-center px-6 text-center"
      >
        <h2 className="text-balance text-[20px] font-medium tracking-[-0.025em] text-droid-text">
          Start with a page or an image
        </h2>
        <p className="mt-2 max-w-[390px] text-pretty text-[13px] leading-relaxed text-droid-text-muted">
          Add a live route, or paste visual references anywhere to build a moodboard the agent can
          understand.
        </p>
        <div className="mt-6 flex items-center gap-2">
          <button
            onClick={onAddFrame}
            className="rounded-lg bg-droid-accent px-4 py-2 text-[12.5px] font-medium text-droid-bg transition-opacity hover:opacity-85 active:translate-y-px"
          >
            Add a live page
          </button>
          <button
            onClick={onAddImage}
            className="rounded-lg border border-droid-border bg-droid-surface px-4 py-2 text-[12.5px] font-medium text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
          >
            Add an image
          </button>
        </div>
        <div className="mt-3 text-[10.5px] text-droid-text-muted">You can also paste with ⌘V</div>
      </motion.div>
    </div>
  );
}
