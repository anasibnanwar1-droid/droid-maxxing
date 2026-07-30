import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer } from './useStore';

test('composer seed is cleared after the composer consumes it', () => {
  const seeded = reducer(initialState, { type: 'SEED_COMPOSER', text: 'Build a dashboard' });
  assert.equal(seeded.composerSeed?.text, 'Build a dashboard');

  const consumed = reducer(seeded, { type: 'CLEAR_COMPOSER_SEED' });
  assert.equal(consumed.composerSeed, null);

  // Clearing with nothing pending is a no-op, so repeat consumption is safe.
  const again = reducer(consumed, { type: 'CLEAR_COMPOSER_SEED' });
  assert.equal(again.composerSeed, null);
});
