import { motion } from 'framer-motion';
/**
 * Shown on a fresh canvas. The canvas stays visually quiet and points to the two
 * real entry points: the agent composer and an existing live route.
 */
export default function CanvasEmptyState({ onAddFrame }: { onAddFrame: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="pointer-events-auto flex max-w-md flex-col items-center px-6 text-center"
      >
        <div className="mb-4 text-[11.5px] font-medium text-droid-text-muted">Ready to design</div>
        <h2 className="text-balance text-[20px] font-medium tracking-[-0.025em] text-droid-text">
          What would you like to design?
        </h2>
        <p className="mt-2 max-w-[390px] text-pretty text-[13px] leading-relaxed text-droid-text-muted">
          Describe the change in the agent panel, or add a route from your running product to work
          directly on what already ships.
        </p>
        <button
          onClick={onAddFrame}
          className="mt-6 rounded-lg bg-droid-accent px-4 py-2 text-[12.5px] font-medium text-droid-bg transition-opacity hover:opacity-85 active:translate-y-px"
        >
          Add a live page
        </button>
      </motion.div>
    </div>
  );
}
