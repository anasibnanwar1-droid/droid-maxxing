import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import {
  dismissToast,
  pauseToast,
  resumeToast,
  subscribeToasts,
  type ToastItem,
  type ToastVariant,
} from '../lib/toast';

const DOT: Record<ToastVariant, string> = {
  success: 'var(--droid-green)',
  error: 'var(--droid-red)',
  info: 'var(--droid-accent)',
};

// Minimal pro toast: uniform hairline border (no side accent bars), a small
// status dot, a close button revealed on hover, and a 2px TTL hairline along
// the bottom edge that drains as the toast ages. Hovering pauses the countdown.
export default function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  // Anchored bottom-right, clear of the centered composer and the status bar so
  // notifications stay fully visible. Newest sits closest to the corner. Sits
  // above popovers (z-[1100]) so a toast fired while a menu is open stays visible.
  return (
    <div className="pointer-events-none fixed bottom-11 right-4 z-[1100] flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 500, damping: 32 }}
            onMouseEnter={() => {
              pauseToast(t.id);
            }}
            onMouseLeave={() => {
              resumeToast(t.id);
            }}
            className="group pointer-events-auto relative min-w-[240px] max-w-[380px] overflow-hidden rounded-xl border border-droid-border bg-droid-elevated/95 shadow-lg shadow-black/25 backdrop-blur-sm"
          >
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: DOT[t.variant] }}
              />
              <span className="min-w-0 flex-1 text-[13px] leading-snug text-droid-text">
                {t.message}
              </span>
              <button
                onClick={() => {
                  dismissToast(t.id);
                }}
                className="-mr-1 shrink-0 rounded-md p-1 text-droid-text-muted opacity-0 transition-all hover:bg-droid-surface hover:text-droid-text group-hover:opacity-100"
                title="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {t.ttl > 0 && (
              <span
                aria-hidden="true"
                className="droid-toast-ttl absolute bottom-0 left-0 h-[2px] w-full origin-left"
                style={{ background: DOT[t.variant], animationDuration: `${String(t.ttl)}ms` }}
              />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
