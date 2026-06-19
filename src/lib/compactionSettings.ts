export interface GlobalCompactionSettingsPayload {
  compactionTokenLimit: number | null | 'factory-default';
  compactionTokenLimitPerModel: Record<string, number>;
}

export interface CompactionSettingsPayload {
  compactionTokenLimit?: number | null;
  compactionTokenLimitPerModel: Record<string, number>;
}

export type CompactionTokenLimitSelection = number | null | undefined;

export function effectiveCompactionSettings(
  limit: CompactionTokenLimitSelection,
  compactionTokenLimitPerModel: Record<string, number>,
): CompactionSettingsPayload {
  const payload: CompactionSettingsPayload = {
    compactionTokenLimitPerModel: limit === null ? {} : compactionTokenLimitPerModel,
  };
  if (limit !== undefined) payload.compactionTokenLimit = limit;
  return payload;
}

export function compactionSettingsForGlobalLimit(
  limit: CompactionTokenLimitSelection,
  compactionTokenLimitPerModel: Record<string, number>,
): GlobalCompactionSettingsPayload {
  const effective = effectiveCompactionSettings(limit, compactionTokenLimitPerModel);
  return {
    compactionTokenLimit: limit === undefined ? 'factory-default' : limit,
    compactionTokenLimitPerModel: effective.compactionTokenLimitPerModel,
  };
}
