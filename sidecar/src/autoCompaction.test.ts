import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoCompactionDueAtTrigger,
  canAutoContinue,
  COMPACTION_TRIGGER_RATIO,
  compactionStillOverTrigger,
  compactionTrigger,
  effectiveTriggerLimit,
  isSyntheticResume,
  MAX_CONSECUTIVE_AUTO_CONTINUES,
  RESUME_NUDGE,
  shouldInterruptForCompaction,
  usageBelowTrigger,
} from './autoCompaction.js';

test('compactionTrigger is 80% of the window, floored', () => {
  assert.equal(COMPACTION_TRIGGER_RATIO, 0.8);
  assert.equal(compactionTrigger(200_000), 160_000);
  assert.equal(compactionTrigger(199_999), 159_999);
});

test('compactionTrigger returns undefined for a missing or invalid window', () => {
  assert.equal(compactionTrigger(undefined), undefined);
  assert.equal(compactionTrigger(0), undefined);
  assert.equal(compactionTrigger(-1), undefined);
  assert.equal(compactionTrigger(Number.NaN), undefined);
});

test('effectiveTriggerLimit clamps an explicit limit to the live window', () => {
  // Explicit limit larger than the real window -> clamp down to the window.
  assert.equal(effectiveTriggerLimit(100_000, 53_144), 53_144);
  // Explicit limit smaller than the window -> the explicit limit binds.
  assert.equal(effectiveTriggerLimit(40_000, 53_144), 40_000);
});

test('effectiveTriggerLimit falls back to the window when no explicit limit is set', () => {
  assert.equal(effectiveTriggerLimit(undefined, 53_144), 53_144);
  // No explicit limit and no window -> nothing to trigger on.
  assert.equal(effectiveTriggerLimit(undefined, undefined), undefined);
  // Explicit limit but no reported window -> use the explicit limit as-is.
  assert.equal(effectiveTriggerLimit(120_000, undefined), 120_000);
});

test('autoCompactionDueAtTrigger uses the live window when it is smaller than the limit', () => {
  // Limit 100k but the real window is only 53,144: the trigger is 80% of 53,144
  // (42,515), not 80% of 100k. This is the live-testing case (flat global limit
  // larger than a custom model window).
  const state = { effectiveCompactionTokenLimit: 100_000 };
  assert.equal(autoCompactionDueAtTrigger(state, 42_000, 53_144), false);
  assert.equal(autoCompactionDueAtTrigger(state, 42_515, 53_144), true);
});

test('autoCompactionDueAtTrigger fires at >=80% of the window, not at 100%', () => {
  const state = { effectiveCompactionTokenLimit: 200_000 };
  assert.equal(autoCompactionDueAtTrigger(state, 159_999), false);
  assert.equal(autoCompactionDueAtTrigger(state, 160_000), true);
  // The user-facing window (200k) is never the trigger; we fire well before it.
  assert.equal(autoCompactionDueAtTrigger(state, 200_000), true);
});

test('autoCompactionDueAtTrigger is never due while compacting or without a window', () => {
  assert.equal(
    autoCompactionDueAtTrigger(
      { effectiveCompactionTokenLimit: 200_000, compacting: true },
      195_000,
    ),
    false,
  );
  assert.equal(
    autoCompactionDueAtTrigger({ effectiveCompactionTokenLimit: undefined }, 195_000),
    false,
  );
  assert.equal(
    autoCompactionDueAtTrigger({ effectiveCompactionTokenLimit: 200_000 }, undefined),
    false,
  );
  assert.equal(autoCompactionDueAtTrigger({ effectiveCompactionTokenLimit: 200_000 }, 0), false);
});

