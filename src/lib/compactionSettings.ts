export interface GlobalCompactionSettingsPayload {
  compactionTokenLimit: number | 'factory-default';
  compactionTokenLimitPerModel: Record<string, number>;
}

export function compactionSettingsForGlobalLimit(
  limit: number | undefined,
  compactionTokenLimitPerModel: Record<string, number>,
): GlobalCompactionSettingsPayload {
  return {
    compactionTokenLimit: limit ?? 'factory-default',
    compactionTokenLimitPerModel,
  };
}
