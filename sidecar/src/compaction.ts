import type { DroidSession } from '@factory/droid-sdk';
import type { FactoryDefaultSettings } from './protocol.js';

export type CompactType = 'auto' | 'manual';

export interface CompactionTokenLimitPatch {
  compactionTokenLimit?: number | null;
  compactionTokenLimitPerModel?: Record<string, number>;
}

type CompactionDefaults = Pick<FactoryDefaultSettings, 'compactionTokenLimit' | 'compactionTokenLimitPerModel'>;

export function normalizeCompactionTokenLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}

export function compactionTokenLimitForModel(
  modelId: string | undefined,
  settings: CompactionTokenLimitPatch,
  defaults: CompactionDefaults = {},
): number | undefined {
  const perModel = settings.compactionTokenLimitPerModel !== undefined
    ? settings.compactionTokenLimitPerModel
    : defaults.compactionTokenLimitPerModel;
  const modelLimit = modelId ? normalizeCompactionTokenLimit(perModel?.[modelId]) : undefined;
  if (modelLimit !== undefined) return modelLimit;

  const globalLimit = settings.compactionTokenLimit !== undefined
    ? settings.compactionTokenLimit
    : defaults.compactionTokenLimit;
  return globalLimit === null ? undefined : normalizeCompactionTokenLimit(globalLimit);
}

// Resume precedence: honor the limit the resumed session itself exposes
// (per-model, then global) before falling back to the current app defaults.
// compactionTokenLimitForModel mixes settings and defaults per tier, so a
// default per-model limit could otherwise override a session's own saved global
// limit; resolving the exposed settings first (with no defaults) prevents that.
export function resumedCompactionTokenLimit(
  modelId: string | undefined,
  exposed: CompactionTokenLimitPatch,
  defaults: CompactionDefaults = {},
): number | undefined {
  const own = compactionTokenLimitForModel(modelId, exposed);
  return own !== undefined ? own : compactionTokenLimitForModel(modelId, {}, defaults);
}

export function clampCompactionTokenLimit(limit: number | undefined, maxContextTokens?: number): number | undefined {
  if (limit === undefined) return undefined;
  const max = normalizeCompactionTokenLimit(maxContextTokens);
  return max === undefined ? limit : Math.min(limit, max);
}

export function createCompactionSettingsForModel(
  modelId: string | undefined,
  settings: CompactionTokenLimitPatch,
  defaults: CompactionDefaults = {},
  maxContextTokens?: number,
): Record<string, number> {
  const limit = clampCompactionTokenLimit(compactionTokenLimitForModel(modelId, settings, defaults), maxContextTokens);
  return limit !== undefined ? { compactionTokenLimit: limit } : {};
}

// Single derivation of the auto-compaction threshold, shared by mission
// create, resume, and worker open so every session's trigger matches the
// limit the ContextMeter shows (per-model override -> global default, clamped
// to the model window).
export function effectiveCompactionLimit(
  modelId: string | undefined,
  defaults: CompactionDefaults,
  maxContextTokens: number | undefined,
): number | undefined {
  return clampCompactionTokenLimit(compactionTokenLimitForModel(modelId, {}, defaults), maxContextTokens);
}

// ---------------------------------------------------------------------------
// Unified runtime compaction layer. Every Droid session (the Mission Control
// orchestrator and each worker/subagent alike) flows through this single path
// after an idle turn. The daemon returns a new backing session id on success;
// the owner adopts it via the optional `reload` hook (the orchestrator swaps
// its backing session behind a stable app id; a worker re-keys itself to the
// new id). A caller without a reload hook reports the swap as 'stale'.
// ---------------------------------------------------------------------------

export interface AutoCompactState {
  compacting?: boolean;
  effectiveCompactionTokenLimit?: number;
}

// The one threshold rule used by both the orchestrator and workers.
export function autoCompactionDue(state: AutoCompactState, usedTokens: number | undefined): boolean {
  if (state.compacting) return false;
  const limit = state.effectiveCompactionTokenLimit;
  if (limit === undefined || limit <= 0) return false;
  return usedTokens !== undefined && usedTokens > 0 && usedTokens >= limit;
}

