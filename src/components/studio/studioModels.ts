import type { ModelInfo } from '../../types/bridge';

export function resolveStudioDefaultModel(
  models: ModelInfo[],
  configuredModelId?: string,
): ModelInfo | undefined {
  return (
    (configuredModelId ? models.find((model) => model.id === configuredModelId) : undefined) ??
    models.find((model) => model.isDefault)
  );
}

export function resolveStudioModelId(
  hasSession: boolean,
  sessionModelId: string | undefined,
  draftModelId: string | undefined,
): string | undefined {
  return hasSession ? sessionModelId : draftModelId;
}
