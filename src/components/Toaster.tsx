import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { dismissToast, subscribeToasts, type ToastItem, type ToastVariant } from '../lib/toast';

const ICON: Record<ToastVariant, React.ElementType> = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
};

const ACCENT: Record<ToastVariant, string> = {
  success: '#3fb950',
  error: '#f85149',
  info: 'var(--droid-accent)',
};

export default function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  // Anchored bottom-right, clear of the centered composer and the status bar so
  // notifications stay fully visible. Newest sits closest to the corner.
  return (
    <div className="pointer-events-none fixed bottom-11 right-4 z-[200] flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICON[t.variant];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 16, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 16, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              style={{ borderLeftColor: ACCENT[t.variant] }}
              className="pointer-events-auto flex min-w-[240px] max-w-[380px] items-center gap-2.5 rounded-lg border border-droid-border-hover border-l-2 bg-droid-elevated px-3 py-2.5 shadow-xl shadow-black/40"
            >
              <Icon
                className="h-4 w-4 shrink-0"
                style={{ color: ACCENT[t.variant] }}
                strokeWidth={2.25}
              />
              <span className="min-w-0 flex-1 text-[13px] leading-snug text-droid-text">
                {t.message}
              </span>
              <button
                onClick={() => dismissToast(t.id)}
                className="-mr-1 shrink-0 rounded-md p-1 text-droid-text-muted transition-colors hover:bg-droid-surface hover:text-droid-text"
                title="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
