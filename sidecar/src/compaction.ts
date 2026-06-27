import type { ContextStatsSnapshot, FactoryDefaultSettings } from './protocol.js';

// Factory compaction policy helpers.
//
// The Factory runtime owns compaction implementation: hooks, safe boundaries,
// anchored/delta summarization, and compacted session records. Droid Control
// configures native threshold checks, reflects Factory notifications in the UI,
// and uses Factory's compactSession() RPC when an active turn must be compacted
// near the selected context window.

export type CompactType = 'auto' | 'manual';

export interface CompactionTokenLimitPatch {
  compactionTokenLimit?: number | null;
  compactionTokenLimitPerModel?: Record<string, number>;
}

export function mergeCompactionSettings(
  current: CompactionTokenLimitPatch,
  patch: CompactionTokenLimitPatch,
): CompactionTokenLimitPatch {
  const next = { ...current };
  if ('compactionTokenLimit' in patch) {
    if (patch.compactionTokenLimit === null || patch.compactionTokenLimit === undefined)
      delete next.compactionTokenLimit;
    else next.compactionTokenLimit = patch.compactionTokenLimit;
  }
  if ('compactionTokenLimitPerModel' in patch) {
    const perModel = patch.compactionTokenLimitPerModel;
    if (!perModel || Object.keys(perModel).length === 0) delete next.compactionTokenLimitPerModel;
    else next.compactionTokenLimitPerModel = perModel;
  }
  return next;
}

export const DAEMON_COMPACTION_TRIGGER_RATIO = 1;

type CompactionDefaults = Pick<
  FactoryDefaultSettings,
  'compactionTokenLimit' | 'compactionTokenLimitPerModel'
>;

export function normalizeCompactionTokenLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}

// A configured context window above the model's real window is impossible, so
// cap it to the window when the window is known.
function clampToWindow(limit: number | undefined, modelWindow?: number): number | undefined {
  if (limit === undefined) return undefined;
  return modelWindow && modelWindow > 0 ? Math.min(limit, modelWindow) : limit;
}

// Resolve the user's optional context window for a model: a per-model override
// wins over the global window, with the same precedence applied to app defaults,
// capped to the model's real context window. Undefined means "let the daemon use
// its own model-aware default".
export function compactionTokenLimitForModel(
  modelId: string | undefined,
  settings: CompactionTokenLimitPatch,
  defaults: CompactionDefaults = {},
  modelWindow?: number,
): number | undefined {
  const perModel = settings.compactionTokenLimitPerModel ?? defaults.compactionTokenLimitPerModel;
  const modelLimit = modelId ? normalizeCompactionTokenLimit(perModel?.[modelId]) : undefined;
  if (modelLimit !== undefined) return clampToWindow(modelLimit, modelWindow);

  const globalLimit =
    settings.compactionTokenLimit !== undefined
      ? settings.compactionTokenLimit
      : defaults.compactionTokenLimit;
  return globalLimit === null
    ? undefined
    : clampToWindow(normalizeCompactionTokenLimit(globalLimit), modelWindow);
}

export function selectedContextWindowForModel(
  modelId: string | undefined,
  settings: CompactionTokenLimitPatch,
  defaults: CompactionDefaults = {},
  modelWindow?: number,
): number | undefined {
  return (
    compactionTokenLimitForModel(modelId, settings, defaults, modelWindow) ??
    normalizeCompactionTokenLimit(modelWindow)
  );
}

export function contextStatsWithWindow(
  stats: ContextStatsSnapshot,
  contextWindow: number | undefined,
): ContextStatsSnapshot {
  const limit = normalizeCompactionTokenLimit(contextWindow);
  if (limit === undefined) return stats;
  const remaining = Math.max(0, limit - stats.used);
  return {
    ...stats,
    remaining,
    limit,
    breakdown: stats.breakdown
      ? { ...stats.breakdown, contextBudget: limit, usedTokens: stats.used, freeTokens: remaining }
      : undefined,
  };
}

export function fallbackAutoCompactionDue(stats: ContextStatsSnapshot): boolean {
  return stats.accuracy === 'exact' && stats.limit > 0 && stats.used >= stats.limit;
}

export function daemonCompactionTriggerForWindow(
  contextWindow: number | undefined,
  modelWindow?: number,
): number | undefined {
  const window = clampToWindow(normalizeCompactionTokenLimit(contextWindow), modelWindow);
  if (window === undefined) return undefined;
  return Math.max(1, Math.floor(window * DAEMON_COMPACTION_TRIGGER_RATIO));
}

