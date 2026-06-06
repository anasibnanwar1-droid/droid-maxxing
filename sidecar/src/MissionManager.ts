import {
  ContextBreakdownResultSchema,
  DecompSessionType,
  DroidInteractionMode,
  type AskUserHandler,
  type ContextBreakdownResult,
  type AskUserRequestParams,
  type AskUserResult,
  type DroidSession,
  type GetContextStatsResult,
  type PermissionHandler,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';
import { homedir, tmpdir } from 'node:os';
import type {
  AgentRole,
  Autonomy,
  ClientCommand,
  ConfigurableAgent,
  ContextBreakdownSnapshot,
  ContextStatsSnapshot,
  FactoryDefaultSettings,
  HistoryMission,
  MissionPhase,
  MissionSummary,
  ModelInfo,
  PermissionKind,
  ReasoningEffort,
  ServerEvent,
  SessionInteractionMode,
  SessionKind,
  TranscriptEvent,
} from './protocol.js';
import { DroidRuntime } from './DroidRuntime.js';
import { classifyPermission, confirmationType, mapFeature, normalizeNotification, normalizeStreamEvent } from './normalize.js';
import {
  HistoryIndex,
  hydrateHistoricalMission,
  loadHistoricalMissions,
  loadHistoricalSessions,
  loadSessionHistory,
  loadSessionPage,
  readFactoryDefaults,
} from './history.js';
import { mergeModelCatalog } from './modelCatalog.js';
import { readDroidCliModelCatalog } from './DroidCliCatalog.js';

type Emit = (event: ServerEvent) => void;

interface LiveAgent {
  session: DroidSession;
  missionId: string;
  role: AgentRole;
  streaming: boolean;
  pendingSends: string[];
  unsubscribe?: () => void;
}

interface Mission {
  summary: MissionSummary;
  session: DroidSession;
  streaming: boolean;
  pendingSends: string[];
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, (r: AskUserResult) => void>;
  agents: Map<string, LiveAgent>;
  knownSubagents: Set<string>;
  lastSubagentLabel?: string;
}

interface PendingPermission {
  resolve: (r: RequestPermissionHandlerResult) => void;
  kind: PermissionKind;
}

interface AgentSettingPatch {
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
}

interface UsageOffset {
  tokensIn: number;
  tokensOut: number;
}

const STATE_TO_PHASE: Record<string, MissionPhase> = {
  initializing: 'initializing',
  running: 'running',
  paused: 'paused',
  orchestrator_turn: 'orchestrator_turn',
  completed: 'completed',
  failed: 'failed',
  awaiting_input: 'running',
};

let permSeq = 0;
const nextRequestId = () => `req-${Date.now().toString(36)}-${(permSeq++).toString(36)}`;

export class MissionManager {
  private ready = false;
  private cachedModels: ModelInfo[] | null = null;
  private readonly runtime = new DroidRuntime();
  private readonly history = new HistoryIndex();
  private readonly missions = new Map<string, Mission>();
  private readonly pendingAgentSettings = new Map<string, Partial<Record<ConfigurableAgent, AgentSettingPatch>>>();
  private readonly usageOffsets = new Map<string, UsageOffset>();
  private readonly contextSnapshots = new Map<string, ContextStatsSnapshot>();
  private readonly contextPollers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly emit: Emit) {}

  connect(apiKey?: string): void {
    this.runtime.connect(apiKey);
    this.ready = true;
    this.emit({ type: 'connection', status: 'connected' });
    this.emit({ type: 'runtime.updated', status: this.runtime.status() });
  }

  async handle(cmd: ClientCommand): Promise<void> {
    switch (cmd.type) {
      case 'connect':
        this.connect(cmd.apiKey);
        return;
      case 'runtime.status':
      case 'auth.status':
        this.emit({ type: 'runtime.updated', status: this.runtime.status() });
        return;
      case 'auth.startCliLogin':
        await this.runtime.startCliLogin();
        this.emit({ type: 'runtime.updated', status: this.runtime.status() });
        return;
      case 'catalog.models':
      case 'models.list': {
        const models = await this.getModels();
        this.emit({ type: 'models.list', models });
        this.emit({ type: 'catalog.updated', catalog: 'models', items: models });
        return;
      }
      case 'catalog.tools':
        await this.emitToolCatalog(cmd.sessionId);
        return;
      case 'catalog.skills':
        await this.emitSkillCatalog(cmd.sessionId);
        return;
      case 'catalog.mcp':
        await this.emitMcpCatalog(cmd.sessionId);
        return;
      case 'settings.defaults':
        await this.emitFactoryDefaults();
        return;
      case 'session.create':
        await this.createMission({ ...cmd, type: 'mission.create' });
        return;
      case 'mission.create':
        await this.createMission(cmd);
        return;
      case 'session.send':
      case 'mission.send':
        await this.send('sessionId' in cmd ? cmd.sessionId : cmd.missionId, cmd.text);
        return;
      case 'approval.respond':
      case 'mission.respondPermission':
        await this.resolvePermission(cmd.missionId, cmd.requestId, cmd.outcome);
        return;
      case 'question.respond':
      case 'mission.respondQuestion':
        this.resolveQuestion(cmd.missionId, cmd.requestId, cmd.cancelled, cmd.answers);
        return;
      case 'session.interrupt':
      case 'mission.interrupt':
        await this.interrupt('sessionId' in cmd ? cmd.sessionId : cmd.missionId);
        return;
      case 'agent.open':
        await this.openAgent(cmd.missionId, cmd.agentSessionId, cmd.role ?? 'worker');
        return;
      case 'mission.subscribeWorker':
        await this.openAgent(cmd.missionId, cmd.workerSessionId, 'worker');
        return;
      case 'agent.send':
        await this.sendAgent(cmd.missionId, cmd.agentSessionId, cmd.text);
        return;
      case 'agent.interrupt':
        await this.interruptAgent(cmd.missionId, cmd.agentSessionId);
        return;
      case 'session.updateSettings':
        await this.updateSessionSettings(cmd.sessionId, cmd);
        return;
      case 'session.compact':
        await this.compactSession(cmd.sessionId, cmd.customInstructions);
        return;
      case 'mission.compact':
        await this.compactSession(cmd.missionId, cmd.customInstructions);
        return;
      case 'session.fork':
        await this.withSession(cmd.sessionId, (session) => session.forkSession());
        return;
      case 'session.rename':
        await this.renameSession(cmd.sessionId, cmd.title);
        return;
      case 'session.rewindInfo':
        await this.withSession(cmd.sessionId, (session) => session.getRewindInfo({} as never));
        return;
      case 'session.rewind':
        await this.withSession(cmd.sessionId, (session) => session.executeRewind({ rewindId: cmd.rewindId } as never));
        return;
      case 'session.resume':
      case 'mission.resume':
        await this.resumeMission(cmd.sessionId);
        return;
      case 'mission.close':
        await this.closeMission(cmd.missionId);
        return;
      case 'mission.list':
        this.emitMissionList();
        return;
      case 'history.list':
      case 'sessions.list':
        await this.listHistory();
        return;
      case 'history.page':
        this.loadHistoryPage(cmd.sessionId, cmd.cursor, cmd.limit);
        return;
      case 'mission.loadHistory':
        this.loadMissionHistory(cmd.missionId);
        return;
      case 'settings.agent.update':
        await this.updateAgentSettings(cmd);
        return;
      case 'mission.setAutonomy':
        await this.setAutonomy(cmd.missionId, cmd.autonomy);
        return;
      case 'mission.setInteractionMode':
        await this.setInteractionMode(cmd.missionId, cmd.mode);
        return;
    }
  }

  private async getModels(): Promise<ModelInfo[]> {
    if (this.cachedModels) return this.cachedModels;
    try {
      const models = mergeModelCatalog(await readDroidCliModelCatalog(this.runtime.status().droidPath));
      this.cachedModels = models;
      return models;
    } catch (err) {
      this.emitError({ message: `models.list failed: ${errMsg(err)}` });
      return [];
    }
  }

  private async getFactoryDefaults(): Promise<FactoryDefaultSettings> {
    const defaults = readFactoryDefaults();
    const models = await this.getModels();
    if (models.length === 0) return defaults;
    const cliDefault = models.find((model) => model.isDefault && !model.isCustom) ?? models.find((model) => !model.isCustom) ?? models[0];
    return {
      ...defaults,
      modelId: this.validModelId(defaults.modelId, models) ?? cliDefault?.id,
      reasoningEffort: this.validReasoning(defaults.modelId, defaults.reasoningEffort, models) ?? cliDefault?.defaultReasoningEffort,
      compactionModel: this.validCompactionModel(defaults.compactionModel, models),
      specModelId: this.validModelId(defaults.specModelId, models) ?? this.validModelId(defaults.modelId, models) ?? cliDefault?.id,
      specReasoningEffort: this.validReasoning(defaults.specModelId, defaults.specReasoningEffort, models),
      workerModelId: this.validModelId(defaults.workerModelId, models) ?? cliDefault?.id,
      workerReasoningEffort: this.validReasoning(defaults.workerModelId, defaults.workerReasoningEffort, models),
      validatorModelId: this.validModelId(defaults.validatorModelId, models) ?? cliDefault?.id,
      validatorReasoningEffort: this.validReasoning(defaults.validatorModelId, defaults.validatorReasoningEffort, models),
    };
  }

  private validModelId(modelId: string | undefined, models: ModelInfo[]): string | undefined {
    return modelId && models.some((model) => model.id === modelId) ? modelId : undefined;
  }

  private validReasoning(modelId: string | undefined, reasoning: ReasoningEffort | undefined, models: ModelInfo[]): ReasoningEffort | undefined {
    const model = modelId ? models.find((item) => item.id === modelId) : undefined;
    if (!model) return undefined;
    const supported = model.supportedReasoningEfforts;
    if (reasoning && (!supported || supported.includes(reasoning))) return reasoning;
    return model.defaultReasoningEffort ?? supported?.[0];
  }

  private validCompactionModel(modelId: string | undefined, models: ModelInfo[]): string {
    if (!modelId || modelId === 'current-model') return 'current-model';
    return this.validModelId(modelId, models) ?? 'current-model';
  }

  private async emitFactoryDefaults(): Promise<void> {
    this.emit({ type: 'settings.defaults', defaults: await this.getFactoryDefaults() });
  }

  private maxContextTokensForSummary(summary: MissionSummary): number | undefined {
    return this.maxContextTokensForModel(summary.modelId);
  }

  private maxContextTokensForModel(modelId?: string): number | undefined {
    if (!modelId) return undefined;
    return this.cachedModels?.find((model) => model.id === modelId)?.maxContextTokens;
  }

  private async updateAgentSettings(cmd: Extract<ClientCommand, { type: 'settings.agent.update' }>): Promise<void> {
    try {
      if (cmd.missionId) this.rememberPendingAgentSettings(cmd);
      const mission = cmd.missionId ? this.findMission(cmd.missionId) : undefined;
      const missionId = mission?.summary.id ?? cmd.missionId;
      if (mission && cmd.agent === 'orchestrator') {
        await this.applyOrchestratorSessionSettings(mission, {
          modelId: cmd.modelId,
          reasoningEffort: cmd.reasoningEffort,
        });
      }
      if (cmd.missionId) {
        const patch = this.summaryPatchForAgent(cmd.agent, cmd);
        if (mission && missionId) this.patch(missionId, patch);
        else {
          const historical = this.resolveSummary(cmd.missionId);
          if (historical) this.emit({ type: 'mission.updated', mission: { ...historical, ...patch, updatedAt: Date.now() } });
        }
        if (mission && missionId && cmd.agent === 'orchestrator') await this.refreshContext(missionId, mission.session);
      }
    } catch (err) {
      this.emitError({ missionId: cmd.missionId, message: `Could not update agent settings: ${errMsg(err)}` });
    }
  }

  private rememberPendingAgentSettings(cmd: Extract<ClientCommand, { type: 'settings.agent.update' }>): void {
    if (!cmd.missionId) return;
    const missionId = this.findMission(cmd.missionId)?.summary.id ?? this.resolveSummary(cmd.missionId)?.id ?? cmd.missionId;
    const existing = this.pendingAgentSettings.get(missionId) ?? {};
    const agent = { ...(existing[cmd.agent] ?? {}) };
    if (cmd.modelId !== undefined) agent.modelId = cmd.modelId;
    if (cmd.reasoningEffort !== undefined) agent.reasoningEffort = cmd.reasoningEffort;
    this.pendingAgentSettings.set(missionId, { ...existing, [cmd.agent]: agent });
  }

  private summaryPatchForAgent(agent: ConfigurableAgent, settings: AgentSettingPatch): Partial<MissionSummary> {
    const patch: Partial<MissionSummary> = {};
    if (agent === 'orchestrator') {
      if (settings.modelId !== undefined) {
        patch.modelId = settings.modelId ?? undefined;
        patch.maxContextTokens = this.maxContextTokensForModel(settings.modelId ?? undefined);
      }
      if (settings.reasoningEffort !== undefined) patch.reasoningEffort = settings.reasoningEffort;
    } else if (agent === 'worker') {
      if (settings.modelId !== undefined) patch.workerModelId = settings.modelId ?? undefined;
      if (settings.reasoningEffort !== undefined) patch.workerReasoningEffort = settings.reasoningEffort;
    } else {
      if (settings.modelId !== undefined) patch.validatorModelId = settings.modelId ?? undefined;
      if (settings.reasoningEffort !== undefined) patch.validatorReasoningEffort = settings.reasoningEffort;
    }
    return patch;
  }

  private applyPendingSettingsToSummary(summary: MissionSummary): MissionSummary {
    const pending = this.pendingAgentSettings.get(summary.id);
    if (!pending) return summary;
    return (Object.entries(pending) as [ConfigurableAgent, AgentSettingPatch][]).reduce(
      (next, [agent, settings]) => ({ ...next, ...this.summaryPatchForAgent(agent, settings) }),
      summary,
    );
  }

  private async applyOrchestratorSessionSettings(mission: Mission, settings: AgentSettingPatch): Promise<void> {
    const next: { modelId?: string; reasoningEffort?: ReasoningEffort } = {};
    if (settings.modelId) next.modelId = settings.modelId;
    if (settings.reasoningEffort !== undefined) next.reasoningEffort = settings.reasoningEffort;
    if (Object.keys(next).length > 0) await mission.session.updateSettings(next as never);
  }

  private async applyPendingSessionSettings(missionId: string): Promise<boolean> {
    const mission = this.findMission(missionId);
    const appSessionId = mission?.summary.id ?? missionId;
    const orchestrator = this.pendingAgentSettings.get(appSessionId)?.orchestrator;
    if (!mission || !orchestrator) return true;
    try {
      await this.applyOrchestratorSessionSettings(mission, orchestrator);
      this.patch(appSessionId, this.summaryPatchForAgent('orchestrator', orchestrator));
      return true;
    } catch (err) {
      this.emitError({ missionId: appSessionId, message: `Could not apply selected model before send: ${errMsg(err)}` });
      return false;
    }
  }

  private async listHistory(): Promise<void> {
    try {
      const missions: HistoryMission[] = loadSessionHistory();
      this.emit({ type: 'sessions.history', missions });
    } catch (err) {
      this.emitError({ message: errMsg(err) });
    }
  }

  private findMission(id: string): Mission | undefined {
    return this.missions.get(id) ?? [...this.missions.values()].find((mission) =>
      mission.summary.sessionId === id || Boolean(mission.summary.compactedFromSessionIds?.includes(id)),
    );
  }

  private findMissionKey(id: string): string | undefined {
    if (this.missions.has(id)) return id;
    for (const [key, mission] of this.missions) {
      if (mission.summary.sessionId === id || mission.summary.compactedFromSessionIds?.includes(id)) return key;
    }
    return undefined;
  }

  private resolveSummary(id: string): MissionSummary | undefined {
    return this.listAllSummaries().find((summary) =>
      summary.id === id || summary.sessionId === id || Boolean(summary.compactedFromSessionIds?.includes(id)),
    );
  }

  private async resumeMission(sessionId: string): Promise<void> {
    if (!this.ready) this.connect();
    const historical = this.resolveSummary(sessionId);
    const appSessionId = historical?.id ?? sessionId;
    const droidSessionId = historical?.sessionId ?? sessionId;
    const existing = this.findMission(appSessionId);
    if (existing) {
      this.emit({ type: 'mission.created', clientRef: `resume:${appSessionId}`, mission: existing.summary });
      void this.refreshContext(existing.summary.id, existing.session);
      return;
    }
    const ref = { id: appSessionId };
    try {
      const session = await this.runtime.loadSession(droidSessionId, {
        permissionHandler: this.makePermissionHandler(ref),
        askUserHandler: this.makeAskUserHandler(ref),
      });
      const init = session.initResult as InitResultLike;
      const features = (init.mission?.features ?? []).map((f) => mapFeature(f as never));
      const defaults = await this.getFactoryDefaults();
      const classification = classifySession(init, historical);
      const now = Date.now();
      const cwd = historical?.workspaceKind === 'none'
        ? ''
        : stringValue(init.cwd) || stringValue(init.session?.cwd) || historical?.cwd || '';
      const modelId = init.settings?.modelId ?? historical?.modelId ?? defaults.modelId;
      const summary = this.applyPendingSettingsToSummary({
        id: appSessionId,
        sessionId: droidSessionId,
        compactedFromSessionIds: historical?.compactedFromSessionIds ?? [],
        missionId: classification.missionId,
        parentSessionId: classification.parentSessionId,
        kind: classification.kind,
        role: classification.role,
        title: stringValue(init.session?.title) || stringValue(init.session?.sessionTitle) || historical?.title || `Session ${droidSessionId.slice(0, 8)}`,
        goal: historical?.goal ?? '',
        cwd,
        workspaceKind: cwd ? 'folder' : historical?.workspaceKind ?? 'none',
        modelId,
        reasoningEffort: (init.settings?.reasoningEffort as ReasoningEffort | undefined) ?? historical?.reasoningEffort ?? defaults.reasoningEffort,
        compactionModel: init.settings?.compactionModel ?? historical?.compactionModel ?? defaults.compactionModel ?? 'current-model',
        workerModelId: historical?.workerModelId ?? defaults.workerModelId,
        workerReasoningEffort: historical?.workerReasoningEffort ?? defaults.workerReasoningEffort,
        validatorModelId: historical?.validatorModelId ?? defaults.validatorModelId,
        validatorReasoningEffort: historical?.validatorReasoningEffort ?? defaults.validatorReasoningEffort,
        autonomy: (init.settings?.autonomyLevel as Autonomy | undefined) ?? historical?.autonomy ?? defaults.autonomy ?? 'low',
        phase: phaseFromInit(init),
        streaming: false,
        queuedSends: 0,
        features,
        tokensIn: historical?.tokensIn ?? 0,
        tokensOut: historical?.tokensOut ?? 0,
        contextTokens: historical?.contextTokens ?? 0,
        contextRemainingTokens: historical?.contextRemainingTokens,
        contextAccuracy: historical?.contextAccuracy,
        contextUpdatedAt: historical?.contextUpdatedAt,
        maxContextTokens: historical?.maxContextTokens ?? this.maxContextTokensForModel(modelId),
        createdAt: historical?.createdAt ?? now,
        updatedAt: now,
      });
      const mission: Mission = this.createLiveMission(summary, session);
      this.missions.set(appSessionId, mission);
      this.history.syncSummaries([summary]);
      this.emit({ type: 'mission.created', clientRef: `resume:${appSessionId}`, mission: summary });
      this.emit({ type: 'session.updated', session: summary });
      if (features.length) this.emit({ type: 'mission.features', missionId: appSessionId, features });
      void this.refreshContext(appSessionId, session);
    } catch (err) {
      this.emitError({ missionId: appSessionId, sessionId: droidSessionId, message: errMsg(err) });
    }
  }

  private listSummaries(): MissionSummary[] {
    return [...this.missions.values()].map((m) => m.summary);
  }

  private listAllSummaries(): MissionSummary[] {
    const map = new Map<string, MissionSummary>();
    const cached = this.history.summaryPatches();
    const hiddenDroidSessionIds = this.history.hiddenDroidSessionIds();
    for (const historical of loadHistoricalSessions()) {
      if (hiddenDroidSessionIds.has(historical.summary.sessionId ?? historical.summary.id)) continue;
      const summary = this.applyPendingSettingsToSummary(applyCachedSummary(historical.summary, cached));
      map.set(summary.id, summary);
    }
    for (const historical of loadHistoricalMissions()) {
      if (hiddenDroidSessionIds.has(historical.summary.sessionId ?? historical.summary.id)) continue;
      const summary = this.applyPendingSettingsToSummary(applyCachedSummary(historical.summary, cached));
      map.set(summary.id, summary);
    }
    for (const live of this.listSummaries()) map.set(live.id, this.applyPendingSettingsToSummary(live));
    return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private emitMissionList(): void {
    this.emit({ type: 'mission.list', missions: this.listAllSummaries() });
  }

  private loadMissionHistory(missionId: string): void {
    const summary = this.resolveSummary(missionId);
    const appSessionId = summary?.id ?? missionId;
    const droidSessionId = summary?.sessionId ?? missionId;
    try {
      const history = this.hydrateMissionHistory(appSessionId, droidSessionId);
      const transcripts = history.transcripts.map((event) => ({ ...event, missionId: appSessionId }));
      transcripts.forEach((event) => this.history.recordEvent(event));
      this.emit({ type: 'mission.history', missionId: appSessionId, progress: history.progress, transcripts });
    } catch {
      try {
        const page = loadSessionPage(droidSessionId, undefined, undefined, appSessionId);
        page.events.forEach((event) => this.history.recordEvent(event));
        this.emit({ type: 'mission.history', missionId: appSessionId, progress: [], transcripts: page.events });
      } catch (err) {
        if (!this.findMission(appSessionId)) {
          this.emitError({ missionId: appSessionId, sessionId: droidSessionId, message: errMsg(err) });
        }
      }
    }
  }

  private loadHistoryPage(sessionId: string, cursor?: string, limit?: number): void {
    const summary = this.resolveSummary(sessionId);
    const appSessionId = summary?.id ?? sessionId;
    const droidSessionId = summary?.sessionId ?? sessionId;
    try {
      const page = loadSessionPage(droidSessionId, cursor, limit, appSessionId);
      page.events.forEach((event) => this.history.recordEvent(event));
      this.emit({ type: 'mission.history', missionId: appSessionId, progress: [], transcripts: page.events });
    } catch (err) {
      this.emitError({ missionId: appSessionId, sessionId: droidSessionId, message: errMsg(err) });
    }
  }

  private hydrateMissionHistory(appSessionId: string, droidSessionId: string): ReturnType<typeof hydrateHistoricalMission> {
    try {
      return hydrateHistoricalMission(appSessionId);
    } catch {
      return hydrateHistoricalMission(droidSessionId);
    }
  }

  private async createMission(cmd: Extract<ClientCommand, { type: 'mission.create' }>): Promise<void> {
    if (!this.ready) this.connect();
    const mode = cmd.interactionMode ?? 'agi';
    const appCwd = cmd.cwd ?? '';
    const runtimeCwd = appCwd || homedir();
    const ref = { id: '' };
    try {
      const defaults = await this.getFactoryDefaults();
      const autonomy = normalizeAutonomy(cmd.autonomy) ?? defaults.autonomy ?? 'low';
      const orchestratorModelId = cmd.modelId ?? (mode === 'spec' ? defaults.specModelId : defaults.modelId);
      const orchestratorReasoning = cmd.reasoningEffort ?? (mode === 'spec' ? defaults.specReasoningEffort : defaults.reasoningEffort);
      const compactionModel = cmd.compactionModel ?? defaults.compactionModel ?? 'current-model';
      const workerModelId = cmd.workerModel ?? defaults.workerModelId;
      const workerReasoningEffort = cmd.workerReasoning ?? defaults.workerReasoningEffort;
      const validatorModelId = cmd.validatorModel ?? defaults.validatorModelId;
      const validatorReasoningEffort = cmd.validatorReasoning ?? defaults.validatorReasoningEffort;
      const session = await this.runtime.createSession({
        cwd: runtimeCwd,
        interactionMode: mode,
        modelId: orchestratorModelId,
        autonomyLevel: autonomy,
        reasoningEffort: orchestratorReasoning,
        specModeModelId: mode === 'spec' ? orchestratorModelId : defaults.specModelId,
        specModeReasoningEffort: mode === 'spec' ? orchestratorReasoning : defaults.specReasoningEffort,
        decompSessionType: mode === 'agi' ? DecompSessionType.Orchestrator : undefined,
        workerModelId,
        workerReasoningEffort,
        validatorModelId,
        validatorReasoningEffort,
        compactionModel,
        permissionHandler: this.makePermissionHandler(ref),
        askUserHandler: this.makeAskUserHandler(ref),
      });

      const id = session.sessionId;
      const now = Date.now();
      const summary: MissionSummary = {
        id,
        sessionId: id,
        missionId: mode === 'agi' ? id : undefined,
        kind: kindForMode(mode),
        role: 'orchestrator',
        title: cmd.title,
        goal: cmd.goal,
        cwd: appCwd,
        workspaceKind: appCwd ? 'folder' : 'none',
        modelId: orchestratorModelId,
        reasoningEffort: orchestratorReasoning,
        compactionModel,
        workerModelId,
        workerReasoningEffort,
        validatorModelId,
        validatorReasoningEffort,
        autonomy,
        phase: 'intake',
        streaming: false,
        queuedSends: 0,
        features: [],
        tokensIn: 0,
        tokensOut: 0,
        contextTokens: 0,
        maxContextTokens: this.maxContextTokensForModel(orchestratorModelId),
        createdAt: now,
        updatedAt: now,
      };
      ref.id = id;
      const mission = this.createLiveMission(summary, session);
      this.missions.set(id, mission);
      this.history.syncSummaries([summary]);
      this.emit({ type: 'mission.created', clientRef: cmd.clientRef, mission: summary });
      this.emit({ type: 'session.updated', session: summary });
      void this.drive(id, cmd.goal);
    } catch (err) {
      this.emitError({ message: errMsg(err) });
    }
  }

  private createLiveMission(summary: MissionSummary, session: DroidSession): Mission {
    return {
      summary,
      session,
      streaming: false,
      pendingSends: [],
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      agents: new Map(),
      knownSubagents: new Set(),
    };
  }

  private makePermissionHandler(ref: { id: string }): PermissionHandler {
    return (params: RequestPermissionRequestParams) =>
      new Promise<RequestPermissionHandlerResult>((resolve) => {
        const mission = this.findMission(ref.id);
        const requestId = nextRequestId();
        const type = confirmationType(params);
        const request = classifyPermission(ref.id, requestId, params);
        if (mission) {
          mission.pendingPermissions.set(requestId, { resolve, kind: request.kind });
          if (type === 'propose_mission') {
            this.patch(ref.id, { phase: 'awaiting_plan_approval', proposal: request.detail });
          } else if (type === 'start_mission_run') {
            this.patch(ref.id, { phase: 'awaiting_run_start' });
          }
        }
        this.emit({ type: 'mission.permission', request });
        this.emit({ type: 'approval.requested', request });
      });
  }

  private makeAskUserHandler(ref: { id: string }): AskUserHandler {
    return (params: AskUserRequestParams) =>
      new Promise<AskUserResult>((resolve) => {
        const mission = this.findMission(ref.id);
        const requestId = nextRequestId();
        const questions = (params.questions ?? []).map((q) => ({
          index: q.index,
          question: q.question,
          options: q.options ?? [],
        }));
        if (mission) mission.pendingQuestions.set(requestId, resolve);
        const question = { missionId: ref.id, requestId, questions };
        this.emit({ type: 'mission.question', question });
        this.emit({ type: 'question.requested', question });
      });
  }

  private async resolvePermission(missionId: string, requestId: string, outcome: string): Promise<void> {
    const mission = this.findMission(missionId);
    const pending = mission?.pendingPermissions.get(requestId);
    if (!mission || !pending) return;
    mission.pendingPermissions.delete(requestId);
    if (pending.kind === 'spec' && isApprovalOutcome(outcome)) await this.prepareSpecExitForRun(mission);
    pending.resolve(outcome as RequestPermissionHandlerResult);
  }

  private async prepareSpecExitForRun(mission: Mission): Promise<void> {
    const appSessionId = mission.summary.id;
    this.patch(appSessionId, { kind: 'chat', phase: 'running' });
    try {
      await mission.session.updateSettings({ interactionMode: DroidInteractionMode.Auto } as never);
    } catch (err) {
      this.emitError({ code: 'spec.exit_failed', missionId: appSessionId, message: `Could not switch spec session to Auto before run: ${errMsg(err)}` });
    }
  }

  private resolveQuestion(
    missionId: string,
    requestId: string,
    cancelled: boolean,
    answers: { index: number; question: string; answer: string }[],
  ): void {
    const mission = this.findMission(missionId);
    const resolver = mission?.pendingQuestions.get(requestId);
    if (!mission || !resolver) return;
    mission.pendingQuestions.delete(requestId);
    resolver({ cancelled, answers });
  }

  private async drive(missionId: string, prompt: string): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    mission.streaming = true;
    this.patch(appSessionId, {
      phase: mission.summary.kind === 'mission_orchestrator' ? 'planning' : 'running',
      streaming: true,
      queuedSends: mission.pendingSends.length,
    });
    this.startContextPolling(appSessionId, mission.session);
    try {
      const stream = mission.session.stream(prompt, { includePartialMessages: true });
      for await (const ev of stream) this.applyEvent(appSessionId, appSessionId, 'orchestrator', ev);
    } catch (err) {
      this.emitError({ missionId: appSessionId, message: errMsg(err) });
      this.patch(appSessionId, { phase: 'failed' });
    } finally {
      this.stopContextPolling(appSessionId);
      mission.streaming = false;
      const next = mission.pendingSends.shift();
      this.patch(appSessionId, { queuedSends: mission.pendingSends.length });
      if (next !== undefined) void this.drive(appSessionId, next);
      else {
        await this.refreshContext(appSessionId, mission.session);
        this.patch(appSessionId, { streaming: false, queuedSends: 0 });
      }
    }
  }

  private applyEvent(
    missionId: string,
    agentSessionId: string,
    role: AgentRole,
    ev: Parameters<typeof normalizeStreamEvent>[3],
  ): void {
    const n = normalizeStreamEvent(missionId, agentSessionId, role, ev);
    if (!n) return;
    this.applyNormalized(missionId, n);
  }

  private applySubagent(missionId: string, sub: { sessionId?: string; label?: string; done?: boolean }): void {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    if (sub.label) mission.lastSubagentLabel = sub.label;
    const sessionId = sub.sessionId;
    if (!sessionId) return;
    if (sub.done) {
      if (!mission.knownSubagents.has(sessionId)) return;
      this.emit({ type: 'mission.worker', missionId: appSessionId, event: 'completed', workerSessionId: sessionId });
      this.emit({ type: 'agent.updated', missionId: appSessionId, agentSessionId: sessionId, role: 'worker', status: 'completed' });
      return;
    }
    if (mission.knownSubagents.has(sessionId)) return;
    mission.knownSubagents.add(sessionId);
    this.emit({ type: 'mission.worker', missionId: appSessionId, event: 'started', workerSessionId: sessionId, label: mission.lastSubagentLabel });
    this.emit({ type: 'agent.updated', missionId: appSessionId, agentSessionId: sessionId, role: 'worker', status: 'running' });
  }

  private applyNormalized(missionId: string, n: NonNullable<ReturnType<typeof normalizeStreamEvent>>): void {
    if (n.transcript) this.emitTranscript(n.transcript);
    if (n.features) {
      this.patch(missionId, { features: n.features });
      this.emit({ type: 'mission.features', missionId, features: n.features });
    }
    if (n.progress) this.emit({ type: 'mission.progress', missionId, entries: n.progress });
    if (n.missionState) {
      const phase = STATE_TO_PHASE[n.missionState];
      if (phase) this.patch(missionId, { phase });
    }
    if (n.worker) {
      this.emit({
        type: 'mission.worker',
        missionId,
        event: n.worker.event,
        workerSessionId: n.worker.workerSessionId,
        exitCode: n.worker.exitCode,
      });
      this.emit({
        type: 'agent.updated',
        missionId,
        agentSessionId: n.worker.workerSessionId,
        role: 'worker',
        status: n.worker.event === 'completed' ? 'completed' : 'running',
      });
    }
    if (n.subagent) this.applySubagent(missionId, n.subagent);
    if (n.tokens) {
      const m = this.findMission(missionId);
      if (m) {
        const appSessionId = m.summary.id;
        const offset = this.usageOffsets.get(appSessionId);
        m.summary.tokensIn = n.tokens.tokensIn + (offset?.tokensIn ?? 0);
        m.summary.tokensOut = n.tokens.tokensOut + (offset?.tokensOut ?? 0);
        m.summary.contextTokens = n.tokens.contextTokens;
        const maxContextTokens = this.maxContextTokensForSummary(m.summary);
        if (maxContextTokens === undefined) delete m.summary.maxContextTokens;
        else m.summary.maxContextTokens = maxContextTokens;
        this.emitContextEstimate(appSessionId, m.summary);
        this.emit({
          type: 'mission.tokens',
          missionId: appSessionId,
          tokensIn: m.summary.tokensIn,
          tokensOut: m.summary.tokensOut,
          contextTokens: m.summary.contextTokens,
          maxContextTokens: m.summary.maxContextTokens,
        });
      }
    }
  }

  private emitTranscript(event: TranscriptEvent): void {
    this.history.recordEvent(event);
    this.emit({ type: 'mission.transcript', event });
    this.emit({ type: 'event.appended', event });
  }

  private emitStatus(missionId: string, text: string): void {
    this.emitTranscript({
      id: `status-${Date.now().toString(36)}`,
      missionId,
      agentSessionId: missionId,
      role: 'orchestrator',
      ts: Date.now(),
      kind: 'status',
      text,
    });
  }

  private async compactSession(sessionId: string, customInstructions?: string): Promise<void> {
    const historical = this.resolveSummary(sessionId);
    const mission = this.findMission(sessionId);
    const appSessionId = mission?.summary.id ?? historical?.id ?? sessionId;
    const oldDroidSessionId = mission?.summary.sessionId ?? historical?.sessionId ?? sessionId;
    const carryover: UsageOffset = {
      tokensIn: mission?.summary.tokensIn ?? 0,
      tokensOut: mission?.summary.tokensOut ?? 0,
    };
    try {
      if (mission) this.emitStatus(appSessionId, 'Compacting conversation...');
      const result = await this.withSession(appSessionId, (session) =>
        session.compactSession(customInstructions ? { customInstructions } : {}),
      );
      if (!result) return;

      const newSessionId = result.newSessionId || oldDroidSessionId;
      const removedCount = result.removedCount ?? 0;
      if (newSessionId !== oldDroidSessionId) {
        const compactedFromSessionIds = uniqueStrings([
          ...(mission?.summary.compactedFromSessionIds ?? historical?.compactedFromSessionIds ?? []),
          oldDroidSessionId,
        ]);
        if (mission) {
          const ref = { id: appSessionId };
          const oldSession = mission.session;
          mission.session = await this.runtime.loadSession(newSessionId, {
            permissionHandler: this.makePermissionHandler(ref),
            askUserHandler: this.makeAskUserHandler(ref),
          });
          await oldSession.close().catch(() => {});
          this.usageOffsets.set(appSessionId, carryover);
          this.patch(appSessionId, {
            sessionId: newSessionId,
            compactedFromSessionIds,
            tokensIn: carryover.tokensIn,
            tokensOut: carryover.tokensOut,
            contextTokens: 0,
          });
          await this.refreshContext(appSessionId, mission.session);
          this.emitStatus(appSessionId, `Compaction complete. Removed ${removedCount.toLocaleString()} messages.`);
        } else if (historical) {
          const updated = {
            ...historical,
            sessionId: newSessionId,
            compactedFromSessionIds,
            tokensIn: carryover.tokensIn,
            tokensOut: carryover.tokensOut,
            updatedAt: Date.now(),
          };
          this.history.syncSummaries([updated]);
          this.emit({ type: 'mission.updated', mission: updated });
          this.emit({ type: 'session.updated', session: updated });
        }
        return;
      }

      if (mission) {
        await this.refreshContext(appSessionId, mission.session);
        this.emitStatus(appSessionId, `Compaction complete. Removed ${removedCount.toLocaleString()} messages.`);
        this.patch(appSessionId, {});
      }
    } catch (err) {
      this.emitError({ sessionId: oldDroidSessionId, missionId: appSessionId, message: `Could not compact session: ${errMsg(err)}` });
    }
  }

  private async send(missionId: string, text: string): Promise<void> {
    let mission = this.findMission(missionId);
    if (!mission) {
      await this.resumeMission(missionId);
      mission = this.findMission(missionId);
    }
    if (!mission) {
      this.emitError({ missionId, message: `Session ${missionId} is not resumable` });
      return;
    }
    const appSessionId = mission.summary.id;
    if (!(await this.applyPendingSessionSettings(appSessionId))) return;
    if (mission.streaming) {
      mission.pendingSends.push(text);
      this.patch(appSessionId, { queuedSends: mission.pendingSends.length });
      this.emitStatus(appSessionId, `Queued message ${mission.pendingSends.length}.`);
      return;
    }
    await this.drive(appSessionId, text);
  }

  private async setAutonomy(missionId: string, autonomy: Autonomy | 'none'): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) {
      this.emitError({ missionId, message: 'Autonomy can only be changed on a live session.' });
      return;
    }
    const appSessionId = mission.summary.id;
    const nextAutonomy = normalizeAutonomy(autonomy);
    if (!nextAutonomy) {
      this.emitError({ missionId: appSessionId, message: `Unsupported autonomy level: ${autonomy}` });
      return;
    }
    try {
      await mission.session.updateSettings({ autonomyLevel: nextAutonomy } as never);
      this.patch(appSessionId, { autonomy: nextAutonomy });
    } catch (err) {
      this.emitError({ missionId: appSessionId, message: `Could not change autonomy: ${errMsg(err)}` });
    }
  }

  private async setInteractionMode(missionId: string, mode: SessionInteractionMode): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) {
      this.emitError({ missionId, message: 'Spec mode can only be toggled on a live session.' });
      return;
    }
    const appSessionId = mission.summary.id;
    try {
      if (mode === 'spec') {
        await mission.session.enterSpecMode();
      } else {
        await mission.session.updateSettings({ interactionMode: DroidInteractionMode.Auto });
      }
      this.patch(appSessionId, { kind: kindForMode(mode) });
    } catch (err) {
      this.emitError({ missionId: appSessionId, message: `Could not switch interaction mode: ${errMsg(err)}` });
    }
  }

  private async updateSessionSettings(
    sessionId: string,
    settings: { modelId?: string | null; reasoningEffort?: ReasoningEffort; compactionModel?: string | null; autonomy?: Autonomy | 'none' },
  ): Promise<void> {
    const mission = this.findMission(sessionId);
    const appSessionId = mission?.summary.id ?? this.resolveSummary(sessionId)?.id ?? sessionId;
    const patch: Partial<MissionSummary> = {};
    const next: Record<string, unknown> = {};
    if (settings.modelId !== undefined) {
      if (settings.modelId) next.modelId = settings.modelId;
      patch.modelId = settings.modelId ?? undefined;
      patch.maxContextTokens = this.maxContextTokensForModel(settings.modelId ?? undefined);
    }
    if (settings.reasoningEffort) {
      next.reasoningEffort = settings.reasoningEffort;
      patch.reasoningEffort = settings.reasoningEffort;
    }
    if (settings.compactionModel !== undefined) {
      next.compactionModel = settings.compactionModel ?? 'current-model';
      patch.compactionModel = settings.compactionModel ?? 'current-model';
    }
    if (settings.autonomy) {
      const nextAutonomy = normalizeAutonomy(settings.autonomy);
      if (!nextAutonomy) throw new Error(`Unsupported autonomy level: ${settings.autonomy}`);
      next.autonomyLevel = nextAutonomy;
      patch.autonomy = nextAutonomy;
    }
    const session = await this.withSession(appSessionId, async (activeSession) => {
      await activeSession.updateSettings(next as never);
      return activeSession;
    });
    if (mission) this.patch(appSessionId, patch);
    if (mission && session) await this.refreshContext(appSessionId, session);
  }

  private async interrupt(missionId: string): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    mission.pendingSends = [];
    await mission.session.interrupt();
    this.patch(appSessionId, { phase: 'paused', streaming: false, queuedSends: 0 });
  }

  private async openAgent(missionId: string, agentSessionId: string, role: AgentRole): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    if (mission.agents.has(agentSessionId)) {
      this.emit({ type: 'agent.updated', missionId: appSessionId, agentSessionId, role, status: 'opened' });
      return;
    }
    try {
      const ref = { id: appSessionId };
      const session = await this.runtime.loadSession(agentSessionId, {
        permissionHandler: this.makePermissionHandler(ref),
        askUserHandler: this.makeAskUserHandler(ref),
      });
      const agent: LiveAgent = {
        session,
        missionId: appSessionId,
        role,
        streaming: false,
        pendingSends: [],
      };
      agent.unsubscribe = session.onNotification((note: Record<string, unknown>) => {
        for (const n of normalizeNotification(appSessionId, agentSessionId, role, note)) this.applyNormalized(appSessionId, n);
      });
      mission.agents.set(agentSessionId, agent);
      this.emit({ type: 'agent.updated', missionId: appSessionId, agentSessionId, role, status: 'opened' });
    } catch (err) {
      this.emit({ type: 'error', code: 'agent.open_failed', missionId: appSessionId, sessionId: agentSessionId, message: errMsg(err) });
    }
  }

  private async sendAgent(missionId: string, agentSessionId: string, text: string): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    if (!mission.agents.has(agentSessionId)) await this.openAgent(appSessionId, agentSessionId, 'worker');
    const agent = mission.agents.get(agentSessionId);
    if (!agent) return;
    if (agent.streaming) {
      agent.pendingSends.push(text);
      this.emitStatus(appSessionId, `Queued subagent message ${agent.pendingSends.length}.`);
      return;
    }
    await this.driveAgent(agent, text);
  }

  private async driveAgent(agent: LiveAgent, text: string): Promise<void> {
    agent.streaming = true;
    this.emit({ type: 'agent.updated', missionId: agent.missionId, agentSessionId: agent.session.sessionId, role: agent.role, status: 'running' });
    this.startContextPolling(agent.session.sessionId, agent.session);
    try {
      const stream = agent.session.stream(text, { includePartialMessages: true });
      for await (const ev of stream) this.applyEvent(agent.missionId, agent.session.sessionId, agent.role, ev);
    } catch (err) {
      const message = errMsg(err);
      this.emit({ type: 'agent.not_steerable', missionId: agent.missionId, agentSessionId: agent.session.sessionId, message });
      this.emit({ type: 'error', code: 'agent.not_steerable', missionId: agent.missionId, sessionId: agent.session.sessionId, message });
    } finally {
      this.stopContextPolling(agent.session.sessionId);
      agent.streaming = false;
      const next = agent.pendingSends.shift();
      if (next !== undefined) void this.driveAgent(agent, next);
      else {
        await this.refreshContext(agent.session.sessionId, agent.session);
        this.emit({ type: 'agent.updated', missionId: agent.missionId, agentSessionId: agent.session.sessionId, role: agent.role, status: 'paused' });
      }
    }
  }

  private async interruptAgent(missionId: string, agentSessionId: string): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    if (!mission.agents.has(agentSessionId)) await this.openAgent(appSessionId, agentSessionId, 'worker');
    const agent = mission.agents.get(agentSessionId);
    if (!agent) return;
    agent.pendingSends = [];
    await agent.session.interrupt();
    agent.streaming = false;
    this.emit({ type: 'agent.updated', missionId: appSessionId, agentSessionId, role: agent.role, status: 'paused' });
  }

  private async renameSession(sessionId: string, title: string): Promise<void> {
    await this.withSession(sessionId, (session) => session.renameSession({ title }));
    const appSessionId = this.findMission(sessionId)?.summary.id ?? this.resolveSummary(sessionId)?.id;
    if (appSessionId) this.patch(appSessionId, { title });
  }

  private async withSession<T>(sessionId: string, fn: (session: DroidSession) => Promise<T>): Promise<T | undefined> {
    const liveMission = this.findMission(sessionId);
    const live = liveMission?.session;
    if (live) return fn(live);
    const droidSessionId = this.resolveSummary(sessionId)?.sessionId ?? sessionId;
    const session = await this.runtime.loadSession(droidSessionId);
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  private async catalogSession(sessionId?: string): Promise<{ session: DroidSession; close: () => Promise<void> }> {
    const first = this.listSummaries()[0];
    const live = sessionId ? this.findMission(sessionId)?.session : first ? this.findMission(first.id)?.session : undefined;
    if (live) return { session: live, close: async () => {} };
    const session = await this.runtime.createSession({ cwd: tmpdir(), interactionMode: 'auto', autonomyLevel: 'low' });
    return { session, close: () => session.close() };
  }

  private async emitToolCatalog(sessionId?: string): Promise<void> {
    const { session, close } = await this.catalogSession(sessionId);
    try {
      const result = await session.listTools();
      this.emit({ type: 'catalog.updated', catalog: 'tools', items: arrayItems(result, 'tools') });
    } finally {
      await close();
    }
  }

  private async emitSkillCatalog(sessionId?: string): Promise<void> {
    const { session, close } = await this.catalogSession(sessionId);
    try {
      const result = await session.listSkills();
      this.emit({ type: 'catalog.updated', catalog: 'skills', items: arrayItems(result, 'skills') });
    } finally {
      await close();
    }
  }

  private async emitMcpCatalog(sessionId?: string): Promise<void> {
    const { session, close } = await this.catalogSession(sessionId);
    try {
      const servers = await session.listMcpServers();
      const tools = await session.listMcpTools();
      this.emit({ type: 'catalog.updated', catalog: 'mcp', items: [{ servers, tools }] });
    } finally {
      await close();
    }
  }

  private startContextPolling(sessionId: string, session: DroidSession): void {
    if (this.contextPollers.has(sessionId)) return;
    const poll = () => void this.refreshContext(sessionId, session, { persist: false });
    const timer = setInterval(poll, 2_500);
    this.contextPollers.set(sessionId, timer);
    poll();
  }

  private stopContextPolling(sessionId: string): void {
    const timer = this.contextPollers.get(sessionId);
    if (!timer) return;
    clearInterval(timer);
    this.contextPollers.delete(sessionId);
  }

  private emitContextEstimate(sessionId: string, summary: MissionSummary): void {
    if (summary.contextTokens <= 0) return;
    const previous = this.contextSnapshots.get(sessionId);
    const limit = this.maxContextTokensForSummary(summary) ?? summary.maxContextTokens ?? previous?.limit;
    if (!limit || limit <= 0) return;
    const used = Math.min(summary.contextTokens, limit);
    const breakdown = previous?.breakdown
      ? {
          ...previous.breakdown,
          contextBudget: limit,
          usedTokens: used,
          freeTokens: Math.max(0, limit - used),
        }
      : undefined;
    const snapshot: ContextStatsSnapshot = {
      used,
      remaining: Math.max(0, limit - used),
      limit,
      accuracy: previous?.accuracy ?? 'estimated',
      updatedAt: new Date().toISOString(),
      breakdown,
    };
    this.contextSnapshots.set(sessionId, snapshot);
    this.emit({ type: 'context.updated', sessionId, stats: snapshot });
  }

  private async refreshContext(sessionId: string, session: DroidSession, options: { persist?: boolean } = {}): Promise<void> {
    try {
      const stats = await session.getContextStats();
      const breakdown = await this.readContextBreakdown(session);
      const snapshot = contextStatsSnapshot(stats, breakdown);
      const mission = this.findMission(sessionId);
      const appSessionId = mission?.summary.id ?? sessionId;
      this.contextSnapshots.set(appSessionId, snapshot);
      this.emit({ type: 'context.updated', sessionId: appSessionId, stats: snapshot });
      if (mission) {
        const contextPatch = {
          contextTokens: snapshot.used,
          contextRemainingTokens: snapshot.remaining,
          maxContextTokens: snapshot.limit,
          contextAccuracy: snapshot.accuracy,
          contextUpdatedAt: snapshot.updatedAt,
        };
        if (options.persist === false) mission.summary = { ...mission.summary, ...contextPatch };
        else this.patch(appSessionId, contextPatch);
        const updated = this.findMission(appSessionId)?.summary;
        if (updated) {
          this.emit({
            type: 'mission.tokens',
            missionId: appSessionId,
            tokensIn: updated.tokensIn,
            tokensOut: updated.tokensOut,
            contextTokens: updated.contextTokens,
            maxContextTokens: updated.maxContextTokens,
          });
        }
      }
    } catch {
      /* context stats are informational; keep the active turn path clean */
    }
  }

  private async readContextBreakdown(session: DroidSession): Promise<ContextBreakdownSnapshot | undefined> {
    try {
      const exposed = session as unknown as { getContextBreakdown?: () => Promise<unknown> };
      if (typeof exposed.getContextBreakdown === 'function') {
        return contextBreakdownSnapshot(await exposed.getContextBreakdown());
      }

      const client = (session as unknown as {
        _client?: {
          _sessionRpcWithoutParams?: (method: string, schema: unknown) => Promise<unknown>;
        };
      })._client;
      if (!client?._sessionRpcWithoutParams) return undefined;
      return contextBreakdownSnapshot(
        await client._sessionRpcWithoutParams('droid.get_context_breakdown', ContextBreakdownResultSchema),
      );
    } catch {
      return undefined;
    }
  }

  private async closeMission(missionId: string): Promise<void> {
    const key = this.findMissionKey(missionId);
    if (!key) return;
    const mission = this.missions.get(key);
    if (!mission) return;
    this.stopContextPolling(key);
    if (mission.summary.sessionId) this.stopContextPolling(mission.summary.sessionId);
    for (const agent of mission.agents.values()) {
      this.stopContextPolling(agent.session.sessionId);
      agent.unsubscribe?.();
      try {
        await agent.session.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await mission.session.close();
    } catch {
      /* ignore */
    }
    this.missions.delete(key);
    this.usageOffsets.delete(key);
    this.emitMissionList();
  }

  private patch(missionId: string, partial: Partial<MissionSummary>): void {
    const key = this.findMissionKey(missionId);
    const mission = key ? this.missions.get(key) : undefined;
    if (!mission) return;
    mission.summary = { ...mission.summary, ...partial, updatedAt: Date.now() };
    this.history.syncSummaries([mission.summary]);
    this.emit({ type: 'mission.updated', mission: mission.summary });
    this.emit({ type: 'session.updated', session: mission.summary });
  }

  private emitError(error: { code?: string; sessionId?: string; missionId?: string; message: string }): void {
    this.emit({ type: 'mission.error', missionId: error.missionId ?? error.sessionId, message: error.message });
    this.emit({ type: 'error', ...error });
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.missions.keys()]) await this.closeMission(id);
    this.history.close();
  }
}

