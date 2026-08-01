import test from 'node:test';
import assert from 'node:assert/strict';
import { INTRO_GAP, INTRO_WIDTH, notesIntroPosition } from './notesIntro';

test('intro geometry parks the card left of the anchor with a centered caret', () => {
  const pos = notesIntroPosition({ top: 300, left: 1000, height: 200 }, 900);
  assert.equal(pos.left, 1000 - INTRO_WIDTH - INTRO_GAP);
  assert.equal(pos.top, 302);
  assert.equal(pos.caretTop, 300 + 100 - 302); // anchor center relative to card top
});

test('intro geometry clamps to the viewport when space runs out', () => {
  const pos = notesIntroPosition({ top: 800, left: 200, height: 200 }, 700);
  // Not enough room left of the panel: hug the viewport edge instead.
  assert.equal(pos.left, 8);
  // Anchor near the viewport bottom: the ~250px card lifts to stay visible.
  assert.equal(pos.top, 700 - 262);
  // The caret rides along but stays on the card.
  assert.equal(pos.caretTop, 218);
});
