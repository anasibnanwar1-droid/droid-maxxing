import { useState } from 'react';
import { motion } from 'framer-motion';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Live component examples that demonstrate the project's motion — a button that
 * presses, a card that lifts, a switch, and a staggered entrance — tinted by the
 * DNA palette so the motion contract is something you feel, not read.
 */
export default function MotionPreview({ colors }: { colors?: Record<string, string> }) {
  const accent = pick(colors, ['accent', 'brand', 'primary'], 'var(--droid-accent)');
  const surface = pick(colors, ['surface', 'elevated', 'card', 'panel'], 'var(--droid-surface)');
  const text = pick(colors, ['text', 'foreground', 'ink'], 'var(--droid-text)');
  const [on, setOn] = useState(true);
  const [replay, setReplay] = useState(0);

  return (
    <div className="grid grid-cols-2 gap-2">
      <Cell label="Press">
        <motion.button
          whileHover={{ filter: 'brightness(1.1)' }}
          whileTap={{ scale: 0.96 }}
          transition={{ duration: 0.14, ease: EASE }}
          className="rounded-lg px-3.5 py-1.5 text-[12px] font-medium"
          style={{ backgroundColor: accent, color: '#000' }}
        >
          Button
        </motion.button>
      </Cell>

      <Cell label="Lift">
        <motion.div
          whileHover={{ y: -3, boxShadow: '0 12px 28px -8px rgba(0,0,0,0.6)' }}
          transition={{ duration: 0.22, ease: EASE }}
          className="flex h-10 w-24 items-center justify-center rounded-lg border border-droid-border text-[11px]"
          style={{ backgroundColor: surface, color: text }}
        >
          Card
        </motion.div>
      </Cell>

      <Cell label="Toggle">
        <button
          onClick={() => {
            setOn((v) => !v);
          }}
          className="flex h-6 w-11 items-center rounded-full p-0.5 transition-colors"
          style={{ backgroundColor: on ? accent : 'rgba(255,255,255,0.12)' }}
        >
          <motion.span
            layout
            transition={{ type: 'spring', stiffness: 500, damping: 32 }}
            className="h-5 w-5 rounded-full bg-white shadow"
            style={{ marginLeft: on ? 'auto' : 0 }}
          />
        </button>
      </Cell>

      <Cell label="Enter">
        <div className="flex items-end gap-1" key={replay}>
          {[14, 22, 10, 18].map((h, i) => (
            <motion.span
              key={i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.3, ease: EASE }}
              className="w-2.5 rounded-sm"
              style={{ height: h, backgroundColor: accent }}
            />
          ))}
          <button
            onClick={() => {
              setReplay((r) => r + 1);
            }}
            className="ml-1 text-[10px] text-droid-text-muted transition-colors hover:text-droid-text-secondary"
          >
            replay
          </button>
        </div>
      </Cell>
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

/** First palette value whose role name matches one of `keys`. */
function pick(
  colors: Record<string, string> | undefined,
  keys: string[],
  fallback: string,
): string {
  if (!colors) return fallback;
  for (const [name, value] of Object.entries(colors)) {
    if (keys.some((k) => name.toLowerCase().includes(k))) return value;
  }
  return fallback;
}