export type CompactableSession = Pick<DroidSession, 'sessionId' | 'compactSession'>;

export interface CompactionSink {
  // Emit a transcript status routed to the owning chat/worker.
  status(text: string, compactType: CompactType): void;
  error(message: string): void;
  // Re-read context stats so the meter reflects the compacted window.
  refresh(): Promise<void>;
  // Invoked only when the SDK returns a different backing session id. The owner
  // adopts it here (the orchestrator swaps its backing session; a worker
  // re-keys itself). Omitted only by callers that cannot adopt a swap.
  reload?: (newSessionId: string, removedCount: number) => Promise<void>;
}

export interface CompactionOptions {
  customInstructions?: string;
  compactType: CompactType;
}

// 'completed' - compaction ran and the session is usable.
// 'noop'      - the daemon reported nothing to compact; session unchanged.
// 'failed'    - compaction (or its reload/refresh) errored transiently. The
//               session object itself is unchanged and still usable; the caller
//               can keep it and retry later.
// 'stale'     - the daemon swapped to a new backing session id but the owner
//               has no reload hook to adopt it. The current session object is
//               no longer valid; the caller must recover (close and reopen)
//               rather than reuse it.
export type CompactionOutcome = 'completed' | 'noop' | 'failed' | 'stale';

// The single in-place compaction path: announce, compact, (rarely) reload a
// swapped backing session, refresh context, announce completion. Errors never
// throw (so they cannot wedge the caller mid-stream); the returned outcome lets
// the caller decide whether the session is still safe to reuse.
export async function runCompaction(
  session: CompactableSession,
  sink: CompactionSink,
  options: CompactionOptions,
): Promise<CompactionOutcome> {
  const { compactType } = options;
  sink.status('Compacting conversation...', compactType);
  // Tracks whether the current backing session is still safe to reuse. It flips
  // to false while a swapped-session reload is in flight and back to true once
  // adopted, so a reload failure (below) reports 'stale' rather than 'failed'.
  let sessionUsable = true;
  // The reload and refresh hooks can fail too (e.g. loading a swapped backing
  // session). Keep them inside the catch so a failure surfaces through
  // sink.error and never escapes to wedge the caller's streaming/idle state.
  try {
    const result = await session.compactSession(
      options.customInstructions ? { customInstructions: options.customInstructions } : {},
    );
    // Every return path must emit a terminal status: the "Compacting
    // conversation..." line drives an in-progress shimmer that only clears when
    // a later (non-"compacting") status replaces it.
    if (!result) {
      sink.status('Nothing to compact.', compactType);
      return 'noop';
    }
    const removedCount = result.removedCount ?? 0;
    if (result.newSessionId && result.newSessionId !== session.sessionId) {
      if (!sink.reload) {
        // The owner keeps a stable session id (workers) and cannot adopt a
        // swapped backing id without re-keying. Surface it and signal the
        // session is now stale so the caller can recover.
        sink.error(`daemon returned a new backing session (${result.newSessionId}); subagent sessions must compact in place to keep handoff addressing stable`);
        sink.status('Compaction could not finish; continuing with the current conversation.', compactType);
        return 'stale';
      }
      // The daemon has already swapped: the old backing id is now dead, so the
      // session is unusable until the reload adopts the new id.
      sessionUsable = false;
      await sink.reload(result.newSessionId, removedCount);
      sessionUsable = true;
    }
    await sink.refresh();
    sink.status(`Compaction complete. Removed ${removedCount.toLocaleString()} messages.`, compactType);
    return 'completed';
  } catch (err) {
    sink.error(err instanceof Error ? err.message : String(err));
    sink.status('Compaction could not finish; continuing with the current conversation.', compactType);
    // If the swap reload failed mid-flight the old session id is dead; report
    // 'stale' so the caller recovers (reopens) instead of draining sends into a
    // stale session. A failure without a swap leaves the session usable.
    return sessionUsable ? 'failed' : 'stale';
  }
}
