import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { MotionDuration, MotionTokens } from '../../types/bridge';

type EaseTuple = [number, number, number, number];

export interface MotionPreviewSpec {
  durationMs: number;
  durationLabel: string;
  ease: EaseTuple | 'linear';
  easingLabel: string;
  pressScale: number;
}

export function resolveReducedMotion(
  prefersReducedMotion: boolean,
  policy: MotionTokens['reducedMotion'],
): 'full' | 'reduced' | 'disabled' {
  if (!prefersReducedMotion) return 'full';
  return policy === 'disable' ? 'disabled' : 'reduced';
}

export function resolveMotionTargets(
  behavior: ReturnType<typeof resolveReducedMotion>,
  pressScale: number,
) {
  if (behavior === 'disabled') return { press: {}, lift: {}, enterY: 0 };
  if (behavior === 'reduced') {
    return { press: { opacity: 0.72 }, lift: { opacity: 0.72 }, enterY: 0 };
  }
  return {
    press: { scale: pressScale },
    lift: { y: -3, boxShadow: '0 12px 28px -8px rgba(0,0,0,0.6)' },
    enterY: 8,
  };
}

export function resolveMotionPreview(tokens: MotionTokens): MotionPreviewSpec {
  const duration = preferredValue(tokens.durations, ['element', 'micro']);
  const easing = preferredValue(tokens.easings, ['standard']) ?? 'linear';
  return {
    durationMs: midpoint(duration),
    durationLabel: formatDuration(duration),
    ease: parseEasing(easing),
    easingLabel: easing,
    pressScale: tokens.pressScale ?? 1,
  };
}

/** Live samples driven by the parsed `motion-tokens` block in MOTION.md. */
export default function MotionPreview({
  colors,
  motionTokens,
}: {
  colors?: Record<string, string>;
  motionTokens?: MotionTokens;
}) {
  const shouldReduceMotion = useReducedMotion();
  const accent = pick(colors, ['accent', 'brand', 'primary'], 'var(--droid-accent)');
  const surface = pick(colors, ['surface', 'elevated', 'card', 'panel'], 'var(--droid-surface)');
  const text = pick(colors, ['text', 'foreground', 'ink'], 'var(--droid-text)');
  const [replay, setReplay] = useState(0);

  if (!motionTokens) {
    return (
      <div className="rounded-xl border border-droid-border bg-droid-elevated/20 p-3 text-[11.5px] leading-relaxed text-droid-text-muted">
        MOTION.md has no executable motion tokens yet. Add a fenced{' '}
        <code className="text-droid-text-secondary">motion-tokens</code> block to preview its real
        timing here.
      </div>
    );
  }

  const spec = resolveMotionPreview(motionTokens);
  const reducedMotion = resolveReducedMotion(
    Boolean(shouldReduceMotion),
    motionTokens.reducedMotion,
  );
  const disablesMotion = reducedMotion === 'disabled';
  const targets = resolveMotionTargets(reducedMotion, spec.pressScale);
  const duration = disablesMotion ? 0 : spec.durationMs / 1000;
  const transition = { duration, ease: spec.ease };

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1 text-[9px] text-droid-text-muted">
        <span className="rounded-md bg-droid-elevated/55 px-1.5 py-1">{spec.durationLabel}</span>
        <span className="max-w-full truncate rounded-md bg-droid-elevated/55 px-1.5 py-1">
          {spec.easingLabel}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Cell label="Press">
          <motion.button
            whileTap={targets.press}
            transition={transition}
            className="rounded-lg px-3.5 py-1.5 text-[12px] font-medium"
            style={{ backgroundColor: accent, color: '#000' }}
          >
            Button
          </motion.button>
        </Cell>

        <Cell label="Lift">
          <motion.div
            whileHover={targets.lift}
            transition={transition}
            className="flex h-10 w-24 items-center justify-center rounded-lg border border-droid-border text-[11px]"
            style={{ backgroundColor: surface, color: text }}
          >
            Card
          </motion.div>
        </Cell>

        <Cell label="Enter">
          <div className="flex items-end gap-1" key={replay}>
            {[14, 22, 10, 18].map((height, index) => (
              <motion.span
                key={index}
                initial={{ opacity: 0, y: targets.enterY }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...transition, delay: shouldReduceMotion ? 0 : index * 0.04 }}
                className="w-2.5 rounded-sm"
                style={{ height, backgroundColor: accent }}
              />
            ))}
          </div>
        </Cell>

        <Cell label={motionTokens.reducedMotion === 'disable' ? 'Reduced: off' : 'Reduced: fade'}>
          <button
            onClick={() => {
              setReplay((value) => value + 1);
            }}
            className="rounded-md border border-droid-border px-2.5 py-1 text-[10px] text-droid-text-secondary hover:text-droid-text"
          >
            Replay
          </button>
        </Cell>
      </div>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-[76px] flex-col items-center justify-center gap-2 rounded-xl border border-droid-border bg-droid-elevated/20">
      {children}
      <span className="text-[9px] uppercase tracking-wider text-droid-text-muted">{label}</span>
    </div>
  );
}

function midpoint(value: MotionDuration | undefined): number {
  if (value === undefined) return 0;
  return Array.isArray(value) ? Math.round((value[0] + value[1]) / 2) : value;
}

function preferredValue<T>(values: Record<string, T>, names: string[]): T | undefined {
  for (const name of names) {
    const match = Object.entries(values).find(([key]) => key === name);
    if (match) return match[1];
  }
  return Object.values(values)[0];
}

function formatDuration(value: MotionDuration | undefined): string {
  if (value === undefined) return '0ms';
  return Array.isArray(value) ? `${String(value[0])}–${String(value[1])}ms` : `${String(value)}ms`;
}

function parseEasing(value: string): EaseTuple | 'linear' {
  const presets: Record<string, EaseTuple> = {
    ease: [0.25, 0.1, 0.25, 1],
    'ease-in': [0.42, 0, 1, 1],
    'ease-out': [0, 0, 0.58, 1],
    'ease-in-out': [0.42, 0, 0.58, 1],
  };
  if (value in presets) return presets[value];
  const match =
    /^cubic-bezier\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)$/.exec(
      value,
    );
  if (!match) return 'linear';
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function pick(
  colors: Record<string, string> | undefined,
  keys: string[],
  fallback: string,
): string {
  if (!colors) return fallback;
  for (const [name, value] of Object.entries(colors)) {
    if (keys.some((key) => name.toLowerCase().includes(key))) return value;
  }
  return fallback;
}