interface InitResultLike {
  cwd?: string;
  session?: Record<string, unknown>;
  settings?: {
    modelId?: string;
    reasoningEffort?: string;
    compactionModel?: string;
    interactionMode?: string;
    autonomyLevel?: string;
  };
  mission?: { state?: string; features?: unknown[] };
}

function classifySession(init: InitResultLike, historical?: MissionSummary): Pick<MissionSummary, 'kind' | 'role' | 'missionId' | 'parentSessionId'> {
  const session = init.session ?? {};
  const decompType = stringValue(session.decompSessionType);
  const missionId = stringValue(session.decompMissionId) ?? historical?.missionId;
  if (decompType === 'worker') {
    return {
      kind: historical?.kind === 'mission_validator' ? 'mission_validator' : 'mission_worker',
      role: historical?.role === 'validator' ? 'validator' : 'worker',
      missionId,
      parentSessionId: historical?.parentSessionId,
    };
  }
  const mode = init.settings?.interactionMode ?? (init.mission ? 'agi' : undefined);
  if (mode === 'agi' || decompType === 'orchestrator' || historical?.kind === 'mission_orchestrator') {
    return { kind: 'mission_orchestrator', role: 'orchestrator', missionId: missionId ?? historical?.id, parentSessionId: undefined };
  }
  if (mode === 'spec' || historical?.kind === 'spec') return { kind: 'spec', role: 'orchestrator', missionId: undefined, parentSessionId: undefined };
  return { kind: 'chat', role: 'orchestrator', missionId: undefined, parentSessionId: undefined };
}

