import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { ConversationAnchor } from './chat';

/**
 * A quiet navigation rail in the chat's left gutter: one dot per model final
 * response (the summary of each turn). The dot list is derived from transcript
 * data (so it always matches the feed), while scrolling and the "you are here"
 * highlight resolve the rendered row by its `data-anchor-id`. Hovering previews
 * the response; clicking scrolls it to the top, with the follow-up prompt just
 * below it.
 */
export function ConversationTimeline({
  scrollRef,
  anchors,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  anchors: ConversationAnchor[];
}) {
  const [activeId, setActiveId] = useState<string | null>(null);

  // Highlight the response nearest the top of the viewport as the user scrolls.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || anchors.length === 0) return undefined;
    const els = anchors
      .map((a) => root.querySelector<HTMLElement>(`[data-anchor-id="${CSS.escape(a.id)}"]`))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActiveId((top.target as HTMLElement).dataset.anchorId ?? null);
      },
      { root, rootMargin: '0px 0px -65% 0px', threshold: 0 },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [scrollRef, anchors]);

  if (anchors.length < 2) return null;

  const jump = (id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-anchor-id="${CSS.escape(id)}"]`,
    );
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="pointer-events-none absolute left-1 top-1/2 z-10 hidden -translate-y-1/2 lg:block">
      <div className="no-scrollbar pointer-events-auto flex max-h-[68vh] flex-col items-start gap-2.5 overflow-y-auto py-1 pl-2 pr-3">
        {anchors.map((a) => {
          const active = a.id === activeId;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => jump(a.id)}
              className="group/dot relative flex items-center"
              title={a.label}
              aria-label={a.label}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all duration-200 ${
                  active
                    ? 'scale-110 bg-droid-text-secondary'
                    : 'bg-droid-text-muted/35 group-hover/dot:bg-droid-text-muted/80'
                }`}
              />
              <span className="pointer-events-none absolute left-4 block max-w-[200px] translate-x-1 truncate rounded-md bg-droid-elevated px-2 py-1 text-[11px] text-droid-text-secondary opacity-0 shadow-sm ring-1 ring-droid-border/60 transition-all duration-150 group-hover/dot:translate-x-0 group-hover/dot:opacity-100">
                {a.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