test('autoCompactionDueAtTrigger is paused while saturated, even over the trigger', () => {
  const state = { effectiveCompactionTokenLimit: 200_000, compactionSaturated: true };
  // Usage well over the trigger, but a prior compaction already proved it cannot
  // be reduced below it, so the policy stays paused instead of looping.
  assert.equal(autoCompactionDueAtTrigger(state, 195_000), false);
  // The same usage compacts normally once the latch is cleared.
  assert.equal(autoCompactionDueAtTrigger({ ...state, compactionSaturated: false }, 195_000), true);
});

test('compactionStillOverTrigger detects a compaction that could not get under the trigger', () => {
  const state = { effectiveCompactionTokenLimit: 200_000 };
  // Post-compaction usage still at/above 160k (80% of 200k) -> saturated.
  assert.equal(compactionStillOverTrigger(state, 185_000), true);
  assert.equal(compactionStillOverTrigger(state, 180_000), true);
  // Compaction got under the trigger -> not saturated.
  assert.equal(compactionStillOverTrigger(state, 120_000), false);
  // No reading / no basis -> not saturated.
  assert.equal(compactionStillOverTrigger(state, undefined), false);
  assert.equal(
    compactionStillOverTrigger({ effectiveCompactionTokenLimit: undefined }, 185_000),
    false,
  );
  // Clamped to the live window: 80% of 53,144 is 42,515.
  assert.equal(compactionStillOverTrigger(state, 48_000, 53_144), true);
});

test('usageBelowTrigger detects a real sub-trigger reading that lifts the latch', () => {
  const state = { effectiveCompactionTokenLimit: 200_000 };
  assert.equal(usageBelowTrigger(state, 120_000), true);
  assert.equal(usageBelowTrigger(state, 180_000), false);
  assert.equal(usageBelowTrigger(state, 185_000), false);
  // Missing/zero readings are not "below" (we never clear on no data).
  assert.equal(usageBelowTrigger(state, undefined), false);
  assert.equal(usageBelowTrigger(state, 0), false);
});

test('shouldInterruptForCompaction only fires for an over-trigger, uninterrupted live turn', () => {
  const base = { effectiveCompactionTokenLimit: 200_000, streaming: true };
  assert.equal(shouldInterruptForCompaction(base, 185_000), true);
  // Not streaming -> never interrupt (idle is handled pre-turn, not mid-turn).
  assert.equal(shouldInterruptForCompaction({ ...base, streaming: false }, 185_000), false);
  // Under the trigger -> let the turn run.
  assert.equal(shouldInterruptForCompaction(base, 100_000), false);
  // Already interrupting (steer or a prior compaction request) -> don't double-interrupt.
  assert.equal(
    shouldInterruptForCompaction({ ...base, interruptingForSteer: true }, 185_000),
    false,
  );
  assert.equal(
    shouldInterruptForCompaction({ ...base, interruptingForCompaction: true }, 185_000),
    false,
  );
  // Mid-compaction -> never interrupt the compaction.
  assert.equal(shouldInterruptForCompaction({ ...base, compacting: true }, 185_000), false);
});

test('isSyntheticResume matches only the exact resume nudge (trimmed)', () => {
  assert.equal(isSyntheticResume(RESUME_NUDGE), true);
  assert.equal(isSyntheticResume(`  ${RESUME_NUDGE}\n`), true);
  assert.equal(isSyntheticResume('continue'), false);
  assert.equal(isSyntheticResume('Please continue the work from where you left off.'), false);
  assert.equal(isSyntheticResume(undefined), false);
  assert.equal(isSyntheticResume(''), false);
});

test('canAutoContinue caps consecutive hidden continues', () => {
  assert.equal(canAutoContinue(undefined), true);
  assert.equal(canAutoContinue(0), true);
  assert.equal(canAutoContinue(MAX_CONSECUTIVE_AUTO_CONTINUES - 1), true);
  assert.equal(canAutoContinue(MAX_CONSECUTIVE_AUTO_CONTINUES), false);
  assert.equal(canAutoContinue(MAX_CONSECUTIVE_AUTO_CONTINUES + 1), false);
});