function phaseFromInit(init: InitResultLike): MissionPhase {
  if (init.mission?.state) return STATE_TO_PHASE[init.mission.state] ?? 'paused';
  return 'paused';
}

function kindForMode(mode: SessionInteractionMode): SessionKind {
  if (mode === 'agi') return 'mission_orchestrator';
  if (mode === 'spec') return 'spec';
  return 'chat';
}

function applyCachedSummary(summary: MissionSummary, cached: Map<string, Partial<MissionSummary>>): MissionSummary {
  const patch = cached.get(summary.sessionId ?? summary.id) ?? cached.get(summary.id);
  if (!patch) return summary;
  const defined = definedPatch(patch);
  return {
    ...summary,
    ...defined,
    id: defined.id ?? summary.id,
    sessionId: defined.sessionId ?? summary.sessionId,
    missionId: defined.missionId ?? summary.missionId,
    parentSessionId: defined.parentSessionId ?? summary.parentSessionId,
    kind: defined.kind ?? summary.kind,
    role: defined.role ?? summary.role,
  };
}

function definedPatch(patch: Partial<MissionSummary>): Partial<MissionSummary> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<MissionSummary>;
}

function arrayItems(result: unknown, key: string): unknown[] {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const value = record[key];
  if (Array.isArray(value)) return value;
  return [result];
}

