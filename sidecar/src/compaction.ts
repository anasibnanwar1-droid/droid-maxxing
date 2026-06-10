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
// after an idle turn. Compaction is in-place: the daemon rewrites the session
// in place, so a returned new backing id is only handled by the owner via the
// optional `reload` hook (the orchestrator swaps its backing session; workers
// compact in place so their session id, and the orchestrator's handoff
// addressing, never change).
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
  // Invoked only when the SDK returns a different backing session id. The
  // orchestrator swaps its backing session here; workers omit it.
  reload?: (newSessionId: string, removedCount: number) => Promise<void>;
}

export interface CompactionOptions {
  customInstructions?: string;
  compactType: CompactType;
}

// The single in-place compaction path: announce, compact, (rarely) reload a
// swapped backing session, refresh context, announce completion.
export async function runCompaction(
  session: CompactableSession,
  sink: CompactionSink,
  options: CompactionOptions,
): Promise<void> {
  const { compactType } = options;
  sink.status('Compacting conversation...', compactType);
  // The reload and refresh hooks can fail too (e.g. loading a swapped backing
  // session). Keep them inside the catch so a failure surfaces through
  // sink.error and never escapes to wedge the caller's streaming/idle state.
  try {
    const result = await session.compactSession(
      options.customInstructions ? { customInstructions: options.customInstructions } : {},
    );
    if (!result) return;
    const removedCount = result.removedCount ?? 0;
    if (sink.reload && result.newSessionId && result.newSessionId !== session.sessionId) {
      await sink.reload(result.newSessionId, removedCount);
    }
    await sink.refresh();
    sink.status(`Compaction complete. Removed ${removedCount.toLocaleString()} messages.`, compactType);
  } catch (err) {
    sink.error(err instanceof Error ? err.message : String(err));
  }
}
