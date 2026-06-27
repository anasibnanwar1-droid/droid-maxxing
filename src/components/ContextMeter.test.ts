import test from 'node:test';
import assert from 'node:assert/strict';
import { contextMeterMax, nextStableUsedState } from './ContextMeter';

test('compaction generation waits for fresh stats before accepting lower estimates', () => {
  const first = nextStableUsedState(null, 'm1', 93_000, false, 0, 'before');
  assert.equal(first.displayed, 93_000);

  const generationBump = nextStableUsedState(first.state, 'm1', 93_000, false, 1, 'before');
  assert.equal(generationBump.displayed, undefined);
  assert.equal(generationBump.state?.waitingForFresh, true);

  const staleAgain = nextStableUsedState(generationBump.state, 'm1', 93_000, false, 1, 'before');
  assert.equal(staleAgain.displayChanged, false);

  const fresh = nextStableUsedState(generationBump.state, 'm1', 18_000, false, 1, 'after');
  assert.equal(fresh.displayed, 18_000);
  assert.equal(fresh.state?.waitingForFresh, undefined);
});

test('orchestrator meter keeps the selected context window over a smaller daemon stat limit', () => {
  assert.equal(contextMeterMax(true, 100_000, 72_900), 100_000);
});

test('worker meter uses the selected worker stats denominator', () => {
  assert.equal(contextMeterMax(false, 100_000, 72_900), 72_900);
});
