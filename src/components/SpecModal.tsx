import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, FileText } from 'lucide-react';
import { SpecRenderer } from './SpecRenderer';
import { SpecOutline, useSpecOutline } from './SpecOutline';

const EASE = [0.16, 1, 0.3, 1] as const;

function useActiveHeading(scrollRef: React.RefObject<HTMLDivElement | null>, headingIds: string[]) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || headingIds.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { root: container, rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );

    headingIds.forEach((id) => {
      const el = container.querySelector(`#${CSS.escape(id)}`);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [scrollRef, headingIds]);

  return activeId;
}

export function SpecModal({
  content,
  title,
  open,
  onClose,
}: {
  content: string;
  title?: string;
  open: boolean;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const outline = useSpecOutline(open ? content : '');
  const headingIds = useMemo(() => outline.map((h) => h.id), [outline]);
  const activeId = useActiveHeading(scrollRef, headingIds);

  const scrollTo = useCallback((id: string) => {
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector(`#${CSS.escape(id)}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  // Reset search on open
  useEffect(() => {
    if (open) setSearchQuery('');
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:p-6"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.3, ease: EASE }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[1120px] h-[88vh] flex flex-col rounded-2xl border border-droid-border bg-droid-surface shadow-2xl shadow-black/60 overflow-hidden"
          >
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-5 h-12 border-b border-droid-border">
              <div className="flex items-center gap-2.5 min-w-0">
                <FileText className="w-4 h-4 shrink-0 text-droid-text-muted" />
                <span className="text-[13px] font-medium text-droid-text truncate">
                  {title || 'Specification'}
                </span>
                {outline.length > 0 && (
                  <span className="text-[10px] font-mono text-droid-text-muted/70 ml-1">
                    {outline.length} sections
                  </span>
                )}
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
              {/* Document */}
              <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto overflow-x-hidden scroll-smooth"
              >
                <div className="max-w-4xl mx-auto px-10 py-10 min-h-full">
                  {content ? (
                    <SpecRenderer content={content} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-[13px] text-droid-text-muted">
                      No spec content available.
                    </div>
                  )}
                </div>
              </div>

              {/* Outline */}
              <SpecOutline
                headings={outline}
                activeId={activeId}
                onSelect={scrollTo}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
              />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
