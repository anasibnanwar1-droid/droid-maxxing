import type {
  BridgeFeature,
  ChildSessionSummary,
  ModelInfo,
  ReasoningEffort,
} from '../types/bridge';

export type ExactChildRole = 'worker' | 'validator';
export type ExactChildSettingsReadiness = 'opening' | 'ready' | 'failed';

export interface ExactChildSettingsTarget {
  parentAppSessionId: string;
  childSessionId: string;
  role: ExactChildRole;
  label: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  readiness: ExactChildSettingsReadiness;
}

export interface ChildSettingsUpdate {
  parentAppSessionId: string;
  childSessionId: string;
  modelId: string | null;
  reasoningEffort?: ReasoningEffort;
}

export function featureChildRole(feature: BridgeFeature): ExactChildRole {
  const text = `${feature.id} ${feature.skillName} ${feature.description}`.toLowerCase();
  return text.includes('validator') || text.includes('validation') || text.includes('scrutiny')
    ? 'validator'
    : 'worker';
}

export function liveFeatureChildRole(
  features: readonly BridgeFeature[],
  childSessionId: string,
): ExactChildRole | undefined {
  const feature = features.find(
    (item) =>
      item.status === 'in_progress' && item.currentWorkerProviderSessionId === childSessionId,
  );
  return feature ? featureChildRole(feature) : undefined;
}

export function buildExactChildSettingsTarget(input: {
  parentAppSessionId: string;
  childSessionId: string;
  features: readonly BridgeFeature[];
  child?: Pick<ChildSessionSummary, 'modelId' | 'reasoningEffort'>;
  label: string;
  readiness: ExactChildSettingsReadiness;
}): ExactChildSettingsTarget | undefined {
  const role = liveFeatureChildRole(input.features, input.childSessionId);
  if (!role) return undefined;
  return {
    parentAppSessionId: input.parentAppSessionId,
    childSessionId: input.childSessionId,
    role,
    label: input.label,
    modelId: input.child?.modelId,
    reasoningEffort: input.child?.reasoningEffort,
    readiness: input.readiness,
  };
}

export function buildSelectedChildSettingsTarget(input: {
  parentAppSessionId: string;
  childSessionId: string;
  features: readonly BridgeFeature[];
  child?: Pick<ChildSessionSummary, 'modelId' | 'reasoningEffort'>;
  label: string;
  readiness: ExactChildSettingsReadiness;
}): ExactChildSettingsTarget {
  const exact = buildExactChildSettingsTarget(input);
  if (exact) return exact;
  const feature = input.features.find(
    (item) =>
      item.currentWorkerProviderSessionId === input.childSessionId ||
      item.completedWorkerProviderSessionId === input.childSessionId ||
      item.workerProviderSessionIds?.includes(input.childSessionId),
  );
  return {
    parentAppSessionId: input.parentAppSessionId,
    childSessionId: input.childSessionId,
    role: feature ? featureChildRole(feature) : 'worker',
    label: input.label,
    modelId: input.child?.modelId,
    reasoningEffort: input.child?.reasoningEffort,
    readiness: 'failed',
  };
}

export function planChildModelUpdate(
  target: ExactChildSettingsTarget,
  modelId: string | undefined,
  currentReasoning: ReasoningEffort,
  models: readonly ModelInfo[],
): ChildSettingsUpdate | undefined {
  if (target.readiness !== 'ready') return undefined;
  const next = modelId ? models.find((model) => model.id === modelId) : undefined;
  const compatibleReasoning = compatibleReasoningForModel(next, currentReasoning);
  return {
    parentAppSessionId: target.parentAppSessionId,
    childSessionId: target.childSessionId,
    modelId: modelId ?? null,
    ...(compatibleReasoning === undefined ? {} : { reasoningEffort: compatibleReasoning }),
  };
}

function compatibleReasoningForModel(
  model: ModelInfo | undefined,
  currentReasoning: ReasoningEffort,
): ReasoningEffort | undefined {
  if (!model) return undefined;
  const supported = model.supportedReasoningEfforts;
  if (supported?.length)
    return supported.includes(currentReasoning)
      ? undefined
      : (model.defaultReasoningEffort ?? supported.at(-1));
  if (model.defaultReasoningEffort && currentReasoning !== model.defaultReasoningEffort)
    return model.defaultReasoningEffort;
  return undefined;
}
