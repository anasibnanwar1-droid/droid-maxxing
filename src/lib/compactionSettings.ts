import type { FactoryDefaultSettings } from '../types/bridge';

// Compaction token limit settings: localStorage persistence, the "did the
// user actually configure this?" distinction, and the snapshot pushed to the
// sidecar.
//
// Two sources write the same value keys: explicit user choices in Settings and
// the one-time seed from Factory CLI defaults (display only). Only the former
// may reach the sidecar as an explicit override; the seed must keep following
// the CLI file. The *-configured marker keys track user intent, so a seeded
// value is never mistaken for a user override (which previously froze the
// first seed forever and shadowed per-model, session, and CLI limits).

const COMPACTION_TOKEN_LIMIT_STORAGE_KEY = 'droid-compaction-token-limit';
const COMPACTION_TOKEN_LIMIT_CONFIGURED_STORAGE_KEY = 'droid-compaction-token-limit-configured';
const COMPACTION_TOKEN_LIMIT_PER_MODEL_STORAGE_KEY = 'droid-compaction-token-limit-per-model';
const COMPACTION_TOKEN_LIMIT_PER_MODEL_CONFIGURED_STORAGE_KEY =
  'droid-compaction-token-limit-per-model-configured';

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

export function normalizeTokenLimit(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

export function normalizeTokenLimitRecord(
  value: Record<string, number> | undefined,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(([id, limit]) => [id, normalizeTokenLimit(limit)])
      .filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

export function loadCompactionTokenLimit(): number | undefined {
  try {
    return normalizeTokenLimit(getLocalStorage()?.getItem(COMPACTION_TOKEN_LIMIT_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

export function hasUserConfiguredCompactionTokenLimit(): boolean {
  try {
    return getLocalStorage()?.getItem(COMPACTION_TOKEN_LIMIT_CONFIGURED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveCompactionTokenLimit(
  value?: number,
  options: { userConfigured?: boolean } = {},
): number | undefined {
  try {
    const storage = getLocalStorage();
    if (value === undefined) storage?.removeItem(COMPACTION_TOKEN_LIMIT_STORAGE_KEY);
    else storage?.setItem(COMPACTION_TOKEN_LIMIT_STORAGE_KEY, String(value));
    // A seed writes an explicit '0' marker: it distinguishes seeded data from
    // legacy pre-marker data (no marker at all), which load() migrates to
    // user-configured. Seeds only run while the user has not configured the
    // value, so this never downgrades a '1'.
    storage?.setItem(
      COMPACTION_TOKEN_LIMIT_CONFIGURED_STORAGE_KEY,
      (options.userConfigured ?? true) ? '1' : '0',
    );
  } catch {
    /* ignore */
  }
  return value;
}

export function loadCompactionTokenLimitPerModel(): Record<string, number> {
  try {
    const storage = getLocalStorage();
    const raw = storage?.getItem(COMPACTION_TOKEN_LIMIT_PER_MODEL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed)) {
      const n = normalizeTokenLimit(value);
      if (id && n !== undefined) out[id] = n;
    }
    // Migration: per-model data written before the marker keys existed came
    // almost always from explicit user edits (the old defaults seed was rare
    // and wrote the same values the CLI file carried anyway). Stamp it as
    // user-configured so the next defaults event cannot wipe it.
    if (
      Object.keys(out).length > 0 &&
      storage?.getItem(COMPACTION_TOKEN_LIMIT_PER_MODEL_CONFIGURED_STORAGE_KEY) === null
    ) {
      storage.setItem(COMPACTION_TOKEN_LIMIT_PER_MODEL_CONFIGURED_STORAGE_KEY, '1');
    }
    return out;
  } catch {
    return {};
  }
}

export function hasUserConfiguredCompactionTokenLimitPerModel(): boolean {
  try {
    return (
      getLocalStorage()?.getItem(COMPACTION_TOKEN_LIMIT_PER_MODEL_CONFIGURED_STORAGE_KEY) === '1'
    );
  } catch {
    return false;
  }
}

export function saveCompactionTokenLimitPerModel(
  value: Record<string, number>,
  options: { userConfigured?: boolean } = {},
): Record<string, number> {
  try {
    const storage = getLocalStorage();
    storage?.setItem(COMPACTION_TOKEN_LIMIT_PER_MODEL_STORAGE_KEY, JSON.stringify(value));
    // See saveCompactionTokenLimit: '0' marks seeded data so the legacy
    // migration in load() only fires for pre-marker storage.
    storage?.setItem(
      COMPACTION_TOKEN_LIMIT_PER_MODEL_CONFIGURED_STORAGE_KEY,
      (options.userConfigured ?? true) ? '1' : '0',
    );
  } catch {
    /* ignore */
  }
  return value;
}

// The snapshot pushed to the sidecar. Fields appear only when the user
// actually configured them: an explicit null global means "cleared, use the
// daemon's model default"; an omitted field means "no user signal, follow the
// session's own limit and the CLI file".
export function compactionSettingsSnapshot(state: {
  compactionTokenLimit?: number;
  compactionTokenLimitPerModel: Record<string, number>;
}): {
  compactionTokenLimit?: number | null;
  compactionTokenLimitPerModel?: Record<string, number>;
} {
  const snapshot: {
    compactionTokenLimit?: number | null;
    compactionTokenLimitPerModel?: Record<string, number>;
  } = {};
  if (hasUserConfiguredCompactionTokenLimit())
    snapshot.compactionTokenLimit = state.compactionTokenLimit ?? null;
  if (hasUserConfiguredCompactionTokenLimitPerModel())
    snapshot.compactionTokenLimitPerModel = state.compactionTokenLimitPerModel;
  return snapshot;
}

// Seed (and keep re-seeding) the Settings panel display from the Factory CLI
// defaults while the user has not configured their own values. The seed writes
// the value keys for display persistence but never the configured markers, so
// it keeps tracking CLI-file changes and never turns into an explicit
// override. A user's explicit clear sets the marker and wins over any future
// defaults event.
export function applyFactoryCompactionDefaults(
  state: { compactionTokenLimit?: number; compactionTokenLimitPerModel: Record<string, number> },
  defaults: Pick<FactoryDefaultSettings, 'compactionTokenLimit' | 'compactionTokenLimitPerModel'>,
): { compactionTokenLimit?: number; compactionTokenLimitPerModel: Record<string, number> } {
  const userLimit = hasUserConfiguredCompactionTokenLimit();
  const userPerModel = hasUserConfiguredCompactionTokenLimitPerModel();
  const defaultLimit = normalizeTokenLimit(defaults.compactionTokenLimit);
  const defaultPerModel = normalizeTokenLimitRecord(defaults.compactionTokenLimitPerModel);

  const compactionTokenLimit = userLimit ? state.compactionTokenLimit : defaultLimit;
  const compactionTokenLimitPerModel = userPerModel
    ? state.compactionTokenLimitPerModel
    : defaultPerModel;

  if (!userLimit) saveCompactionTokenLimit(compactionTokenLimit, { userConfigured: false });
  if (!userPerModel) saveCompactionTokenLimitPerModel(defaultPerModel, { userConfigured: false });

  return { compactionTokenLimit, compactionTokenLimitPerModel };
}
