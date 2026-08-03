import type { ChildSessionSummary, ModelInfo, ReasoningEffort } from '../types/bridge';
import type { VisibleSessionTarget } from './childSessions';

type ExactChildRole = 'worker' | 'validator';
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

export function childSettingsReadinessLabel(readiness: ExactChildSettingsReadiness): string {
  if (readiness === 'ready') return 'Ready';
  if (readiness === 'opening') return 'Opening child…';
  return 'Child unavailable';
}

export function buildSelectedChildSettingsTarget(input: {
  parentAppSessionId: string;
  childSessionId: string;
  child?: Pick<ChildSessionSummary, 'role' | 'modelId' | 'reasoningEffort'>;
  label: string;
  readiness: ExactChildSettingsReadiness;
}): ExactChildSettingsTarget {
  return {
    parentAppSessionId: input.parentAppSessionId,
    childSessionId: input.childSessionId,
    role: input.child?.role ?? 'worker',
    label: input.label,
    modelId: input.child?.modelId,
    reasoningEffort: input.child?.reasoningEffort,
    readiness: input.child ? input.readiness : 'failed',
  };
}

export function buildVisibleChildSettingsTarget(
  target: VisibleSessionTarget,
  label: string,
): ExactChildSettingsTarget | undefined {
  if (target.kind !== 'child') return undefined;
  return buildSelectedChildSettingsTarget({
    parentAppSessionId: target.parentAppSessionId,
    childSessionId: target.childSessionId,
    child: target.child,
    label,
    readiness: target.settingsReadiness,
  });
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
