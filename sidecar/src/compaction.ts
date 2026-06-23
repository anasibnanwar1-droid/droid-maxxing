import type { DroidSession } from '@factory/droid-sdk';
import type { FactoryDefaultSettings } from './protocol.js';

// Daemon-owned compaction.
//
// Factory's daemon performs threshold-based auto-compaction itself, mid-turn and
// in place: it emits a `session_compacted` notification that carries NO
// replacement session id, so the session id we hold stays valid and the chat is
// unchanged across any number of automatic compactions. The app only (a) turns
// that on for every session and (b) reflects it.
//
// The single exception is the user-triggered `compactSession()` RPC behind the
// manual "Compact now" action, which mints a new session id (like forkSession);
// the caller adopts it behind the stable app id so the visible chat is unchanged.

export type CompactType = 'auto' | 'manual';

export interface CompactionTokenLimitPatch {
  compactionTokenLimit?: number | null;
  compactionTokenLimitPerModel?: Record<string, number>;
}

type CompactionDefaults = Pick<
  FactoryDefaultSettings,
  'compactionTokenLimit' | 'compactionTokenLimitPerModel'
>;

export function normalizeCompactionTokenLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}

// A trigger above the model's context window can never fire before the window
// fills, so cap it to the window when the window is known.
function clampToWindow(limit: number | undefined, modelWindow?: number): number | undefined {
  if (limit === undefined) return undefined;
  return modelWindow && modelWindow > 0 ? Math.min(limit, modelWindow) : limit;
}

// Resolve the user's optional auto-compaction trigger for a model: a per-model
// override wins over the global limit, with the same precedence applied to app
// defaults, capped to the model context window. Undefined means "let the daemon
// use its own model-aware default".
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

// Resume precedence: honor the limit the resumed session itself exposes before
// falling back to current app defaults, so a default per-model limit can't
// override a session's own saved global limit. Capped to the model window.
export function resumedCompactionTokenLimit(
  modelId: string | undefined,
  exposed: CompactionTokenLimitPatch,
  defaults: CompactionDefaults = {},
  modelWindow?: number,
): number | undefined {
  const own = compactionTokenLimitForModel(modelId, exposed, {}, modelWindow);
  return own ?? compactionTokenLimitForModel(modelId, {}, defaults, modelWindow);
}

// Settings handed to every session (orchestrator, chat, worker, validator,
// subagent) so the daemon owns auto-compaction uniformly. Threshold-based
// auto-compaction is ALWAYS on — there is no off switch. The only knob is the
// optional trigger size, omitted so the daemon picks a model-aware default
// unless the user set one.
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
  const compactionTokenLimit = compactionTokenLimitForModel(
    modelId,
    settings,
    defaults,
    modelWindow,
  );
  return compactionTokenLimit !== undefined
    ? { compactionThresholdCheckEnabled: true, compactionTokenLimit }
    : { compactionThresholdCheckEnabled: true };
}

// A daemon `session_compacted` notification — the in-place auto-compaction
// signal. The SDK does not convert it to a stream message, so it is read from
// the raw notification delivered to `session.onNotification`. It carries no
// replacement session id by design: auto-compaction keeps the same session.
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

// Manual "Compact now": the single caller of compactSession(). Returns the new
// backing session id the daemon minted so the caller can adopt it behind the
// stable app id.
export type CompactableSession = Pick<DroidSession, 'sessionId' | 'compactSession'>;

export interface ManualCompaction {
  newSessionId: string;
  removedCount: number;
}

export async function runManualCompaction(
  session: CompactableSession,
  customInstructions?: string,
): Promise<ManualCompaction> {
  const result = await session.compactSession(customInstructions ? { customInstructions } : {});
  return { newSessionId: result.newSessionId, removedCount: result.removedCount };
}
