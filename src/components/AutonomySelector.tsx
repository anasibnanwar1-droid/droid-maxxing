import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Loader2 } from 'lucide-react';

import type { Autonomy } from '../types/bridge';
import { AUTONOMY_DESCRIPTIONS, AUTONOMY_LABELS, AUTONOMY_LEVELS } from '../lib/autonomy';

export type AutonomyScope = 'draft' | 'session' | 'settings';

const SCOPE_CAPTIONS: Record<AutonomyScope, string> = {
  draft: 'Applies to this new session',
  session: 'This session',
  settings: 'Default for new sessions',
};

const POPOVER_OFFSET_Y = { up: 8, down: -8 } as const;
const POPOVER_PLACEMENT_CLASS = {
  up: 'bottom-full mb-2',
  down: 'top-full mt-2',
} as const;
const POPOVER_ALIGN_CLASS = { start: 'left-0', end: 'right-0' } as const;

// The one autonomy control: a compact pill that opens the four levels with
// their consequences. Controlled — the parent owns the value and the command
// that a selection triggers (draft state, live session update, or the
// persisted default). While `pending`, the pill keeps showing the last
// confirmed level and blocks further interaction until the provider settles.
export default function AutonomySelector({
  scope,
  value,
  pending = false,
  disabled = false,
  onSelect,
  placement = 'up',
  align = 'end',
}: {
  scope: AutonomyScope;
  value: Autonomy;
  pending?: boolean;
  disabled?: boolean;
  onSelect: (level: Autonomy) => void;
  placement?: 'up' | 'down';
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Closing via Escape must return keyboard focus to the pill.
      buttonRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const inactive = disabled || pending;
  const title = pending
    ? 'Updating autonomy…'
    : `${AUTONOMY_LABELS[value]} autonomy — ${AUTONOMY_DESCRIPTIONS[value]}`;

  let tone = 'text-droid-text-secondary hover:text-droid-text hover:bg-droid-bg/40';
  if (open) tone = 'bg-droid-bg/60 text-droid-text';
  else if (inactive) tone = 'text-droid-text-muted/60 cursor-not-allowed';

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        disabled={inactive}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={pending}
        aria-label={`Autonomy: ${AUTONOMY_LABELS[value]}`}
        title={title}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] transition-colors ${tone}`}
      >
        {pending && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />}
        <span>{AUTONOMY_LABELS[value]}</span>
        <ChevronDown
          className={`w-3 h-3 shrink-0 text-droid-text-muted/40 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: POPOVER_OFFSET_Y[placement], scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: POPOVER_OFFSET_Y[placement], scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className={`absolute z-50 w-[300px] ${POPOVER_PLACEMENT_CLASS[placement]} ${POPOVER_ALIGN_CLASS[align]}`}
          >
            <AutonomyMenu
              scope={scope}
              value={value}
              onSelect={(level) => {
                if (level !== value) onSelect(level);
                setOpen(false);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// The level menu panel: header caption plus every level with its consequence
// description. Exported on its own so the menu content is testable without
// opening the popover.
export function AutonomyMenu({
  scope,
  value,
  onSelect,
}: {
  scope: AutonomyScope;
  value: Autonomy;
  onSelect: (level: Autonomy) => void;
}) {
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const moveFocus = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const options = optionRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    if (options.length === 0) return;
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? options[(index + 1) % options.length]
        : options[(index - 1 + options.length) % options.length];
    next.focus();
  };

  return (
    <div
      role="menu"
      aria-label="Autonomy"
      onKeyDown={moveFocus}
      className="rounded-2xl border border-droid-border bg-droid-elevated shadow-2xl shadow-black/50 overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-[11px] font-medium text-droid-text-secondary tracking-wide">
          Autonomy
        </span>
        <span className="text-[10px] text-droid-text-muted">{SCOPE_CAPTIONS[scope]}</span>
      </div>
      <div className="px-2 pb-2 space-y-0.5">
        {AUTONOMY_LEVELS.map((level, i) => {
          const selected = level === value;
          return (
            <button
              key={level}
              type="button"
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              role="menuitemradio"
              aria-checked={selected}
              autoFocus={selected}
              onClick={() => {
                onSelect(level);
              }}
              className={`w-full px-2.5 py-2 rounded-lg text-left transition-colors ${
                selected ? 'bg-droid-surface' : 'hover:bg-droid-surface/60'
              }`}
            >
              <span
                className={`block text-[12px] ${selected ? 'font-medium' : ''} text-droid-text`}
              >
                {AUTONOMY_LABELS[level]}
              </span>
              <span className="block text-[10px] text-droid-text-muted leading-snug">
                {AUTONOMY_DESCRIPTIONS[level]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
