import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

// A dropdown panel rendered into <body> via a portal so it escapes the Context
// panel's `overflow` clipping. It stays anchored to its trigger and reflows on
// scroll/resize, and clamps to the viewport so it is never cropped.
export function Popover({
  open,
  onClose,
  anchorRef,
  align = 'right',
  width = 288,
  className = '',
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  width?: number;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const margin = 8;
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const rawLeft = align === 'right' ? r.right - width : r.left;
      const left = Math.min(Math.max(margin, rawLeft), window.innerWidth - width - margin);
      const top = r.bottom + 4;
      const maxHeight = Math.max(160, window.innerHeight - top - margin);
      setPos({ top, left, maxHeight });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, anchorRef, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={panelRef}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width, maxHeight: pos.maxHeight }}
      className={`z-[1000] flex flex-col overflow-hidden rounded-xl border border-droid-border bg-droid-surface shadow-2xl shadow-black/50 ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