export function daemonCompactionTriggerForModel(
  modelId: string | undefined,
  settings: CompactionTokenLimitPatch,
  defaults: CompactionDefaults = {},
  modelWindow?: number,
): number | undefined {
  return daemonCompactionTriggerForWindow(
    compactionTokenLimitForModel(modelId, settings, defaults, modelWindow),
    modelWindow,
  );
}

// Resume precedence for Factory/default behavior: honor the daemon trigger the
// resumed session itself exposes before falling back to current app defaults.
// Callers with an explicit Droid Control context window should use that first.
export function resumedCompactionTokenLimit(
  modelId: string | undefined,
  exposed: CompactionTokenLimitPatch,
  defaults: CompactionDefaults = {},
  modelWindow?: number,
): number | undefined {
  const own = compactionTokenLimitForModel(modelId, exposed, {}, modelWindow);
  return own ?? daemonCompactionTriggerForModel(modelId, {}, defaults, modelWindow);
}

// Settings handed to Factory sessions. A numeric value is the trigger; omitting
// it keeps Factory's own model-aware default policy enabled.
export interface DaemonCompactionSettings {
  compactionThresholdCheckEnabled: true;
  compactionTokenLimit?: number;
}

export function daemonCompactionSettings(
  modelId: string | undefined,
  settings: CompactionTokenLimitPatch,
  defaults: CompactionDefaults = {},
  modelWindow?: number,
): DaemonCompactionSettings {
  const compactionTokenLimit = daemonCompactionTriggerForModel(
    modelId,
    settings,
    defaults,
    modelWindow,
  );
  return compactionTokenLimit !== undefined
    ? { compactionThresholdCheckEnabled: true, compactionTokenLimit }
    : { compactionThresholdCheckEnabled: true };
}

export function daemonCompactionSettingsForTrigger(
  compactionTokenLimit: number | undefined,
): DaemonCompactionSettings {
  const normalized = normalizeCompactionTokenLimit(compactionTokenLimit);
  return normalized !== undefined
    ? { compactionThresholdCheckEnabled: true, compactionTokenLimit: normalized }
    : { compactionThresholdCheckEnabled: true };
}

// A `session_compacted` notification from Factory. Some runtimes can emit this
// while compacting; the SDK does not convert it to a stream message, so read it
// from raw notifications.
export interface SessionCompacted {
  summaryId?: string;
  removedCount: number;
  visibleBoundaryMessageId?: string | null;
}

export function readSessionCompacted(notification: unknown): SessionCompacted | null {
  const raw = unwrapNotification(notification);
  if (raw?.type !== 'session_compacted') return null;
  return {
    summaryId: typeof raw.summaryId === 'string' ? raw.summaryId : undefined,
    removedCount: typeof raw.removedCount === 'number' ? raw.removedCount : 0,
    visibleBoundaryMessageId:
      typeof raw.visibleBoundaryMessageId === 'string' ? raw.visibleBoundaryMessageId : null,
  };
}

// Notifications arrive either as a bare payload or wrapped under
// `params.notification` / `notification`; unwrap to the inner payload, mirroring
// normalize.ts so both paths read the same shape.
function unwrapNotification(notification: unknown): Record<string, unknown> | null {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) return null;
  const record = notification as Record<string, unknown>;
  const params =
    record.params && typeof record.params === 'object' && !Array.isArray(record.params)
      ? (record.params as Record<string, unknown>)
      : undefined;
  const inner = params && 'notification' in params ? params.notification : record.notification;
  const payload = inner ?? record;
  return typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

// Call Factory's real compactSession() RPC. The daemon owns the compaction
// semantics; callers only decide whether a user/manual or active-turn fallback
// should ask Factory to compact this session now.
export interface CompactableSession {
  sessionId: string;
  compactSession(params?: { customInstructions?: string }): Promise<unknown>;
}

export interface FactoryCompaction {
  newSessionId: string;
  removedCount: number;
}

export async function runFactoryCompaction(
  session: CompactableSession,
  customInstructions?: string,
): Promise<FactoryCompaction | null> {
  // The SDK types compactSession() as non-null, but it returns null at runtime
  // when there is nothing left to compact (the same guard compactHistoricalSession
  // relies on), so treat the result as nullable before dereferencing it.
  const result = (await session.compactSession(
    customInstructions ? { customInstructions } : {},
  )) as FactoryCompaction | null;
  if (!result) return null;
  return { newSessionId: result.newSessionId, removedCount: result.removedCount };
}
