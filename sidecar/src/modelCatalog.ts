import type { ModelInfo, ReasoningEffort } from './protocol.js';

type ModelRecord = Record<string, unknown>;

export function mergeModelCatalog(sdkModels: Array<ModelRecord | ModelInfo>): ModelInfo[] {
  const merged = new Map<string, ModelInfo>();
  const add = (model: ModelInfo) => {
    if (!model.id) return;
    const previous = merged.get(model.id);
    merged.set(model.id, previous ? { ...model, ...previous, isCustom: previous.isCustom || model.isCustom } : model);
  };

  sdkModels.map(fromSdkModel).forEach(add);

  return [...merged.values()].sort((a, b) => {
    if (a.isCustom !== b.isCustom) return a.isCustom ? 1 : -1;
    return a.displayName.localeCompare(b.displayName);
  });
}

function fromSdkModel(model: ModelRecord | ModelInfo): ModelInfo {
  const raw = model as ModelRecord;
  const id = stringValue(raw.id) || stringValue(raw.modelId) || stringValue(raw.model) || '';
  return {
    id,
    displayName: stringValue(raw.displayName) || stringValue(raw.shortDisplayName) || id,
    provider: stringValue(raw.modelProvider) || stringValue(raw.provider),
    isCustom: Boolean(raw.isCustom) || id.startsWith('custom:'),
    isDefault: Boolean(raw.isDefault),
    maxContextTokens: numberValue(raw.maxContextLimit) ?? numberValue(raw.maxContextTokens),
    supportedReasoningEfforts: reasoningArray(raw.supportedReasoningEfforts),
    defaultReasoningEffort: reasoningValue(raw.defaultReasoningEffort),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value ?? 0) || 0;
  return number > 0 ? number : undefined;
}

function reasoningArray(value: unknown): ReasoningEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const efforts = value.map(reasoningValue).filter(Boolean) as ReasoningEffort[];
  return efforts.length > 0 ? efforts : undefined;
}

function reasoningValue(value: unknown): ReasoningEffort | undefined {
  if (
    value === 'off' ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'dynamic'
  ) {
    return value;
  }
  return undefined;
}
