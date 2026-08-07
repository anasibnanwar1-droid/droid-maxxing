import {
  DecompSessionType,
  type AskUserHandler,
  type McpServerConfig,
  type MissionFeature,
  type PermissionHandler,
} from '@factory/droid-sdk';
import { homedir } from 'node:os';
import type { CreateRuntimeSessionOptions } from './DroidRuntime.js';
import type {
  Autonomy,
  ClientCommand,
  FactoryDefaultSettings,
  ReasoningEffort,
  SessionInteractionMode,
  SessionPhase,
  SessionSummary,
} from './protocol.js';
import type { CompactionTokenLimitPatch } from './compaction.js';
import { mapFeature } from './normalize.js';
import { stringValue } from './values.js';

export interface SessionInitResult {
  cwd?: string | undefined;
  session?:
    | {
        decompSessionType?: unknown;
        decompMissionId?: unknown;
        cwd?: unknown;
        title?: unknown;
        sessionTitle?: unknown;
        [key: string]: unknown;
      }
    | undefined;
  settings?:
    | {
        modelId?: string | undefined;
        reasoningEffort?: string | undefined;
        compactionModel?: string | undefined;
        compactionTokenLimit?: number | undefined;
        compactionTokenLimitPerModel?: Record<string, number> | undefined;
        interactionMode?: string | undefined;
        autonomyLevel?: string | undefined;
      }
    | undefined;
  mission?: { state?: string | undefined; features?: MissionFeature[] | undefined } | undefined;
}

const STATE_TO_PHASE: Record<string, SessionPhase> = {
  initializing: 'initializing',
  running: 'running',
  paused: 'paused',
  orchestrator_turn: 'orchestrator_turn',
  completed: 'completed',
  failed: 'failed',
  awaiting_input: 'running',
};

