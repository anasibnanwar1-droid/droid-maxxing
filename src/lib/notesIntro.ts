// Geometry for the floating "what's new" intro: it sits to the left of the
// context bar (the panel's scroll container clips anything absolutely
// positioned past its edge, so the card is portaled to the body and fixed to
// the Notes card's rect), with a caret pointing back at the card.
export const INTRO_WIDTH = 280;
export const INTRO_GAP = 14;

export function notesIntroPosition(
  anchor: { top: number; left: number; height: number },
  viewportHeight: number,
): { top: number; left: number; caretTop: number } {
  const left = Math.max(8, anchor.left - INTRO_WIDTH - INTRO_GAP);
  // Keep the ~250px tall card on screen when the anchor hugs the viewport bottom.
  const top = Math.min(Math.max(12, anchor.top + 2), Math.max(12, viewportHeight - 262));
  const caretTop = Math.min(Math.max(anchor.top + anchor.height / 2 - top, 14), 218);
  return { top, left, caretTop };
}