function contextStatsSnapshot(
  stats: GetContextStatsResult,
  breakdown: ContextBreakdownSnapshot | undefined,
): ContextStatsSnapshot {
  return {
    used: stats.used,
    remaining: stats.remaining,
    limit: stats.limit,
    accuracy: stats.accuracy as ContextStatsSnapshot['accuracy'],
    updatedAt: stats.updatedAt,
    breakdown,
  };
}

function contextBreakdownSnapshot(raw: unknown): ContextBreakdownSnapshot | undefined {
  const value = raw as Partial<ContextBreakdownResult> | undefined;
  if (!value) return undefined;
  const categories = Array.isArray(value.categories)
    ? value.categories
        .map((item) => ({
          name: stringValue(item.name) ?? 'Context',
          tokens: numberValue(item.tokens) ?? 0,
          colorKey: stringValue(item.colorKey),
        }))
        .filter((item) => item.tokens > 0)
    : [];
  const usedTokens = numberValue(value.usedTokens) ?? categories.reduce((sum, item) => sum + item.tokens, 0);
  const contextBudget = numberValue(value.contextBudget) ?? usedTokens + (numberValue(value.freeTokens) ?? 0);
  if (contextBudget <= 0 && usedTokens <= 0 && categories.length === 0) return undefined;
  return {
    modelId: stringValue(value.modelId),
    modelDisplayName: stringValue(value.modelDisplayName),
    contextBudget,
    usedTokens,
    freeTokens: numberValue(value.freeTokens) ?? Math.max(0, contextBudget - usedTokens),
    categories,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isApprovalOutcome(outcome: string): boolean {
  return outcome === 'proceed_once' || outcome === 'proceed_always' || outcome === 'proceed_auto_run';
}

function normalizeAutonomy(value: unknown): Autonomy | undefined {
  if (value === 'none') return 'off';
  if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