export function normalizeAutonomy(value: unknown): Autonomy | undefined {
  if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

export function uniqueStrings(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function defaultsModeForSummary(summary: SessionSummary): SessionInteractionMode {
  if (summary.sessionPurpose === 'mission-control') return 'agi';
  if (summary.interactionMode === 'spec') return 'spec';
  return 'auto';
}

export function reasoningValue(value?: string): ReasoningEffort | undefined {
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

function classifySession(
  init: SessionInitResult,
  historical?: SessionSummary,
): Pick<SessionSummary, 'sessionPurpose' | 'interactionMode' | 'role' | 'missionId'> {
  const session = init.session ?? {};
  const decompType = stringValue(session.decompSessionType);
  const missionId = stringValue(session.decompMissionId) ?? historical?.missionId;

  if (decompType === 'worker' || decompType === 'validator') {
    throw new Error('Child provider sessions cannot be resumed as top-level sessions.');
  }

  const mode = init.settings?.interactionMode ?? (init.mission ? 'agi' : undefined);
  if (isMissionControl(init, historical, decompType, missionId)) {
    return missionControlClassification(mode, historical, missionId);
  }
  return standardSessionClassification(mode, historical);
}

function standardSessionClassification(
  mode: string | undefined,
  historical?: SessionSummary,
): ReturnType<typeof classifySession> {
  if (mode === 'spec' || historical?.interactionMode === 'spec') {
    return {
      sessionPurpose: historical?.sessionPurpose ?? 'chat',
      interactionMode: 'spec',
      role: 'primary',
    };
  }

  return {
    sessionPurpose: historical?.sessionPurpose ?? 'chat',
    interactionMode: mode === 'agi' ? 'agi' : 'auto',
    role: 'primary',
  };
}

function isMissionControl(
  init: SessionInitResult,
  historical: SessionSummary | undefined,
  decompType: string | undefined,
  missionId: string | undefined,
): boolean {
  return (
    decompType === 'orchestrator' ||
    Boolean(missionId) ||
    historical?.sessionPurpose === 'mission-control' ||
    (Boolean(init.mission) && !historical?.sessionPurpose)
  );
}

function missionControlClassification(
  mode: string | undefined,
  historical: SessionSummary | undefined,
  missionId: string | undefined,
): ReturnType<typeof classifySession> {
  const resolvedMissionId = missionId ?? historical?.appSessionId;
  const interactionMode =
    mode === 'auto' || mode === 'spec' || mode === 'agi'
      ? mode
      : (historical?.interactionMode ?? 'agi');
  return {
    sessionPurpose: 'mission-control',
    interactionMode,
    role: 'primary',
    ...(resolvedMissionId !== undefined ? { missionId: resolvedMissionId } : {}),
  };
}

export function phaseFromState(state?: string): SessionPhase | undefined {
  return state ? STATE_TO_PHASE[state] : undefined;
}

function phaseFromInit(init: SessionInitResult): SessionPhase {
  return phaseFromState(init.mission?.state) ?? 'paused';
}

// session.create must carry an explicit autonomy snapshot chosen by the
// sender; the sidecar never invents one. Anything missing or invalid fails
// fast instead of silently falling back to a default.
export function requireAutonomyForCommand(command: { autonomy?: Autonomy }): Autonomy {
  const autonomy = normalizeAutonomy(command.autonomy);
  if (!autonomy) {
    throw new Error(
      'session.create requires an explicit autonomy level (off, low, medium, or high)',
    );
  }
  return autonomy;
}

export function createModelDefaultsForMode(
  mode: SessionInteractionMode,
  command: { modelId?: string; reasoningEffort?: ReasoningEffort },
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
  const modelId = command.modelId ?? modelDefaultForMode(mode, defaults);
  const reasoningEffort = command.reasoningEffort ?? reasoningDefaultForMode(mode, defaults);
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

export function createMissionAgentDefaultsForMode(
  mode: SessionInteractionMode,
  command: {
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
  SessionSummary,
  'workerModelId' | 'workerReasoningEffort' | 'validatorModelId' | 'validatorReasoningEffort'
> {
  if (mode !== 'agi') return {};
  const workerModelId = command.workerModel ?? defaults.workerModelId;
  const workerReasoningEffort = command.workerReasoning ?? defaults.workerReasoningEffort;
  const validatorModelId = command.validatorModel ?? defaults.validatorModelId;
  const validatorReasoningEffort = command.validatorReasoning ?? defaults.validatorReasoningEffort;
  return {
    ...(workerModelId !== undefined ? { workerModelId } : {}),
    ...(workerReasoningEffort !== undefined ? { workerReasoningEffort } : {}),
    ...(validatorModelId !== undefined ? { validatorModelId } : {}),
    ...(validatorReasoningEffort !== undefined ? { validatorReasoningEffort } : {}),
  };
}

type SessionCreateCommand = Extract<ClientCommand, { type: 'session.create' }>;

export function createInteractionModeForCommand(
  command: SessionCreateCommand,
  defaults: FactoryDefaultSettings,
): SessionInteractionMode {
  if (command.interactionMode) return command.interactionMode;
  if (command.sessionPurpose === 'mission-control') return 'agi';
  return defaults.interactionMode ?? 'auto';
}

export function createDefaultsModeForCommand(
  command: SessionCreateCommand,
  interactionMode: SessionInteractionMode,
): SessionInteractionMode {
  if (command.sessionPurpose === 'mission-control') return 'agi';
  return interactionMode === 'spec' ? 'spec' : 'auto';
}

export function buildCreateRuntimeOptions(input: {
  command: SessionCreateCommand;
  appCwd: string;
  interactionMode: SessionInteractionMode;
  primary: { modelId?: string; reasoningEffort?: ReasoningEffort };
  agents: Pick<
    SessionSummary,
    'workerModelId' | 'workerReasoningEffort' | 'validatorModelId' | 'validatorReasoningEffort'
  >;
  defaults: FactoryDefaultSettings;
  autonomy: Autonomy;
  compactionModel: string;
  compactionTokenLimit: number;
  mcpServers: McpServerConfig[];
  permissionHandler: PermissionHandler;
  askUserHandler: AskUserHandler;
}): CreateRuntimeSessionOptions {
  const usePrimaryForSpec =
    input.interactionMode === 'spec' ||
    Boolean(input.command.modelId) ||
    Boolean(input.command.reasoningEffort);
  const specModeModelId = usePrimaryForSpec ? input.primary.modelId : input.defaults.specModelId;
  const specModeReasoningEffort = usePrimaryForSpec
    ? input.primary.reasoningEffort
    : input.defaults.specReasoningEffort;
  return {
    cwd: input.appCwd.length > 0 ? input.appCwd : homedir(),
    interactionMode: input.interactionMode,
    ...(input.primary.modelId !== undefined ? { modelId: input.primary.modelId } : {}),
    autonomyLevel: input.autonomy,
    ...(input.primary.reasoningEffort !== undefined
      ? { reasoningEffort: input.primary.reasoningEffort }
      : {}),
    ...(specModeModelId !== undefined ? { specModeModelId } : {}),
    ...(specModeReasoningEffort !== undefined ? { specModeReasoningEffort } : {}),
    ...(input.command.sessionPurpose === 'mission-control'
      ? { decompSessionType: DecompSessionType.Orchestrator }
      : {}),
    ...input.agents,
    compactionModel: input.compactionModel,
    compactionTokenLimit: input.compactionTokenLimit,
    compactionThresholdCheckEnabled: true,
    mcpServers: input.mcpServers,
    permissionHandler: input.permissionHandler,
    askUserHandler: input.askUserHandler,
  };
}

export function buildCreatedSessionSummary(input: {
  command: SessionCreateCommand;
  appSessionId: string;
  interactionMode: SessionInteractionMode;
  primary: { modelId?: string; reasoningEffort?: ReasoningEffort };
  compactionModel: string;
  agents: Pick<
    SessionSummary,
    'workerModelId' | 'workerReasoningEffort' | 'validatorModelId' | 'validatorReasoningEffort'
  >;
  autonomy: Autonomy;
  maxContextTokens?: number;
  compactionTokenLimit?: number;
  now: number;
}): SessionSummary {
  const { command, appSessionId, primary, agents } = input;
  const cwd = command.cwd ?? '';
  return {
    appSessionId,
    providerSessionId: appSessionId,
    ...(command.sessionPurpose === 'mission-control' ? { missionId: appSessionId } : {}),
    sessionPurpose: command.sessionPurpose,
    interactionMode: input.interactionMode,
    role: 'primary',
    title: command.title,
    goal: command.goal,
    cwd,
    workspaceKind: cwd ? 'folder' : 'none',
    ...(primary.modelId !== undefined ? { modelId: primary.modelId } : {}),
    ...(primary.reasoningEffort !== undefined ? { reasoningEffort: primary.reasoningEffort } : {}),
    compactionModel: input.compactionModel,
    ...agents,
    autonomy: input.autonomy,
    phase: 'intake',
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    ...(input.maxContextTokens !== undefined ? { maxContextTokens: input.maxContextTokens } : {}),
    ...(input.compactionTokenLimit !== undefined
      ? { compactionTokenLimit: input.compactionTokenLimit }
      : {}),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

interface BuildResumedSessionInput {
  init: SessionInitResult;
  historical?: SessionSummary | undefined;
  appSessionId: string;
  providerSessionId: string;
  defaults: FactoryDefaultSettings;
  maxContextTokensForModel: (modelId?: string) => number | undefined;
  now: number;
}

export function buildResumedSession(input: BuildResumedSessionInput): {
  summary: SessionSummary;
  exposedCompaction: CompactionTokenLimitPatch;
} {
  const classification = classifySession(input.init, input.historical);
  return {
    summary: {
      appSessionId: input.appSessionId,
      providerSessionId: input.providerSessionId,
      compactedFromProviderSessionIds: input.historical?.compactedFromProviderSessionIds ?? [],
      ...classification,
      ...resumedLocation(input),
      ...resumedModelSettings(input),
      phase:
        classification.sessionPurpose === 'mission-control'
          ? phaseFromInit(input.init)
          : (input.historical?.phase ?? 'paused'),
      streaming: false,
      queuedSends: 0,
      ...(input.historical?.proposal !== undefined ? { proposal: input.historical.proposal } : {}),
      features: resumedFeatures(input.init, classification.sessionPurpose),
      ...resumedUsage(input.historical),
      createdAt: input.historical?.createdAt ?? input.now,
      // Resuming (to read or to prepare a send) is not user-visible activity:
      // keep the historical updatedAt so the session does not jump to the top
      // of the sidebar or read as unread. A real turn moves it when it settles.
      updatedAt: input.historical?.updatedAt ?? input.now,
    },
    exposedCompaction: exposedCompaction(input.init),
  };
}

function resumedLocation(
  input: BuildResumedSessionInput,
): Pick<SessionSummary, 'title' | 'goal' | 'cwd' | 'workspaceKind'> {
  const historical = input.historical;
  const cwd =
    historical?.workspaceKind === 'none'
      ? ''
      : firstNonEmpty(
          stringValue(input.init.cwd),
          stringValue(input.init.session?.cwd),
          historical?.cwd,
        );
  const title = firstNonEmpty(
    stringValue(input.init.session?.title),
    stringValue(input.init.session?.sessionTitle),
    historical?.title,
  );
  return {
    title: title.length > 0 ? title : `Session ${input.providerSessionId.slice(0, 8)}`,
    goal: historical?.goal ?? '',
    cwd,
    workspaceKind: cwd ? 'folder' : (historical?.workspaceKind ?? 'none'),
  };
}

type ResumedModelSettings = Pick<SessionSummary, 'autonomy' | 'compactionModel'> &
  Partial<
    Pick<
      SessionSummary,
      | 'modelId'
      | 'reasoningEffort'
      | 'workerModelId'
      | 'workerReasoningEffort'
      | 'validatorModelId'
      | 'validatorReasoningEffort'
      | 'maxContextTokens'
    >
  >;

function resumedModelSettings(input: BuildResumedSessionInput): ResumedModelSettings {
  return {
    ...resumedBaseModelSettings(input),
    ...resumedPrimaryModelSettings(input),
    ...resumedAgentSettings(input.historical, input.defaults),
  };
}

function resumedBaseModelSettings(
  input: BuildResumedSessionInput,
): Pick<ResumedModelSettings, 'autonomy' | 'compactionModel'> {
  const { init, historical, defaults } = input;
  return {
    compactionModel:
      init.settings?.compactionModel ??
      historical?.compactionModel ??
      defaults.compactionModel ??
      'current-model',
    autonomy:
      normalizeAutonomy(init.settings?.autonomyLevel) ??
      historical?.autonomy ??
      defaults.autonomy ??
      'low',
  };
}

function resumedPrimaryModelSettings(
  input: BuildResumedSessionInput,
): Partial<ResumedModelSettings> {
  const { init, historical, defaults } = input;
  const modelId = init.settings?.modelId ?? historical?.modelId ?? defaults.modelId;
  const reasoningEffort =
    reasoningValue(init.settings?.reasoningEffort) ??
    historical?.reasoningEffort ??
    defaults.reasoningEffort;
  const maxContextTokens = historical?.maxContextTokens ?? input.maxContextTokensForModel(modelId);
  const settings: Partial<ResumedModelSettings> = {};
  if (modelId !== undefined) settings.modelId = modelId;
  if (reasoningEffort !== undefined) settings.reasoningEffort = reasoningEffort;
  if (maxContextTokens !== undefined) settings.maxContextTokens = maxContextTokens;
  return settings;
}

function resumedAgentSettings(
  historical: SessionSummary | undefined,
  defaults: FactoryDefaultSettings,
): Partial<ResumedModelSettings> {
  const workerModelId = historical?.workerModelId ?? defaults.workerModelId;
  const workerReasoningEffort = historical?.workerReasoningEffort ?? defaults.workerReasoningEffort;
  const validatorModelId = historical?.validatorModelId ?? defaults.validatorModelId;
  const validatorReasoningEffort =
    historical?.validatorReasoningEffort ?? defaults.validatorReasoningEffort;
  const settings: Partial<ResumedModelSettings> = {};
  if (workerModelId !== undefined) settings.workerModelId = workerModelId;
  if (workerReasoningEffort !== undefined) settings.workerReasoningEffort = workerReasoningEffort;
  if (validatorModelId !== undefined) settings.validatorModelId = validatorModelId;
  if (validatorReasoningEffort !== undefined)
    settings.validatorReasoningEffort = validatorReasoningEffort;
  return settings;
}

type ResumedUsage = Pick<SessionSummary, 'tokensIn' | 'tokensOut' | 'contextTokens'> &
  Partial<
    Pick<
      SessionSummary,
      'contextRemainingTokens' | 'contextAccuracy' | 'contextUpdatedAt' | 'autoCompactions'
    >
  >;

function resumedUsage(historical?: SessionSummary): ResumedUsage {
  return {
    tokensIn: historical?.tokensIn ?? 0,
    tokensOut: historical?.tokensOut ?? 0,
    // Current-context telemetry is live provider state, not durable session
    // history. A resumed session refreshes it immediately; carrying an old
    // exact stream reading across clients can pin the meter at 100% forever.
    contextTokens: 0,
    ...(historical?.autoCompactions !== undefined
      ? { autoCompactions: historical.autoCompactions }
      : {}),
  };
}

function resumedFeatures(
  init: SessionInitResult,
  purpose: SessionSummary['sessionPurpose'],
): SessionSummary['features'] {
  return purpose === 'mission-control' ? (init.mission?.features ?? []).map(mapFeature) : [];
}

function exposedCompaction(init: SessionInitResult): CompactionTokenLimitPatch {
  return {
    ...(init.settings?.compactionTokenLimit !== undefined
      ? { compactionTokenLimit: init.settings.compactionTokenLimit }
      : {}),
    ...(init.settings?.compactionTokenLimitPerModel !== undefined
      ? { compactionTokenLimitPerModel: init.settings.compactionTokenLimitPerModel }
      : {}),
  };
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  return values.find(Boolean) ?? '';
}

export function modelDefaultForMode(
  mode: SessionInteractionMode,
  defaults: Pick<FactoryDefaultSettings, 'modelId' | 'specModelId' | 'missionOrchestratorModelId'>,
): string | undefined {
  if (mode === 'spec') return defaults.specModelId ?? defaults.modelId;
  if (mode === 'agi') return defaults.missionOrchestratorModelId ?? defaults.modelId;
  return defaults.modelId;
}

function reasoningDefaultForMode(
  mode: SessionInteractionMode,
  defaults: Pick<
    FactoryDefaultSettings,
    'reasoningEffort' | 'specReasoningEffort' | 'missionOrchestratorReasoningEffort'
  >,
): ReasoningEffort | undefined {
  if (mode === 'spec') return defaults.specReasoningEffort ?? defaults.reasoningEffort;
  if (mode === 'agi') {
    return defaults.missionOrchestratorReasoningEffort ?? defaults.reasoningEffort;
  }
  return defaults.reasoningEffort;
}

// A user Stop/interrupt makes the SDK stream throw (a cancellation message or an
// AbortError). That is a deliberate stop, not a failure, so callers must settle
// quietly instead of surfacing it as an error.
export function isUserCancellation(err: unknown): boolean {
  if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') return true;
  const m = errMsg(err).toLowerCase();
  return (
    m.includes('interrupted by user') ||
    m.includes('cancelled by user') ||
    m.includes('canceled by user') ||
    m.includes('request interrupted') ||
    m.includes('request cancelled') ||
    m.includes('request canceled')
  );
}
