import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export function HoverTooltip({
  label,
  children,
  placement = 'top',
  delay = 350,
}: {
  label: string;
  children: ReactNode;
  placement?: 'top' | 'bottom';
  delay?: number;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const showSoon = useCallback(() => {
    cancelTimer();
    timerRef.current = window.setTimeout(() => {
      setOpen(true);
      timerRef.current = null;
    }, delay);
  }, [cancelTimer, delay]);

  const hide = useCallback(() => {
    cancelTimer();
    setOpen(false);
    setPosition(null);
  }, [cancelTimer]);

  useEffect(() => cancelTimer, [cancelTimer]);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const tooltip = tooltipRef.current;
      if (!anchor || !tooltip) return;

      const gap = 6;
      const edge = 8;
      const left = Math.min(
        window.innerWidth - tooltip.offsetWidth - edge,
        Math.max(edge, anchor.left + anchor.width / 2 - tooltip.offsetWidth / 2),
      );
      const preferredTop =
        placement === 'top' ? anchor.top - tooltip.offsetHeight - gap : anchor.bottom + gap;
      const top = Math.min(
        window.innerHeight - tooltip.offsetHeight - edge,
        Math.max(edge, preferredTop),
      );
      setPosition({ left, top });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, placement]);

  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex shrink-0"
        aria-describedby={open ? id : undefined}
        onMouseEnter={showSoon}
        onMouseLeave={hide}
        onPointerDownCapture={hide}
        onFocusCapture={() => {
          cancelTimer();
          setOpen(true);
        }}
        onBlurCapture={hide}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={tooltipRef}
            id={id}
            role="tooltip"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              opacity: position ? 1 : 0,
            }}
            className="pointer-events-none fixed z-[200] max-w-[280px] rounded-md border border-droid-border bg-droid-elevated px-2 py-1 text-center text-[11px] font-medium leading-4 text-droid-text shadow-xl transition-opacity"
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
