import { useEffect, useRef, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Search, X } from 'lucide-react';

// Shared chrome for the command-palette overlays (⌘K command palette,
// sidebar session search): backdrop, animated panel, search input row, and
// the keyboard-hint footer. Consumers own their state, filtering, and result
// rows (rendered as children) via usePaletteNavigation.
export default function PaletteShell({
  onClose,
  query,
  onQueryChange,
  onKeyDown,
  placeholder,
  inputAriaLabel,
  enterHint,
  footerRight,
  children,
}: {
  onClose: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  placeholder: string;
  inputAriaLabel: string;
  enterHint: string;
  footerRight: string;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[560px] bg-droid-elevated border border-droid-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-droid-border">
          <Search className="w-4 h-4 text-droid-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              onQueryChange(e.target.value);
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={inputAriaLabel}
            className="flex-1 bg-transparent text-sm text-droid-text placeholder-droid-text-muted focus:outline-none"
          />
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="p-1 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-surface transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div className="py-2 max-h-[400px] overflow-y-auto">{children}</div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-droid-border bg-droid-surface/50">
          <div className="flex items-center gap-3 text-[10px] text-droid-text-muted">
            <span className="flex items-center gap-1">
              <span className="px-1 py-0.5 rounded bg-droid-elevated border border-droid-border font-mono text-[9px]">
                ↑↓
              </span>
              Navigate
            </span>
            <span className="flex items-center gap-1">
              <span className="px-1 py-0.5 rounded bg-droid-elevated border border-droid-border font-mono text-[9px]">
                ↵
              </span>
              {enterHint}
            </span>
          </div>
          <div className="text-[10px] text-droid-text-muted">{footerRight}</div>
        </div>
      </motion.div>
    </motion.div>
  );
}
