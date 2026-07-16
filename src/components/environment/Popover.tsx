import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
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
  label,
  align = 'right',
  width = 288,
  className = '',
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label?: string;
  align?: 'left' | 'right';
  width?: number;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    maxHeight: number;
  } | null>(null);
  // Drives the enter transition: mount at opacity-0/scale-95, then flip on the
  // next frame so the CSS transition has a starting state to animate from.
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // If focus is inside the panel when it closes (Escape from the search input,
  // an activated row unmounting), it would fall to <body>; hand it back to the
  // trigger instead. React clears panelRef and unmounts the portal before this
  // cleanup runs, so containment can't be checked at teardown: track it live
  // via focusin while the panel is open. A close by outside-click moves focus
  // to the clicked target (or <body>) before cleanup, so it clears the flag and
  // does not steal focus back.
  const focusInsideRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    const track = () => {
      focusInsideRef.current = !!panelRef.current?.contains(document.activeElement);
    };
    track();
    document.addEventListener('focusin', track);
    const anchor = anchorRef.current;
    return () => {
      document.removeEventListener('focusin', track);
      if (focusInsideRef.current) anchor?.focus();
      focusInsideRef.current = false;
    };
  }, [open, anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
    const margin = 8;
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const rawLeft = align === 'right' ? r.right - width : r.left;
      const left = Math.min(Math.max(margin, rawLeft), window.innerWidth - width - margin);
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      // Flip above the anchor when there isn't enough room below (e.g. the
      // composer pickers sit at the bottom of the window).
      // Cap maxHeight to the room actually available on the chosen side (never a
      // fixed floor that could exceed it) so the panel is never pushed partly
      // off-screen; its content scrolls within whatever space remains.
      if (spaceBelow < 240 && spaceAbove > spaceBelow) {
        setPos({
          bottom: window.innerHeight - r.top + 4,
          left,
          maxHeight: Math.max(0, spaceAbove),
        });
      } else {
        setPos({ top: r.bottom + 4, left, maxHeight: Math.max(0, spaceBelow) });
      }
    };
    update();
    // The capture-phase scroll listener fires for every scrollable container
    // (including the diff panel); coalesce to one reposition per frame so
    // scrolling with a popover open doesn't run rect reads per scroll event.
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
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

  // The portal escapes the trigger's DOM order, so Tab would otherwise walk
  // out of the open panel into whatever follows <body>; wrap focus instead.
  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label ?? 'Menu'}
      onKeyDown={trapTab}
      style={{
        position: 'fixed',
        top: pos.top,
        bottom: pos.bottom,
        left: pos.left,
        width,
        maxHeight: pos.maxHeight,
        transformOrigin: pos.top !== undefined ? 'top' : 'bottom',
      }}
      className={`z-[1000] flex flex-col overflow-hidden rounded-xl border border-droid-border bg-droid-surface shadow-2xl shadow-black/50 transition-[opacity,transform] duration-150 ease-out ${
        entered ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
      } ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
