import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../hooks/useStore';
import { useMissionLive } from '../hooks/useMissionLive';
import { SpecRenderer } from './SpecRenderer';
import { SpecOutline, useSpecOutline } from './SpecOutline';
import { GripVertical, Search } from 'lucide-react';

const EASE = [0.16, 1, 0.3, 1] as const;

function ChatHeader({ title, live }: { title: string; live: boolean }) {
  return (
    <div
      data-electron-drag-region
      className="shrink-0 flex items-center h-9 pr-4 pl-4"
    >
      <div className="flex min-w-0 items-center gap-2 rounded-xl bg-droid-elevated/60 pl-2 pr-3 py-1.5">
        <GripVertical className="w-3.5 h-3.5 shrink-0 text-droid-text-muted/40" />
        <span className={`truncate text-[13px] font-medium max-w-[240px] ${live ? 'shimmer-text' : 'text-droid-text'}`}>{title}</span>
      </div>
    </div>
  );
}

function useActiveHeading(scrollRef: React.RefObject<HTMLDivElement | null>, headingIds: string[]) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || headingIds.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the heading closest to the top that is visible
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { root: container, rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    );

    headingIds.forEach((id) => {
      const el = container.querySelector(`#${CSS.escape(id)}`);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [scrollRef, headingIds]);

  return activeId;
}

export default function SpecCanvas() {
  const { state } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const allTranscript = activeMission ? state.transcripts[activeMission.id] ?? [] : [];
  const live = useMissionLive(activeMission?.id ?? null);

  // Combine all model spec messages into one document
  const specContent = useMemo(() => {
    const modelMessages = allTranscript.filter((t) => t.author !== 'user' && t.kind === 'text');
    return modelMessages.map((m) => m.text ?? '').join('\n\n---\n\n');
  }, [allTranscript]);

  const outline = useSpecOutline(specContent);
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

  // Keep scroll at bottom while streaming
  useEffect(() => {
    if (!scrollRef.current || !live) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [specContent.length, live]);

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
      {activeMission && <ChatHeader title={activeMission.title} live={live} />}

      {/* Spec mode badge */}
      <div className="shrink-0 flex items-center justify-between px-8 py-2 border-b border-droid-border">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium tracking-widest uppercase text-droid-orange">Spec Mode</span>
          {live && <span className="shimmer-text text-[10px] font-medium">Generating…</span>}
        </div>
        {outline.length > 0 && (
          <span className="text-[10px] text-droid-text-muted font-mono">
            {outline.length} sections
          </span>
        )}
      </div>

      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
        {/* Document area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden scroll-smooth">
          <div className="max-w-3xl mx-auto px-8 py-10 min-h-full">
            {specContent ? (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: EASE }}
              >
                <SpecRenderer content={specContent} />
              </motion.div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-droid-elevated/50 border border-droid-border flex items-center justify-center">
                  <Search className="w-5 h-5 text-droid-text-muted" />
                </div>
                <p className="text-[13px] text-droid-text-muted">
                  {live ? 'Composing specification…' : 'No spec content yet.'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Outline sidebar */}
        <SpecOutline
          headings={outline}
          activeId={activeId}
          onSelect={scrollTo}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
      </div>
    </div>
  );
}
