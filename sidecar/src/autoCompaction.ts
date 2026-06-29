import type { AutoCompactState } from './compaction.js';

// Client-owned long-horizon compaction policy. The compaction mechanism itself
// (Factory's official `session.compactSession()`) and the session swap/rekey
// live in `compaction.ts` and `MissionManager.ts`; this module only decides
// *when* to compact and *how* to resume, so that policy stays small, testable,
// and separate from the MissionManager runtime.

// Fraction of the user-facing context window at which Droid Control compacts
// internally. The window the user sees is never changed by this; the trigger is
// purely an internal decision and is not surfaced. A single flat ratio with no
// aging/degradation by compaction count. Kept below the window with real
// headroom: because compaction is deferred to a safe boundary (after the
// in-flight tool's result, never mid-tool), a single large tool result can push
// usage further between boundaries, so the trigger must leave room to absorb
// that without dying at the hard window limit.
export const COMPACTION_TRIGGER_RATIO = 0.8;

// The internal auto-compaction trigger derived from a context window. Returns
// undefined when there is no usable window so callers simply skip the check.
export function compactionTrigger(windowTokens: number | undefined): number | undefined {
  if (windowTokens === undefined || !Number.isFinite(windowTokens) || windowTokens <= 0)
    return undefined;
  return Math.floor(windowTokens * COMPACTION_TRIGGER_RATIO);
}

// The trigger basis: an explicit compaction limit, clamped to the real context
// window, falling back to the window when no explicit limit is set. Keeping the
// basis pinned to the live window (from `getContextStats`) is what keeps the
// internal trigger consistent with the usage the user sees in the meter.
export function effectiveTriggerLimit(
  explicitLimit: number | undefined,
  windowTokens: number | undefined,
): number | undefined {
  if (explicitLimit !== undefined && windowTokens !== undefined)
    return Math.min(explicitLimit, windowTokens);
  return explicitLimit ?? windowTokens;
}

// Whether usage has crossed the internal trigger. `usedTokens` and
// `windowTokens` must come from the same source as the context meter
// (`getContextStats`), never from per-call token-usage events (those include
// cache reads and over-report the real context size). Never due while a
// compaction is already running. This single rule is used by both the mid-task
// interrupt check and the pre-turn check.
export function autoCompactionDueAtTrigger(
  state: AutoCompactState,
  usedTokens: number | undefined,
  windowTokens?: number,
): boolean {
  if (state.compacting) return false;
  // A prior compaction already landed at/above the trigger (the summary itself
  // is near the window). Compacting again summarizes an already-compact
  // transcript and cannot drop below the trigger, so it would loop forever.
  // Stay paused until real user input or a sub-trigger reading clears the latch.
  if (state.compactionSaturated) return false;
  const trigger = triggerForState(state, windowTokens);
  if (trigger === undefined) return false;
  return usedTokens !== undefined && usedTokens > 0 && usedTokens >= trigger;
}

// The internal trigger for a state, or undefined when there is no usable basis.
function triggerForState(state: AutoCompactState, windowTokens?: number): number | undefined {
  return compactionTrigger(
    effectiveTriggerLimit(state.effectiveCompactionTokenLimit, windowTokens),
  );
}

// Whether a just-completed compaction left usage still at/above the trigger.
// True means the summary is near the window and further compaction cannot help,
// so the caller should latch `compactionSaturated` and stop looping.
export function compactionStillOverTrigger(
  state: AutoCompactState,
  usedTokens: number | undefined,
  windowTokens?: number,
): boolean {
  const trigger = triggerForState(state, windowTokens);
  if (trigger === undefined || usedTokens === undefined || usedTokens <= 0) return false;
  return usedTokens >= trigger;
}

// Whether usage is a real reading strictly below the trigger. Used to clear a
// `compactionSaturated` latch once the context genuinely fits again.
export function usageBelowTrigger(
  state: AutoCompactState,
  usedTokens: number | undefined,
  windowTokens?: number,
): boolean {
  const trigger = triggerForState(state, windowTokens);
  if (trigger === undefined || usedTokens === undefined || usedTokens <= 0) return false;
  return usedTokens < trigger;
}

export interface InterruptForCompactionState extends AutoCompactState {
  streaming?: boolean;
  interruptingForSteer?: boolean;
  interruptingForCompaction?: boolean;
}

// True when a live turn should be interrupted so the session can compact at a
// safe boundary (after the in-flight step, before the next model request). We
// never interrupt a turn that is idle, already being interrupted (for steering
// or a prior compaction request), or mid-compaction.
export function shouldInterruptForCompaction(
  state: InterruptForCompactionState,
  usedTokens: number | undefined,
  windowTokens?: number,
): boolean {
  if (!state.streaming) return false;
  if (state.interruptingForCompaction || state.interruptingForSteer) return false;
  return autoCompactionDueAtTrigger(state, usedTokens, windowTokens);
}

// Hidden prompt that resumes a task after a mid-task compaction. Phrased
// permissively so that if nothing remains the model simply gives its final
// answer instead of inventing busywork. It is sent programmatically and dropped
// from the visible transcript (see `isSyntheticResume`) so the user only ever
// sees the compaction divider, never a fake "continue" message they did not type.
export const RESUME_NUDGE =
  'Continue with the remaining work from where you left off. The earlier conversation was automatically compacted into summaries to free up context; pick up exactly where you stopped. If the task is already complete, just give your final response instead of repeating work.';

// Recognizes the hidden resume nudge so it can be dropped from the visible
// transcript on history replay (the daemon persists it as an ordinary user
// message). Matches the exact text Droid Control sends, trimmed.
export function isSyntheticResume(text: string | undefined): boolean {
  return typeof text === 'string' && text.trim() === RESUME_NUDGE;
}

// Cap on consecutive hidden continues with no real user input in between, so a
// self-driving loop can never run away on cost. Reset whenever a real user
// prompt is delivered. Generous enough that normal long tasks never reach it.
export const MAX_CONSECUTIVE_AUTO_CONTINUES = 50;

// Whether another hidden continue is allowed given how many have already run
// back-to-back without user input.
export function canAutoContinue(consecutiveAutoContinues: number | undefined): boolean {
  return (consecutiveAutoContinues ?? 0) < MAX_CONSECUTIVE_AUTO_CONTINUES;
}
