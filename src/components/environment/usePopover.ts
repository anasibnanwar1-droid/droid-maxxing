import { useEffect, useRef } from 'react';

// Module-level Escape stack: when nested popovers are open (e.g. a base-branch
// picker rendered inside a CreatePrSheet that itself lives in a ReviewPanel
// Popover), each layer pushes its onClose here. Escape closes only the topmost
// (most-recently-opened) layer so a keystroke never fires two layers at once
// and discards the user's in-progress input. A single capture-phase window
// listener consumes the event, so individual layers never need their own
// per-instance Escape listeners (which would race on listener registration
// order — addEventListener on window runs in registration order in both
// phases, so neither stopImmediatePropagation nor capture/bubble splitting can
// reliably make the innermost layer win; the LIFO stack does).
const escapeStack: Array<() => void> = [];

function consumeEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return;
  // Stop other window/document Escape listeners (e.g. command palette,
  // modals, per-panel React onKeyDown handlers) from also firing on this
  // keystroke so only the topmost layer closes.
  e.stopImmediatePropagation();
  e.preventDefault();
  top();
}

if (typeof window !== 'undefined') {
  // Capture phase: runs before any bubble-phase Escape handlers registered
  // elsewhere (e.g. React onKeyDown on the panel itself).
  window.addEventListener('keydown', consumeEscape, true);
}

// Push a close handler onto the Escape stack. Returns a cleanup that removes
// the most recent occurrence (lastIndexOf, not indexOf, so a StrictMode
// double-push correctly removes the latest copy and leaves any genuine
// duplicate in place).
export function pushEscapeLayer(onClose: () => void): () => void {
  escapeStack.push(onClose);
  return () => {
    const i = escapeStack.lastIndexOf(onClose);
    if (i >= 0) escapeStack.splice(i, 1);
  };
}

// Close a popover on outside click or Escape, returning the ref to attach to the
// popover's outer container. Shared so every VCS menu behaves identically.
export function usePopover<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const pop = pushEscapeLayer(onClose);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('mousedown', onDown);
      pop();
    };
  }, [open, onClose]);
  return ref;
}
