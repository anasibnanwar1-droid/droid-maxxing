import { motion } from 'framer-motion';
import { ModelIcon } from './ModelIcon';

const EASE = [0.16, 1, 0.3, 1] as const;

/*
 * MissionPixelBanner — reusable retro "LED board" design element.
 *
 * A dot-matrix headline + a pixel-fragment sweep + a slowly spinning Factory
 * mark. This was originally the "MISSION CONTROL" flourish in the bottom status
 * strip; it lives here on its own so it can be reused later (e.g. loading /
 * restoring states, or a "starting a droid" splash).
 *
 * NOTE: intentionally NOT wired into any screen right now. Drop
 * <MissionPixelBanner text="…" /> wherever a lively accent moment is wanted, or
 * reuse the exported DotMatrix / PixelSweep pieces on their own. Bump
 * `sweepTrigger` (a changing number) to replay the sweep, e.g. on hover.
 */

/* dot-matrix / LED-board text: a dot grid clipped to the letterforms */
export function DotMatrix({ text }: { text: string }) {
  return (
    <span
      className="font-mono font-black uppercase leading-none"
      style={{
        fontSize: '17px',
        letterSpacing: '0.42em',
        paddingLeft: '0.42em',
        backgroundImage: 'radial-gradient(var(--droid-accent) 44%, transparent 48%)',
        backgroundSize: '3px 3px',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        color: 'transparent',
      }}
    >
      {text}
    </span>
  );
}

/* Blocky pixel-fragment sweep that flies across once, left → right. `trigger`
   is a changing key that restarts the animation. */
export function PixelSweep({ trigger }: { trigger: number }) {
  return (
    <motion.div
      key={trigger}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
    >
      {/* soft accent wash */}
      <motion.div
        className="absolute inset-y-0 w-1/3"
        initial={{ x: '-120%' }}
        animate={{ x: '360%' }}
        transition={{ duration: 0.85, ease: EASE }}
        style={{
          background:
            'linear-gradient(90deg, transparent, color-mix(in srgb, var(--droid-accent) 38%, transparent), transparent)',
        }}
      />
      {/* white pixel fragments riding the leading edge */}
      <motion.div
        className="absolute inset-y-0 flex items-center gap-[3px]"
        initial={{ x: '-40%' }}
        animate={{ x: '108%' }}
        transition={{ duration: 0.85, ease: EASE }}
      >
        {Array.from({ length: 7 }).map((_, i) => (
          <motion.span
            key={i}
            className="block rounded-[1px] bg-white"
            style={{ width: 3 + (i % 3), height: 3 + (i % 3) }}
            initial={{ opacity: 0.9, y: (i % 2 ? -1 : 1) * (4 + i) }}
            animate={{ opacity: 0, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05 * i, ease: 'easeOut' }}
          />
        ))}
      </motion.div>
    </motion.div>
  );
}

/* Composed banner: spinning mark + dot-matrix label over a pixel sweep. */
export default function MissionPixelBanner({
  text = 'MISSION CONTROL',
  sweepTrigger = 0,
}: {
  text?: string;
  sweepTrigger?: number;
}) {
  return (
    <div className="relative flex items-center justify-center gap-3 overflow-hidden">
      <PixelSweep trigger={sweepTrigger} />
      <motion.span
        className="flex"
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.5, ease: EASE }}
      >
        <span className="flex animate-[spin_9s_linear_infinite]">
          <ModelIcon provider="factory" size={15} />
        </span>
      </motion.span>
      <motion.div
        initial={{ clipPath: 'inset(0 100% 0 0)' }}
        animate={{ clipPath: 'inset(0 0% 0 0)' }}
        transition={{ duration: 0.7, ease: EASE, delay: 0.08 }}
      >
        <DotMatrix text={text} />
      </motion.div>
    </div>
  );
}
