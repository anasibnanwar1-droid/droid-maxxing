import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { ConversationAnchor } from './chat';

/**
 * A quiet navigation rail in the chat's left gutter: one dot per user prompt.
 * The dot list is derived from transcript data (so it always matches the feed),
 * while scrolling and the "you are here" highlight resolve the rendered row by
 * its `data-anchor-id`. Hovering previews the prompt; clicking scrolls it to the
 * top. The preview is positioned with fixed coordinates measured from the dot so
 * it escapes the rail's scroll clipping instead of being cut off.
 */
export function ConversationTimeline({
  scrollRef,
  anchors,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  anchors: ConversationAnchor[];
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ label: string; top: number; left: number } | null>(null);

  // Highlight the prompt nearest the top of the viewport as the user scrolls.
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
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setHover({ label: a.label, top: r.top + r.height / 2, left: r.right + 8 });
              }}
              onMouseLeave={() => setHover(null)}
              className="group/dot flex items-center py-0.5"
              aria-label={a.label}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all duration-200 ${
                  active
                    ? 'scale-125 bg-droid-text-secondary'
                    : 'bg-droid-text-muted/35 group-hover/dot:bg-droid-text-muted/80'
                }`}
              />
            </button>
          );
        })}
      </div>
      {hover && (
        <div
          className="pointer-events-none fixed z-50 max-w-[300px] -translate-y-1/2 overflow-hidden whitespace-pre-line rounded-md bg-droid-elevated px-2.5 py-1.5 text-[11px] leading-snug text-droid-text-secondary shadow-md ring-1 ring-droid-border/60"
          style={{ top: hover.top, left: hover.left }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}
