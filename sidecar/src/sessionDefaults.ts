import { normalizeCompactionTokenLimit } from './compaction.js';
import type {
  Autonomy,
  ConfigurableAgent,
  FactoryDefaultSettings,
  MissionSummary,
  ModelInfo,
  ReasoningEffort,
  SessionInteractionMode,
} from './protocol.js';

export interface AgentSettingPatch {
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
}

export function normalizeAutonomy(value: unknown): Autonomy | undefined {
  if (value === 'none') return 'off';
  if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

export function createAutonomyForCommand(
  cmd: { autonomy?: Autonomy | 'none' },
  defaults: Pick<FactoryDefaultSettings, 'autonomy'>,
): Autonomy {
  return normalizeAutonomy(cmd.autonomy) ?? defaults.autonomy ?? 'low';
}

export function createModelDefaultsForMode(
  mode: SessionInteractionMode,
  cmd: { modelId?: string; reasoningEffort?: ReasoningEffort },
  defaults: Pick<
    FactoryDefaultSettings,
    | 'modelId'
    | 'reasoningEffort'
    | 'specModelId'
    | 'specReasoningEffort'
    | 'missionOrchestratorModelId'
    | 'missionOrchestratorReasoningEffort'
  >,
): { modelId?: string; reasoningEffort?: ReasoningEffort } {
  if (cmd.modelId || cmd.reasoningEffort) {
    return {
      modelId: cmd.modelId ?? modelDefaultForMode(mode, defaults),
      reasoningEffort: cmd.reasoningEffort ?? reasoningDefaultForMode(mode, defaults),
    };
  }
  return {
    modelId: modelDefaultForMode(mode, defaults),
    reasoningEffort: reasoningDefaultForMode(mode, defaults),
  };
}

export function createMissionAgentDefaultsForMode(
  mode: SessionInteractionMode,
  cmd: {
    workerModel?: string;
    workerReasoning?: ReasoningEffort;
    validatorModel?: string;
    validatorReasoning?: ReasoningEffort;
  },
  defaults: Pick<
    FactoryDefaultSettings,
    'workerModelId' | 'workerReasoningEffort' | 'validatorModelId' | 'validatorReasoningEffort'
  >,
): Pick<
  MissionSummary,
  'workerModelId' | 'workerReasoningEffort' | 'validatorModelId' | 'validatorReasoningEffort'
> {
  if (mode !== 'agi') return {};
  return {
    workerModelId: cmd.workerModel ?? defaults.workerModelId,
    workerReasoningEffort: cmd.workerReasoning ?? defaults.workerReasoningEffort,
    validatorModelId: cmd.validatorModel ?? defaults.validatorModelId,
    validatorReasoningEffort: cmd.validatorReasoning ?? defaults.validatorReasoningEffort,
  };
}

export function createSessionSettingsForAgent(
  agent: ConfigurableAgent,
  settings: AgentSettingPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  if (agent === 'orchestrator') {
    if (settings.modelId) next.modelId = settings.modelId;
    if (settings.reasoningEffort !== undefined) next.reasoningEffort = settings.reasoningEffort;
    return next;
  }

  const missionSettings: Record<string, unknown> = {};
  if (agent === 'worker') {
    if (settings.modelId) missionSettings.workerModel = settings.modelId;
    if (settings.reasoningEffort !== undefined)
      missionSettings.workerReasoningEffort = settings.reasoningEffort;
  } else {
    if (settings.modelId) missionSettings.validationWorkerModel = settings.modelId;
    if (settings.reasoningEffort !== undefined)
      missionSettings.validationWorkerReasoningEffort = settings.reasoningEffort;
  }

  if (Object.keys(missionSettings).length > 0) next.missionSettings = missionSettings;
  return next;
}

export function startupFactoryDefaults(
  defaults: FactoryDefaultSettings,
  models: ModelInfo[],
): FactoryDefaultSettings {
  if (models.length > 0) return validateFactoryDefaults(defaults, models);
  const safe: FactoryDefaultSettings = {
    autonomy: defaults.autonomy,
    interactionMode: defaults.interactionMode,
    compactionTokenLimit: normalizeCompactionTokenLimit(defaults.compactionTokenLimit),
    compactionTokenLimitPerModel: validCompactionTokenLimitRecord(
      defaults.compactionTokenLimitPerModel,
    ),
  };
  if (defaults.compactionModel === 'current-model') safe.compactionModel = 'current-model';
  return safe;
}

export function validateFactoryDefaults(
  defaults: FactoryDefaultSettings,
  models: ModelInfo[],
): FactoryDefaultSettings {
  if (models.length === 0) return runtimeFactoryDefaultsWithoutCatalog(defaults);
  const cliDefault =
    models.find((model) => model.isDefault && !model.isCustom) ??
    models.find((model) => !model.isCustom) ??
    models[0];
  return {
    ...defaults,
    modelId: validModelId(defaults.modelId, models) ?? cliDefault?.id,
    reasoningEffort:
      validReasoning(defaults.modelId, defaults.reasoningEffort, models) ??
      cliDefault?.defaultReasoningEffort,
    compactionModel: validCompactionModel(defaults.compactionModel, models),
    compactionTokenLimit: normalizeCompactionTokenLimit(defaults.compactionTokenLimit),
    compactionTokenLimitPerModel: validCompactionTokenLimitPerModel(
      defaults.compactionTokenLimitPerModel,
      models,
    ),
    specModelId:
      validModelId(defaults.specModelId, models) ??
      validModelId(defaults.modelId, models) ??
      cliDefault?.id,
    specReasoningEffort: validReasoning(defaults.specModelId, defaults.specReasoningEffort, models),
    workerModelId: validModelId(defaults.workerModelId, models) ?? cliDefault?.id,
    workerReasoningEffort: validReasoning(
      defaults.workerModelId,
      defaults.workerReasoningEffort,
      models,
    ),
    validatorModelId: validModelId(defaults.validatorModelId, models) ?? cliDefault?.id,
    validatorReasoningEffort: validReasoning(
      defaults.validatorModelId,
      defaults.validatorReasoningEffort,
      models,
    ),
  };
}

function runtimeFactoryDefaultsWithoutCatalog(
  defaults: FactoryDefaultSettings,
): FactoryDefaultSettings {
  return {
    ...defaults,
    compactionTokenLimit: normalizeCompactionTokenLimit(defaults.compactionTokenLimit),
    compactionTokenLimitPerModel: validCompactionTokenLimitRecord(
      defaults.compactionTokenLimitPerModel,
    ),
  };
}

function validModelId(modelId: string | undefined, models: ModelInfo[]): string | undefined {
  return modelId && models.some((model) => model.id === modelId) ? modelId : undefined;
}

function validReasoning(
  modelId: string | undefined,
  reasoning: ReasoningEffort | undefined,
  models: ModelInfo[],
): ReasoningEffort | undefined {
  const model = modelId ? models.find((item) => item.id === modelId) : undefined;
  if (!model) return undefined;
  const supported = model.supportedReasoningEfforts;
  if (reasoning && (!supported || supported.includes(reasoning))) return reasoning;
  return model.defaultReasoningEffort ?? supported?.[0];
}

function validCompactionModel(modelId: string | undefined, models: ModelInfo[]): string {
  if (!modelId || modelId === 'current-model') return 'current-model';
  return validModelId(modelId, models) ?? 'current-model';
}

function validCompactionTokenLimitRecord(
  limits: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!limits) return undefined;
  const entries = Object.entries(limits)
    .map(([modelId, limit]) => [modelId, normalizeCompactionTokenLimit(limit)] as const)
    .filter((entry): entry is [string, number] => Boolean(entry[0]) && entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function validCompactionTokenLimitPerModel(
  limits: Record<string, number> | undefined,
  models: ModelInfo[],
): Record<string, number> | undefined {
  if (!limits) return undefined;
  const modelIds = new Set(models.map((model) => model.id));
  const entries = Object.entries(limits)
    .map(([modelId, limit]) => [modelId, normalizeCompactionTokenLimit(limit)] as const)
    .filter((entry): entry is [string, number] => modelIds.has(entry[0]) && entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function modelDefaultForMode(
  mode: SessionInteractionMode,
  defaults: Pick<FactoryDefaultSettings, 'modelId' | 'specModelId' | 'missionOrchestratorModelId'>,
): string | undefined {
  if (mode === 'spec') return defaults.specModelId ?? defaults.modelId;
  if (mode === 'agi') return defaults.missionOrchestratorModelId ?? defaults.modelId;
  return defaults.modelId;
}

export function defaultModelForAgent(
  agent: ConfigurableAgent,
  mode: SessionInteractionMode,
  defaults: FactoryDefaultSettings,
): string | undefined {
  if (agent === 'worker') return defaults.workerModelId;
  if (agent === 'validator') return defaults.validatorModelId;
  return modelDefaultForMode(mode, defaults);
}

export function modeForKind(kind: MissionSummary['kind']): SessionInteractionMode {
  if (kind === 'spec') return 'spec';
  if (kind === 'mission_orchestrator') return 'agi';
  return 'auto';
}

export function modeForSummary(summary: MissionSummary): SessionInteractionMode {
  return modeForKind(summary.kind);
}

function reasoningDefaultForMode(
  mode: SessionInteractionMode,
  defaults: Pick<
    FactoryDefaultSettings,
    'reasoningEffort' | 'specReasoningEffort' | 'missionOrchestratorReasoningEffort'
  >,
): ReasoningEffort | undefined {
  if (mode === 'spec') return defaults.specReasoningEffort ?? defaults.reasoningEffort;
  if (mode === 'agi')
    return defaults.missionOrchestratorReasoningEffort ?? defaults.reasoningEffort;
  return defaults.reasoningEffort;
}
