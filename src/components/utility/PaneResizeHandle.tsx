import { useEffect, useRef } from 'react';

export function PaneResizeHandle({
  width,
  min,
  max,
  onResize,
  onResizeEnd,
}: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number; latest: number } | null>(null);
  const frame = useRef(0);

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)));
  const schedule = (value: number) => {
    if (drag.current) drag.current.latest = value;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (drag.current) onResize(drag.current.latest);
    });
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize utility pane"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      className="group absolute left-0 top-0 z-30 h-full w-3 cursor-col-resize focus:outline-none"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = clamp(width + (event.key === 'ArrowLeft' ? 20 : -20));
        onResize(next);
        onResizeEnd(next);
      }}
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, width, latest: width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        schedule(clamp(drag.current.width + drag.current.x - event.clientX));
      }}
      onPointerUp={(event) => {
        const latest = drag.current?.latest;
        drag.current = null;
        if (frame.current) {
          cancelAnimationFrame(frame.current);
          frame.current = 0;
        }
        if (latest !== undefined) {
          onResize(latest);
          onResizeEnd(latest);
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
    >
      <div className="absolute left-0 top-0 h-full w-px bg-droid-border-hover/60 transition-colors group-hover:bg-droid-accent/70 group-focus:bg-droid-accent" />
      <div className="absolute left-1 top-1/2 h-12 w-1 -translate-y-1/2 rounded-full bg-droid-border-hover/70 opacity-70 transition-colors group-hover:bg-droid-accent group-focus:bg-droid-accent" />
    </div>
  );
}
