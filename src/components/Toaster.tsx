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
  success: '#6f8f6f',
  error: '#c2664a',
  info: 'var(--droid-text-secondary)',
};

export default function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICON[t.variant];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-droid-border bg-droid-elevated px-3.5 py-2 shadow-2xl shadow-black/50"
            >
              <Icon className="w-4 h-4 shrink-0" style={{ color: ACCENT[t.variant] }} />
              <span className="text-[12.5px] text-droid-text">{t.message}</span>
              <button
                onClick={() => dismissToast(t.id)}
                className="ml-1 shrink-0 rounded-md p-0.5 text-droid-text-muted hover:text-droid-text hover:bg-droid-surface/60 transition-colors"
                title="Dismiss"
              >
                <X className="w-3 h-3" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
