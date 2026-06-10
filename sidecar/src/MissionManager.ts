import {
  ContextBreakdownResultSchema,
  DecompSessionType,
  DroidInteractionMode,
  type AskUserHandler,
  type ContextBreakdownResult,
  type AskUserRequestParams,
  type AskUserResult,
  type DroidSession,
  type SdkMcpServer,
  type GetContextStatsResult,
  type PermissionHandler,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';
import { homedir, tmpdir } from 'node:os';
import type {
  AgentRole,
  Autonomy,
  BrowserNativeRequest,
  BrowserNativeResult,
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
import { classifyPermission, confirmationType, mapFeature, normalizeNotification, normalizeStreamEvent, permissionSignature } from './normalize.js';
import {
  applyCachedSummary,
  HistoryIndex,
  hydrateHistoricalMission,
  loadHistoricalMissions,
  loadHistoricalSessions,
  loadSessionHistory,
  loadSessionPage,
  readFactoryDefaults,
} from './history.js';
import { mergeModelCatalog } from './modelCatalog.js';
import { readDroidCliModelCatalog, readDroidCliModelCatalogCache } from './DroidCliCatalog.js';
import { BrowserSessionManager } from './browser/BrowserSessionManager.js';
import { createBrowserMcpServer } from './browser/browserMcpServer.js';
import { isDesignPrompt } from './browser/designPromptPacks.js';
import { NativeBrowserRuntime } from './browser/NativeBrowserRuntime.js';
import { isAlwaysOutcome, isApprovalOutcome, normalizePermissionOutcome } from './permissionOutcomes.js';
import { filterMissionListSummaries, type MissionListFilterOptions } from './missionListFilter.js';
import {
  autoCompactionDue,
  createCompactionSettingsForModel,
  effectiveCompactionLimit,
  normalizeCompactionTokenLimit,
  runCompaction,
  type CompactionOutcome,
  type CompactType,
} from './compaction.js';

type Emit = (event: ServerEvent) => void;

interface MissionManagerOptions {
  assetUrlFor?: (path: string) => string;
}

interface LiveAgent {
  session: DroidSession;
  missionId: string;
  role: AgentRole;
  streaming: boolean;
  pendingSends: string[];
  interruptingForSteer?: boolean;
  lastUsedAt: number;
  closeWhenIdle?: boolean;
  unsubscribe?: () => void;
  // Workers are normal Droid sessions and flow through the same compaction
  // layer as the orchestrator, in-place and scoped to their own session.
  compacting?: boolean;
  effectiveCompactionTokenLimit?: number;
}

interface Mission {
  summary: MissionSummary;
  session: DroidSession;
  streaming: boolean;
  pendingSends: string[];
  interruptingForSteer?: boolean;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, (r: AskUserResult) => void>;
  agents: Map<string, LiveAgent>;
  knownSubagents: Set<string>;
  completedSubagents: Set<string>;
  subagentToolUseIds: Map<string, string>;
  subagentSettings: Map<string, SubagentSettings>;
  pendingSubagents: PendingSubagent[];
  mcpServers: SdkMcpServer[];
  permissionGrants: Set<string>;
  // Tracks whether TodoWrite is currently disabled on the session so we only
  // call updateSettings when the design/normal turn policy actually changes.
  todoDisabledForDesign?: boolean;
  // Guards compactSession so neither auto nor manual compaction can run
  // concurrently (the SDK session swap is not safe to overlap with another
  // compact or a streaming turn).
  compacting?: boolean;
  // The effective compaction token limit computed at creation/resume time,
  // matching the threshold the ContextMeter shows (per-model → global default,
  // clamped to model window). Stored so maybeAutoCompact doesn't re-derive it
  // from defaults that may have drifted since session creation.
  effectiveCompactionTokenLimit?: number;
}

interface PendingPermission {
  resolve: (r: RequestPermissionHandlerResult) => void;
  kind: PermissionKind;
  signature?: string;
}

interface PendingSubagent {
  toolUseId?: string;
  label?: string;
  prompt?: string;
}

interface SubagentSettings {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface AgentSettingPatch {
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

const MAX_OPEN_AGENT_TRANSPORTS = boundedInt(process.env.DROID_CONTROL_MAX_OPEN_AGENTS, 4, 1, 24);
const BROWSER_NATIVE_TIMEOUT_MS = boundedInt(process.env.DROID_CONTROL_BROWSER_NATIVE_TIMEOUT_MS, 12_000, 1_000, 60_000);

let permSeq = 0;
const nextRequestId = () => `req-${Date.now().toString(36)}-${(permSeq++).toString(36)}`;
let nativeBrowserSeq = 0;
const nextNativeBrowserRequestId = () => `browser-native-${Date.now().toString(36)}-${(nativeBrowserSeq++).toString(36)}`;

interface PendingNativeBrowserRequest {
  resolve: (result: BrowserNativeResult) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class MissionManager {
  private ready = false;
  private cachedModels: ModelInfo[] | null = null;
  private modelRefresh: Promise<ModelInfo[] | null> | null = null;
  private readonly runtime = new DroidRuntime();
  private readonly history = new HistoryIndex();
  private readonly missions = new Map<string, Mission>();
  private readonly pendingAgentSettings = new Map<string, Partial<Record<ConfigurableAgent, AgentSettingPatch>>>();
  private readonly usageOffsets = new Map<string, UsageOffset>();
  private readonly contextSnapshots = new Map<string, ContextStatsSnapshot>();
  private readonly contextPollers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pendingNativeBrowserRequests = new Map<string, PendingNativeBrowserRequest>();
  private readonly browsers: BrowserSessionManager;

  constructor(private readonly emit: Emit, options: MissionManagerOptions = {}) {
    this.browsers = new BrowserSessionManager({
      assetUrlFor: options.assetUrlFor,
      emit: (event) => this.emit(event),
      runtimeFactory: (sessionId, viewport, missionId) => new NativeBrowserRuntime({
        sessionId,
        missionId,
        viewport,
        request: (request) => this.requestNativeBrowser(request),
        nextRequestId: nextNativeBrowserRequestId,
      }),
    });
  }

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
        void this.refreshModelCatalog(true);
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
      case 'session.sendNow':
      case 'mission.sendNow':
        await this.sendNow('sessionId' in cmd ? cmd.sessionId : cmd.missionId, cmd.text);
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
      case 'agent.sendNow':
        await this.sendAgentNow(cmd.missionId, cmd.agentSessionId, cmd.text);
        return;
      case 'agent.interrupt':
        await this.interruptAgent(cmd.missionId, cmd.agentSessionId);
        return;
      case 'session.updateSettings':
        await this.updateSessionSettings(cmd.sessionId, cmd);
        return;
      case 'session.compact':
      case 'mission.compact': {
        const missionId = cmd.type === 'session.compact' ? cmd.sessionId : cmd.missionId;
        const mission = this.findMission(missionId);
        if (mission?.streaming || mission?.compacting) {
          this.emitStatus(missionId, 'Cannot compact while a turn is active. Try again when the model is idle.');
          return;
        }
        await this.compactSession(missionId, cmd.customInstructions, 'manual');
        return;
      }
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
        this.emitMissionList(cmd);
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
      case 'browser.open':
        await this.handleBrowser(cmd.missionId, () => this.browsers.open({ ...cmd, missionId: this.requireBrowserMissionId(cmd.missionId) }));
        return;
      case 'browser.close':
        await this.handleBrowser(cmd.missionId, async () => {
          const missionId = this.requireBrowserMissionId(cmd.missionId);
          await this.browsers.close(missionId);
          this.emit({ type: 'browser.closed', missionId });
        });
        return;
      case 'browser.reload':
        await this.handleBrowser(cmd.missionId, () => this.browsers.reload(this.requireBrowserMissionId(cmd.missionId)));
        return;
      case 'browser.refresh':
        await this.handleBrowser(cmd.missionId, () => this.browsers.refresh(this.requireBrowserMissionId(cmd.missionId)));
        return;
      case 'browser.resizeViewport':
        await this.handleBrowser(cmd.missionId, () => this.browsers.resizeViewport({ ...cmd, missionId: this.requireBrowserMissionId(cmd.missionId) }));
        return;
      case 'browser.click':
        await this.handleBrowser(cmd.missionId, () => this.browsers.click({ ...cmd, missionId: this.requireBrowserMissionId(cmd.missionId) }));
        return;
      case 'browser.type':
        await this.handleBrowser(cmd.missionId, () => this.browsers.type(this.requireBrowserMissionId(cmd.missionId), cmd.text));
        return;
      case 'browser.keypress':
        await this.handleBrowser(cmd.missionId, () => this.browsers.keypress(this.requireBrowserMissionId(cmd.missionId), cmd.key));
        return;
      case 'browser.scroll':
        await this.handleBrowser(cmd.missionId, () => this.browsers.scroll(this.requireBrowserMissionId(cmd.missionId), cmd.direction, cmd.pixels, cmd.source));
        return;
      case 'browser.screenshot':
        await this.handleBrowser(cmd.missionId, async () => {
          await this.browsers.screenshot(this.requireBrowserMissionId(cmd.missionId), {
            fullPage: cmd.fullPage,
            deviceScaleFactor: cmd.deviceScaleFactor,
          });
        });
        return;
      case 'browser.inspectPoint':
        await this.handleBrowser(cmd.missionId, async () => {
          const element = this.browsers.inspectPoint(this.requireBrowserMissionId(cmd.missionId), cmd.x, cmd.y);
          if (!element) throw new Error('No browser element found at that point.');
        });
        return;
      case 'browser.design.addReference':
        await this.handleBrowser(cmd.missionId, async () => {
          await this.browsers.addReference(this.requireBrowserMissionId(cmd.missionId), {
            anchor: cmd.reference.anchor,
            detail: cmd.reference.detail,
            id: cmd.reference.id,
          }, cmd.reference.screenshot);
        });
        return;
      case 'browser.design.sendPrompt':
        await this.handleBrowser(cmd.missionId, async () => {
          const missionId = this.requireBrowserMissionId(cmd.missionId);
          const { prompt } = await this.browsers.designPrompt({ ...cmd, missionId });
          await this.send(missionId, prompt);
        });
        return;
      case 'browser.native.result':
        this.resolveNativeBrowserRequest(cmd.result);
        return;
    }
  }

  private async getModels(): Promise<ModelInfo[]> {
    if (this.cachedModels) return this.cachedModels;
    const droidPath = this.runtime.status().droidPath;
    const cached = readDroidCliModelCatalogCache(droidPath);
    if (cached.length > 0) {
      this.cachedModels = mergeModelCatalog(cached);
      return this.cachedModels;
    }
    return (await this.refreshModelCatalog(false)) ?? [];
  }

  private refreshModelCatalog(emit: boolean): Promise<ModelInfo[] | null> {
    if (this.modelRefresh) return this.modelRefresh;
    this.modelRefresh = (async () => {
      try {
        const models = mergeModelCatalog(await readDroidCliModelCatalog(this.runtime.status().droidPath));
        this.cachedModels = models;
        if (emit) {
          this.emit({ type: 'models.list', models });
          this.emit({ type: 'catalog.updated', catalog: 'models', items: models });
        }
        return models;
      } catch (err) {
        this.emitError({ message: `models.list failed: ${errMsg(err)}` });
        return null;
      } finally {
        this.modelRefresh = null;
      }
    })();
    return this.modelRefresh;
  }

  private async getFactoryDefaults(): Promise<FactoryDefaultSettings> {
    const defaults = readFactoryDefaults();
    const models = await this.getModels();
    return validateFactoryDefaults(defaults, models);
  }

  private async emitFactoryDefaults(): Promise<void> {
    const defaults = readFactoryDefaults();
    const droidPath = this.runtime.status().droidPath;
    const models = this.cachedModels ?? mergeModelCatalog(readDroidCliModelCatalogCache(droidPath));
    if (!this.cachedModels && models.length > 0) this.cachedModels = models;
    this.emit({ type: 'settings.defaults', defaults: startupFactoryDefaults(defaults, models) });
  }

  private async startLocalMcpServers(
    ref: { id: string },
  ): Promise<{ servers: SdkMcpServer[]; configs: Awaited<ReturnType<SdkMcpServer['start']>>[] }> {
    const servers = [
      createBrowserMcpServer(this.browsers, () => ref.id),
    ];
    const configs: Awaited<ReturnType<SdkMcpServer['start']>>[] = [];
    try {
      for (const server of servers) configs.push(await server.start());
      return { servers, configs };
    } catch (err) {
      await Promise.all(servers.map((server) => server.close().catch(() => {})));
      throw err;
    }
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
      const mission = cmd.missionId ? this.findMission(cmd.missionId) : undefined;
      const summary = mission?.summary ?? (cmd.missionId ? this.resolveSummary(cmd.missionId) : undefined);
      if (cmd.missionId && cmd.agent !== 'orchestrator' && summary && summary.kind !== 'mission_orchestrator') {
        this.emitError({
          code: 'agent.settings_unsupported',
          missionId: summary.id,
          message: 'Worker and validator model settings only apply to Mission Control sessions.',
        });
        return;
      }
      if (cmd.missionId) this.rememberPendingAgentSettings(cmd);
      const missionId = mission?.summary.id ?? cmd.missionId;
      if (mission) {
        const settings = await this.runtimeAgentSettings(mission, cmd.agent, {
          modelId: cmd.modelId,
          reasoningEffort: cmd.reasoningEffort,
        });
        await this.applyAgentSessionSettings(mission, cmd.agent, settings);
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

  private async applyAgentSessionSettings(mission: Mission, agent: ConfigurableAgent, settings: AgentSettingPatch): Promise<void> {
    const next = createSessionSettingsForAgent(agent, settings);
    if (Object.keys(next).length > 0) await mission.session.updateSettings(next as never);
  }

  private async runtimeAgentSettings(mission: Mission, agent: ConfigurableAgent, settings: AgentSettingPatch): Promise<AgentSettingPatch> {
    if (settings.modelId !== null) return settings;
    const defaults = await this.getFactoryDefaults();
    return {
      ...settings,
      modelId: defaultModelForAgent(agent, modeForSummary(mission.summary), defaults),
    };
  }

  private async applyPendingSessionSettings(missionId: string): Promise<boolean> {
    const mission = this.findMission(missionId);
    const appSessionId = mission?.summary.id ?? missionId;
    const pending = this.pendingAgentSettings.get(appSessionId);
    if (!mission || !pending) return true;
    try {
      let patch: Partial<MissionSummary> = {};
      for (const [agent, settings] of Object.entries(pending) as [ConfigurableAgent, AgentSettingPatch][]) {
        await this.applyAgentSessionSettings(mission, agent, await this.runtimeAgentSettings(mission, agent, settings));
        patch = { ...patch, ...this.summaryPatchForAgent(agent, settings) };
      }
      this.patch(appSessionId, patch);
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
    const ref = { id: droidSessionId };
    let pendingMcpServers: SdkMcpServer[] = [];
    try {
      const mcp = await this.startLocalMcpServers(ref);
      pendingMcpServers = mcp.servers;
      const session = await this.runtime.loadSession(droidSessionId, {
        permissionHandler: this.makePermissionHandler(ref),
        askUserHandler: this.makeAskUserHandler(ref),
        mcpServers: mcp.configs,
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
      const resumeCompactionLimit = effectiveCompactionLimit(modelId, defaults, this.maxContextTokensForModel(modelId));
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
      const mission: Mission = this.createLiveMission(summary, session, mcp.servers, resumeCompactionLimit);
      this.missions.set(appSessionId, mission);
      this.history.syncSummaries([summary]);
      this.emit({ type: 'mission.created', clientRef: `resume:${appSessionId}`, mission: summary });
      this.emit({ type: 'session.updated', session: summary });
      if (features.length) this.emit({ type: 'mission.features', missionId: appSessionId, features });
      void this.refreshContext(appSessionId, session);
    } catch (err) {
      await Promise.all(pendingMcpServers.map((server) => server.close().catch(() => {})));
      this.emitError({ missionId: appSessionId, sessionId: droidSessionId, message: errMsg(err) });
    }
  }

  private listSummaries(): MissionSummary[] {
    return [...this.missions.values()].map((m) => m.summary);
  }

  private listAllSummaries(options?: MissionListFilterOptions): MissionSummary[] {
    const map = new Map<string, MissionSummary>();
    const cached = this.history.summaryPatches();
    const hiddenDroidSessionIds = this.history.hiddenDroidSessionIds();
    for (const historical of loadHistoricalSessions(options)) {
      if (hiddenDroidSessionIds.has(historical.summary.sessionId ?? historical.summary.id)) continue;
      const summary = this.applyPendingSettingsToSummary(applyCachedSummary(historical.summary, cached));
      map.set(summary.id, summary);
    }
    for (const historical of loadHistoricalMissions(options)) {
      if (hiddenDroidSessionIds.has(historical.summary.sessionId ?? historical.summary.id)) continue;
      const summary = this.applyPendingSettingsToSummary(applyCachedSummary(historical.summary, cached));
      map.set(summary.id, summary);
    }
    for (const live of this.listSummaries()) map.set(live.id, this.applyPendingSettingsToSummary(live));
    return filterMissionListSummaries([...map.values()].sort((a, b) => b.updatedAt - a.updatedAt), options);
  }

  private emitMissionList(options?: MissionListFilterOptions): void {
    this.emit({ type: 'mission.list', missions: this.listAllSummaries(options) });
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
    const appCwd = cmd.cwd ?? '';
    const runtimeCwd = appCwd || homedir();
    const ref = { id: '' };
    let pendingMcpServers: SdkMcpServer[] = [];
    try {
      const defaults = await this.getFactoryDefaults();
      const mode = cmd.interactionMode ?? defaults.interactionMode ?? 'agi';
      const autonomy = createAutonomyForCommand(cmd, defaults);
      const { modelId: orchestratorModelId, reasoningEffort: orchestratorReasoning } = createModelDefaultsForMode(mode, cmd, defaults);
      const compactionModel = cmd.compactionModel ?? defaults.compactionModel ?? 'current-model';
      const compactionSettings = createCompactionSettingsForModel(
        orchestratorModelId,
        cmd,
        defaults,
        this.maxContextTokensForModel(orchestratorModelId),
      );
      const {
        workerModelId,
        workerReasoningEffort,
        validatorModelId,
        validatorReasoningEffort,
      } = createMissionAgentDefaultsForMode(mode, cmd, defaults);
      const mcp = await this.startLocalMcpServers(ref);
      pendingMcpServers = mcp.servers;
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
        compactionTokenLimit: compactionSettings.compactionTokenLimit,
        mcpServers: mcp.configs,
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
      const mission = this.createLiveMission(summary, session, mcp.servers, compactionSettings.compactionTokenLimit);
      this.missions.set(id, mission);
      this.history.syncSummaries([summary]);
      this.emit({ type: 'mission.created', clientRef: cmd.clientRef, mission: summary });
      this.emit({ type: 'session.updated', session: summary });
      void this.drive(id, cmd.goal);
    } catch (err) {
      await Promise.all(pendingMcpServers.map((server) => server.close().catch(() => {})));
      this.emitError({ message: errMsg(err) });
    }
  }

  private createLiveMission(summary: MissionSummary, session: DroidSession, mcpServers: SdkMcpServer[] = [], effectiveCompactionTokenLimit?: number): Mission {
    return {
      summary,
      session,
      streaming: false,
      pendingSends: [],
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      agents: new Map(),
      knownSubagents: new Set(),
      completedSubagents: new Set(),
      subagentToolUseIds: new Map(),
      subagentSettings: new Map(),
      pendingSubagents: [],
      mcpServers,
      permissionGrants: new Set(),
      effectiveCompactionTokenLimit,
    };
  }

  private makePermissionHandler(ref: { id: string }): PermissionHandler {
    return (params: RequestPermissionRequestParams) =>
      new Promise<RequestPermissionHandlerResult>((resolve) => {
        const mission = this.findMission(ref.id);
        const requestId = nextRequestId();
        const type = confirmationType(params);
        const request = classifyPermission(ref.id, requestId, params);
        const signature = permissionSignature(params);
        if (mission && signature && mission.permissionGrants.has(signature)) {
          resolve(normalizePermissionOutcome('proceed_always'));
          return;
        }
        if (mission) {
          mission.pendingPermissions.set(requestId, { resolve, kind: request.kind, signature: signature || undefined });
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
    let normalized: RequestPermissionHandlerResult;
    try {
      normalized = normalizePermissionOutcome(outcome);
    } catch (err) {
      this.emitError({ code: 'permission.invalid_outcome', missionId, message: errMsg(err) });
      normalized = normalizePermissionOutcome('cancel');
    }
    if (pending.signature && isAlwaysOutcome(outcome)) {
      mission.permissionGrants.add(pending.signature);
    }
    if (pending.kind === 'spec' && isApprovalOutcome(normalized)) await this.prepareSpecExitForRun(mission);
    pending.resolve(normalized);
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
    await this.applyDesignToolPolicy(mission, isDesignPrompt(prompt));
    try {
      const stream = mission.session.stream(prompt, { includePartialMessages: true });
      for await (const ev of stream) this.applyEvent(appSessionId, appSessionId, 'orchestrator', ev);
    } catch (err) {
      if (mission.interruptingForSteer) this.emitStatus(appSessionId, 'Current turn interrupted for steering.');
      else {
        this.emitError({ missionId: appSessionId, message: errMsg(err) });
        this.patch(appSessionId, { phase: 'failed' });
      }
    } finally {
      this.stopContextPolling(appSessionId);
      mission.interruptingForSteer = false;
      // Keep streaming=true while refreshContext / maybeAutoCompact are in flight
      // so concurrent sends queue instead of racing a second drive().
      await this.refreshContext(appSessionId, mission.session);
      await this.maybeAutoCompact(appSessionId);
      mission.streaming = false;
      const next = mission.pendingSends.shift();
      this.patch(appSessionId, { streaming: false, queuedSends: mission.pendingSends.length });
      if (next !== undefined) void this.drive(appSessionId, next);
    }
  }

  // The SDK exposes manual compaction only; auto-compaction is the client's job
  // (the CLI runs its own loop). After each idle orchestrator turn we compact
  // once the context window crosses the effective limit stored on the Mission
  // at creation time (matching the threshold the ContextMeter shows).
  private async maybeAutoCompact(appSessionId: string): Promise<void> {
    const mission = this.findMission(appSessionId);
    if (!mission || !autoCompactionDue(mission, mission.summary.contextTokens)) return;
    await this.compactMission(mission, undefined, 'auto');
  }

  // Design turns are a single focused task (extra prompts queue), so the model
  // does not need TodoWrite — it otherwise loops updating the list after it has
  // already answered. Disable TodoWrite for design turns and restore it for
  // normal turns, calling updateSettings only when the policy changes.
  private async applyDesignToolPolicy(mission: Mission, design: boolean): Promise<void> {
    // When the in-memory flag is unset (cold start / page reload) we don't
    // know the session's current disabledToolIds, so always call updateSettings
    // to synchronize. Once the flag is set we skip redundant calls.
    if (mission.todoDisabledForDesign !== undefined && mission.todoDisabledForDesign === design) return;
    try {
      await mission.session.updateSettings({ disabledToolIds: design ? ['TodoWrite'] : [] });
      mission.todoDisabledForDesign = design;
    } catch (err) {
      this.emitError({ missionId: mission.summary.id, message: `Could not update design tool policy: ${errMsg(err)}` });
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

  private applySubagent(
    missionId: string,
    sub: { sessionId?: string; toolUseId?: string; label?: string; prompt?: string; done?: boolean },
  ): void {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    const sessionId = sub.sessionId;
    if (!sessionId) {
      if (sub.done) {
        if (sub.toolUseId) this.completeSubagentForToolUse(mission, sub.toolUseId);
      } else if (sub.toolUseId || sub.label || sub.prompt) {
        mission.pendingSubagents.push({ toolUseId: sub.toolUseId, label: sub.label, prompt: sub.prompt });
      }
      return;
    }
    if (sub.done) {
      this.completeSubagent(mission, sessionId);
      return;
    }
    if (mission.knownSubagents.has(sessionId)) return;
    const pending = this.takePendingSubagent(mission, sub);
    const toolUseId = sub.toolUseId ?? pending?.toolUseId;
    const label = sub.label ?? pending?.label;
    const prompt = sub.prompt ?? pending?.prompt;
    mission.knownSubagents.add(sessionId);
    mission.completedSubagents.delete(sessionId);
    if (toolUseId) mission.subagentToolUseIds.set(toolUseId, sessionId);
    this.emit({
      type: 'mission.worker',
      missionId: appSessionId,
      event: 'started',
      workerSessionId: sessionId,
      label,
      prompt,
      toolUseId,
    });
    if (prompt) {
      this.emitTranscript({
        id: `subagent-task-${sessionId}`,
        missionId: appSessionId,
        agentSessionId: sessionId,
        role: 'worker',
        ts: Date.now(),
        kind: 'status',
        text: `Task prompt\n\n${prompt}`,
      });
    }
    this.emit({ type: 'agent.updated', missionId: appSessionId, agentSessionId: sessionId, role: 'worker', status: 'running' });
  }

  private takePendingSubagent(mission: Mission, sub: PendingSubagent): PendingSubagent | undefined {
    if (mission.pendingSubagents.length === 0) return undefined;
    if (sub.toolUseId) {
      const index = mission.pendingSubagents.findIndex((pending) => pending.toolUseId === sub.toolUseId);
      if (index >= 0) return mission.pendingSubagents.splice(index, 1)[0];
    }
    const label = sub.label?.toLowerCase();
    if (label) {
      const index = mission.pendingSubagents.findIndex((pending) => pending.label?.toLowerCase() === label);
      if (index >= 0) return mission.pendingSubagents.splice(index, 1)[0];
    }
    return mission.pendingSubagents.shift();
  }

  private completeSubagentForToolUse(mission: Mission, toolUseId: string): void {
    const sessionId = mission.subagentToolUseIds.get(toolUseId);
    if (sessionId) this.completeSubagent(mission, sessionId);
  }

  private completeSubagent(mission: Mission, sessionId: string): void {
    if (!mission.knownSubagents.has(sessionId) || mission.completedSubagents.has(sessionId)) return;
    const appSessionId = mission.summary.id;
    mission.completedSubagents.add(sessionId);
    const settings = mission.subagentSettings.get(sessionId) ?? {};
    this.emit({ type: 'mission.worker', missionId: appSessionId, event: 'completed', workerSessionId: sessionId, ...settings });
    this.emit({ type: 'agent.updated', missionId: appSessionId, agentSessionId: sessionId, role: 'worker', status: 'completed' });
    void this.closeAgentWhenIdle(appSessionId, sessionId);
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
      if (n.worker.event === 'completed') void this.closeAgentWhenIdle(missionId, n.worker.workerSessionId);
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

  private emitStatus(
    missionId: string,
    text: string,
    compactType?: CompactType,
    agentSessionId?: string,
    role: AgentRole = 'orchestrator',
  ): void {
    this.emitTranscript({
      id: `status-${Date.now().toString(36)}`,
      missionId,
      agentSessionId: agentSessionId ?? missionId,
      role,
      ts: Date.now(),
      kind: 'status',
      text,
      compactType,
    });
  }

  private async compactSession(sessionId: string, customInstructions?: string, compactType: CompactType = 'manual'): Promise<void> {
    const mission = this.findMission(sessionId);
    if (mission) {
      await this.compactMission(mission, customInstructions, compactType);
      return;
    }
    await this.compactHistoricalSession(sessionId, customInstructions);
  }

  // Orchestrator (live chat) compaction. Runs the shared in-place path; if the
  // daemon returns a new backing id the `reload` hook swaps the session while
  // keeping the stable app id (summary.id) so the visible chat is unchanged.
  private async compactMission(mission: Mission, customInstructions: string | undefined, compactType: CompactType): Promise<void> {
    const appSessionId = mission.summary.id;
    const carryover: UsageOffset = {
      tokensIn: mission.summary.tokensIn ?? 0,
      tokensOut: mission.summary.tokensOut ?? 0,
    };
    mission.compacting = true;
    try {
      await runCompaction(
        mission.session,
        {
          status: (text, ct) => this.emitStatus(appSessionId, text, ct),
          error: (message) =>
            this.emitError({ sessionId: mission.summary.sessionId, missionId: appSessionId, message: `Could not compact session: ${message}` }),
          refresh: () => this.refreshContext(appSessionId, mission.session),
          reload: async (newSessionId) => {
            const compactedFromSessionIds = uniqueStrings([
              ...(mission.summary.compactedFromSessionIds ?? []),
              mission.summary.sessionId,
            ]);
            const ref = { id: appSessionId };
            const oldSession = mission.session;
            mission.session = await this.runtime.loadSession(newSessionId, {
              permissionHandler: this.makePermissionHandler(ref),
              askUserHandler: this.makeAskUserHandler(ref),
            });
            // The replacement session starts with default tool settings, so the
            // cached design-tool policy no longer reflects reality. Clear it so
            // the next turn re-synchronizes disabledToolIds.
            mission.todoDisabledForDesign = undefined;
            await oldSession.close().catch(() => {});
            this.usageOffsets.set(appSessionId, carryover);
            this.patch(appSessionId, {
              sessionId: newSessionId,
              compactedFromSessionIds,
              tokensIn: carryover.tokensIn,
              tokensOut: carryover.tokensOut,
              contextTokens: 0,
            });
          },
        },
        { customInstructions, compactType },
      );
    } finally {
      mission.compacting = false;
    }
  }

  // Compacting a session that is not currently loaded (e.g. from the sidebar
  // history). There is no live session to refresh; the swapped backing id is
  // persisted to history so the next resume continues from the compacted state.
  private async compactHistoricalSession(sessionId: string, customInstructions?: string): Promise<void> {
    const historical = this.resolveSummary(sessionId);
    const oldDroidSessionId = historical?.sessionId ?? sessionId;
    try {
      const result = await this.withSession(sessionId, (session) =>
        session.compactSession(customInstructions ? { customInstructions } : {}),
      );
      if (!result) return;
      const newSessionId = result.newSessionId || oldDroidSessionId;
      if (newSessionId !== oldDroidSessionId && historical) {
        const updated = {
          ...historical,
          sessionId: newSessionId,
          compactedFromSessionIds: uniqueStrings([...(historical.compactedFromSessionIds ?? []), oldDroidSessionId]),
          updatedAt: Date.now(),
        };
        this.history.syncSummaries([updated]);
        this.emit({ type: 'mission.updated', mission: updated });
        this.emit({ type: 'session.updated', session: updated });
      }
    } catch (err) {
      this.emitError({ sessionId: oldDroidSessionId, missionId: historical?.id ?? sessionId, message: `Could not compact session: ${errMsg(err)}` });
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
    if (mission.streaming || mission.compacting) {
      mission.pendingSends.push(text);
      this.patch(appSessionId, { queuedSends: mission.pendingSends.length });
      this.emitStatus(appSessionId, `Queued message ${mission.pendingSends.length}.`);
      return;
    }
    await this.drive(appSessionId, text);
  }

  private async sendNow(missionId: string, text: string): Promise<void> {
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
    if (!mission.streaming) {
      await this.drive(appSessionId, text);
      return;
    }
    mission.pendingSends.unshift(text);
    mission.interruptingForSteer = true;
    this.patch(appSessionId, { queuedSends: mission.pendingSends.length });
    this.emitStatus(appSessionId, 'Steering now...');
    try {
      await mission.session.interrupt();
    } catch (err) {
      mission.interruptingForSteer = false;
      this.emitError({
        code: 'session.send_now_failed',
        missionId: appSessionId,
        message: `Could not interrupt session for steering: ${errMsg(err)}`,
      });
    }
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
    settings: { modelId?: string | null; reasoningEffort?: ReasoningEffort; autonomy?: Autonomy | 'none' },
  ): Promise<void> {
    const mission = this.findMission(sessionId);
    const historical = this.resolveSummary(sessionId);
    const appSessionId = mission?.summary.id ?? historical?.id ?? sessionId;
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
    if (settings.autonomy) {
      const nextAutonomy = normalizeAutonomy(settings.autonomy);
      if (!nextAutonomy) throw new Error(`Unsupported autonomy level: ${settings.autonomy}`);
      next.autonomyLevel = nextAutonomy;
      patch.autonomy = nextAutonomy;
    }
    if (Object.keys(next).length === 0) return;
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
    if (!this.agentBelongsToMission(mission, agentSessionId)) return;
    if (mission.agents.has(agentSessionId)) {
      const agent = mission.agents.get(agentSessionId);
      if (agent) agent.lastUsedAt = Date.now();
      this.emit({ type: 'agent.updated', missionId: appSessionId, agentSessionId, role, status: 'opened' });
      return;
    }
    try {
      if (!(await this.ensureAgentCapacity(mission, agentSessionId))) return;
      const ref = { id: appSessionId };
      const session = await this.runtime.loadSession(agentSessionId, {
        permissionHandler: this.makePermissionHandler(ref),
        askUserHandler: this.makeAskUserHandler(ref),
      });
      const actualSettings = subagentSettingsFromInit(session.initResult as InitResultLike);
      // For a chat/spec subagent, fall back to the session's model when the
      // droid inherits it. Mission Control workers/validators keep their own
      // configured model selection untouched.
      const inheritsSessionModel = mission.summary.kind === 'chat' || mission.summary.kind === 'spec';
      const resolvedSettings: SubagentSettings =
        inheritsSessionModel
          ? {
              modelId: actualSettings.modelId ?? mission.summary.modelId,
              reasoningEffort: actualSettings.reasoningEffort ?? mission.summary.reasoningEffort,
            }
          : actualSettings;
      if (resolvedSettings.modelId || resolvedSettings.reasoningEffort) {
        mission.subagentSettings.set(agentSessionId, resolvedSettings);
        this.emit({
          type: 'mission.worker',
          missionId: appSessionId,
          event: 'updated',
          workerSessionId: agentSessionId,
          ...resolvedSettings,
        });
      }
      const defaults = await this.getFactoryDefaults();
      const workerModelId = resolvedSettings.modelId ?? mission.summary.modelId;
      const agent: LiveAgent = {
        session,
        missionId: appSessionId,
        role,
        streaming: false,
        pendingSends: [],
        lastUsedAt: Date.now(),
        effectiveCompactionTokenLimit: effectiveCompactionLimit(
          workerModelId,
          defaults,
          this.maxContextTokensForModel(workerModelId),
        ),
      };
      agent.unsubscribe = session.onNotification((note: Record<string, unknown>) => {
        for (const n of normalizeNotification(appSessionId, agentSessionId, role, note)) this.applyNormalized(appSessionId, n);
      });
      mission.agents.set(agentSessionId, agent);
      this.emitAgentHistory(appSessionId, agentSessionId);
      this.emit({ type: 'agent.updated', missionId: appSessionId, agentSessionId, role, status: 'opened' });
    } catch (err) {
      this.emit({ type: 'error', code: 'agent.open_failed', missionId: appSessionId, sessionId: agentSessionId, message: errMsg(err) });
    }
  }

  private emitAgentHistory(appSessionId: string, agentSessionId: string): void {
    try {
      const page = loadSessionPage(agentSessionId, undefined, 200, appSessionId);
      for (const event of page.events) this.emitTranscript(event);
    } catch {
      /* Some live subagents have not flushed local history yet. Live notifications still stream after open. */
    }
  }

  private async sendAgent(missionId: string, agentSessionId: string, text: string): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    if (!this.agentBelongsToMission(mission, agentSessionId)) return;
    if (!mission.agents.has(agentSessionId)) await this.openAgent(appSessionId, agentSessionId, 'worker');
    const agent = mission.agents.get(agentSessionId);
    if (!agent) return;
    agent.lastUsedAt = Date.now();
    if (agent.streaming || agent.compacting) {
      agent.pendingSends.push(text);
      this.emitStatus(appSessionId, `Queued subagent message ${agent.pendingSends.length}.`);
      return;
    }
    await this.driveAgent(agent, text);
  }

  private async driveAgent(agent: LiveAgent, text: string): Promise<void> {
    agent.streaming = true;
    agent.lastUsedAt = Date.now();
    this.emit({ type: 'agent.updated', missionId: agent.missionId, agentSessionId: agent.session.sessionId, role: agent.role, status: 'running' });
    this.startContextPolling(agent.session.sessionId, agent.session);
    try {
      const stream = agent.session.stream(text, { includePartialMessages: true });
      for await (const ev of stream) this.applyEvent(agent.missionId, agent.session.sessionId, agent.role, ev);
    } catch (err) {
      if (agent.interruptingForSteer) this.emitStatus(agent.missionId, 'Subagent turn interrupted for steering.');
      else {
        const message = errMsg(err);
        this.emit({ type: 'agent.not_steerable', missionId: agent.missionId, agentSessionId: agent.session.sessionId, message });
        this.emit({ type: 'error', code: 'agent.not_steerable', missionId: agent.missionId, sessionId: agent.session.sessionId, message });
      }
    } finally {
      this.stopContextPolling(agent.session.sessionId);
      agent.interruptingForSteer = false;
      if (agent.pendingSends.length === 0 && agent.closeWhenIdle) {
        agent.streaming = false;
        await this.closeAgent(agent.missionId, agent.session.sessionId);
      } else {
        // Refresh + auto-compact while streaming stays true so concurrent sends
        // queue instead of racing a second driveAgent(). Worker compaction is
        // in-place and scoped to this worker's own session/history.
        await this.refreshContext(agent.session.sessionId, agent.session);
        const compaction = await this.maybeAutoCompactAgent(agent);
        agent.streaming = false;
        if (compaction === 'stale') {
          // The daemon swapped the worker's backing session id, which we cannot
          // adopt without re-keying. Close the stale session and re-deliver any
          // queued user input against a fresh one rather than dropping it or
          // reusing the stale session.
          const queued = agent.pendingSends.splice(0);
          const agentSessionId = agent.session.sessionId;
          this.contextSnapshots.delete(agentSessionId);
          await this.closeAgent(agent.missionId, agentSessionId);
          for (const queuedText of queued) await this.sendAgent(agent.missionId, agentSessionId, queuedText);
          return;
        }
        // A transient compaction failure leaves the session valid, so fall
        // through and drain queued sends normally.
        const next = agent.pendingSends.shift();
        if (next !== undefined) void this.driveAgent(agent, next);
        else this.emit({ type: 'agent.updated', missionId: agent.missionId, agentSessionId: agent.session.sessionId, role: agent.role, status: 'paused' });
      }
    }
  }

  // Workers compact their own session through the shared in-place path. No
  // reload hook: a worker keeps its session id stable so the orchestrator's
  // handoff addressing is never altered, and only this worker's own
  // session/history is affected. Returns the compaction outcome (or undefined
  // when no compaction was attempted) so the caller can recover on failure.
  private async maybeAutoCompactAgent(agent: LiveAgent): Promise<CompactionOutcome | undefined> {
    const used = this.contextSnapshots.get(agent.session.sessionId)?.used;
    if (!autoCompactionDue(agent, used)) return undefined;
    return this.compactAgent(agent, 'auto');
  }

  private async compactAgent(agent: LiveAgent, compactType: CompactType): Promise<CompactionOutcome> {
    const agentSessionId = agent.session.sessionId;
    agent.compacting = true;
    try {
      return await runCompaction(
        agent.session,
        {
          status: (text, ct) => this.emitStatus(agent.missionId, text, ct, agentSessionId, agent.role),
          error: (message) =>
            this.emitError({ sessionId: agentSessionId, missionId: agent.missionId, message: `Could not compact subagent: ${message}` }),
          refresh: () => this.refreshContext(agentSessionId, agent.session),
          // No reload hook: a worker keyed by its session id is also how the
          // orchestrator addresses its handoff/result, so it must never swap to
          // a new backing id. runCompaction reports a swap as a 'stale' outcome
          // instead, and the driver recovers by reopening a fresh session.
        },
        { compactType },
      );
    } finally {
      agent.compacting = false;
    }
  }

  private async sendAgentNow(missionId: string, agentSessionId: string, text: string): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    if (!this.agentBelongsToMission(mission, agentSessionId)) return;
    if (!mission.agents.has(agentSessionId)) await this.openAgent(appSessionId, agentSessionId, 'worker');
    const agent = mission.agents.get(agentSessionId);
    if (!agent) return;
    agent.lastUsedAt = Date.now();
    if (!agent.streaming && !agent.compacting) {
      await this.driveAgent(agent, text);
      return;
    }
    // Run next after the in-flight turn/compaction; never interrupt a compaction.
    agent.pendingSends.unshift(text);
    if (agent.compacting) return;
    agent.interruptingForSteer = true;
    this.emitStatus(appSessionId, 'Steering subagent now...');
    try {
      await agent.session.interrupt();
    } catch (err) {
      agent.interruptingForSteer = false;
      this.emit({
        type: 'error',
        code: 'agent.send_now_failed',
        missionId: appSessionId,
        sessionId: agentSessionId,
        message: `Could not interrupt subagent for steering: ${errMsg(err)}`,
      });
    }
  }

  private async interruptAgent(missionId: string, agentSessionId: string): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    if (!this.agentBelongsToMission(mission, agentSessionId)) return;
    if (!mission.agents.has(agentSessionId)) await this.openAgent(appSessionId, agentSessionId, 'worker');
    const agent = mission.agents.get(agentSessionId);
    if (!agent) return;
    agent.pendingSends = [];
    agent.lastUsedAt = Date.now();
    await agent.session.interrupt();
    agent.streaming = false;
    this.emit({ type: 'agent.updated', missionId: appSessionId, agentSessionId, role: agent.role, status: 'paused' });
  }

  private agentBelongsToMission(mission: Mission, agentSessionId: string): boolean {
    if (mission.summary.kind === 'mission_orchestrator') return true;
    if (mission.knownSubagents.has(agentSessionId)) return true;
    const appSessionId = mission.summary.id;
    this.emit({
      type: 'error',
      code: 'agent.not_in_session',
      missionId: appSessionId,
      sessionId: agentSessionId,
      message: `Subagent ${agentSessionId} is not tied to session ${appSessionId}.`,
    });
    return false;
  }

  private async ensureAgentCapacity(mission: Mission, requestedAgentSessionId: string): Promise<boolean> {
    if (mission.agents.size < MAX_OPEN_AGENT_TRANSPORTS) return true;
    const idle = [...mission.agents.entries()]
      .filter(([sessionId, agent]) =>
        sessionId !== requestedAgentSessionId &&
        !agent.streaming &&
        agent.pendingSends.length === 0)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (idle) {
      await this.closeAgent(mission.summary.id, idle[0]);
      return true;
    }
    this.emitError({
      missionId: mission.summary.id,
      message: `Open live agent transport limit reached (${MAX_OPEN_AGENT_TRANSPORTS}). Wait for one running worker view to finish before opening another live worker view.`,
    });
    return false;
  }

  private async closeAgent(missionId: string, agentSessionId: string): Promise<void> {
    const mission = this.findMission(missionId);
    const agent = mission?.agents.get(agentSessionId);
    if (!mission || !agent) return;
    mission.agents.delete(agentSessionId);
    this.stopContextPolling(agent.session.sessionId);
    agent.unsubscribe?.();
    try {
      await agent.session.close();
    } catch {
      /* ignore */
    }
  }

  private async closeAgentWhenIdle(missionId: string, agentSessionId: string): Promise<void> {
    const mission = this.findMission(missionId);
    const agent = mission?.agents.get(agentSessionId);
    if (!mission || !agent) return;
    agent.closeWhenIdle = true;
    if (!agent.streaming && agent.pendingSends.length === 0) await this.closeAgent(missionId, agentSessionId);
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
      this.emit({ type: 'catalog.updated', catalog: 'skills', items: arrayItems(result, 'skills'), sessionId: sessionId ?? null });
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
    for (const server of mission.mcpServers) {
      await server.close().catch(() => {});
    }
    try {
      await mission.session.close();
    } catch {
      /* ignore */
    }
    await this.browsers.close(mission.summary.sessionId ?? key).catch(() => {});
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

  private async handleBrowser(missionId: string | undefined, action: () => Promise<void | unknown>): Promise<void> {
    try {
      await action();
    } catch (err) {
      const message = errMsg(err);
      this.emit({ type: 'browser.error', missionId, message });
      this.emitError({ code: 'browser.error', missionId, message });
    }
  }

  private requestNativeBrowser(request: BrowserNativeRequest): Promise<BrowserNativeResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingNativeBrowserRequests.delete(request.requestId);
        reject(new Error(`Droid Control browser did not respond to ${request.action} within ${BROWSER_NATIVE_TIMEOUT_MS}ms.`));
      }, BROWSER_NATIVE_TIMEOUT_MS);
      this.pendingNativeBrowserRequests.set(request.requestId, { resolve, reject, timeout });
      this.emit({ type: 'browser.native.request', request });
    });
  }

  private resolveNativeBrowserRequest(result: BrowserNativeResult): void {
    const pending = this.pendingNativeBrowserRequests.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingNativeBrowserRequests.delete(result.requestId);
    if (result.ok) pending.resolve(result);
    else pending.reject(new Error(result.error ?? 'Droid Control browser action failed.'));
  }

  private requireBrowserMissionId(missionId?: string): string {
    if (!missionId) {
      throw new Error('Browser sessions are scoped to a Droid chat. Select or create a chat before opening the browser.');
    }
    return missionId;
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.missions.keys()]) await this.closeMission(id);
    await this.browsers.closeAll();
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

function subagentSettingsFromInit(init: InitResultLike): SubagentSettings {
  return {
    modelId: init.settings?.modelId,
    reasoningEffort: reasoningValue(init.settings?.reasoningEffort),
  };
}

function reasoningValue(value?: string): ReasoningEffort | undefined {
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
  ) return value;
  return undefined;
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

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeAutonomy(value: unknown): Autonomy | undefined {
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
    'modelId' | 'reasoningEffort' | 'specModelId' | 'specReasoningEffort' | 'missionOrchestratorModelId' | 'missionOrchestratorReasoningEffort'
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
  cmd: { workerModel?: string; workerReasoning?: ReasoningEffort; validatorModel?: string; validatorReasoning?: ReasoningEffort },
  defaults: Pick<
    FactoryDefaultSettings,
    'workerModelId' | 'workerReasoningEffort' | 'validatorModelId' | 'validatorReasoningEffort'
  >,
): Pick<MissionSummary, 'workerModelId' | 'workerReasoningEffort' | 'validatorModelId' | 'validatorReasoningEffort'> {
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
    if (settings.reasoningEffort !== undefined) missionSettings.workerReasoningEffort = settings.reasoningEffort;
  } else {
    if (settings.modelId) missionSettings.validationWorkerModel = settings.modelId;
    if (settings.reasoningEffort !== undefined) missionSettings.validationWorkerReasoningEffort = settings.reasoningEffort;
  }

  if (Object.keys(missionSettings).length > 0) next.missionSettings = missionSettings;
  return next;
}

export function startupFactoryDefaults(defaults: FactoryDefaultSettings, models: ModelInfo[]): FactoryDefaultSettings {
  if (models.length > 0) return validateFactoryDefaults(defaults, models);
  const safe: FactoryDefaultSettings = {
    autonomy: defaults.autonomy,
    interactionMode: defaults.interactionMode,
    compactionTokenLimit: normalizeCompactionTokenLimit(defaults.compactionTokenLimit),
    compactionTokenLimitPerModel: validCompactionTokenLimitRecord(defaults.compactionTokenLimitPerModel),
  };
  if (defaults.compactionModel === 'current-model') safe.compactionModel = 'current-model';
  return safe;
}

export function validateFactoryDefaults(defaults: FactoryDefaultSettings, models: ModelInfo[]): FactoryDefaultSettings {
  if (models.length === 0) return runtimeFactoryDefaultsWithoutCatalog(defaults);
  const cliDefault = models.find((model) => model.isDefault && !model.isCustom) ?? models.find((model) => !model.isCustom) ?? models[0];
  return {
    ...defaults,
    modelId: validModelId(defaults.modelId, models) ?? cliDefault?.id,
    reasoningEffort: validReasoning(defaults.modelId, defaults.reasoningEffort, models) ?? cliDefault?.defaultReasoningEffort,
    compactionModel: validCompactionModel(defaults.compactionModel, models),
    compactionTokenLimit: normalizeCompactionTokenLimit(defaults.compactionTokenLimit),
    compactionTokenLimitPerModel: validCompactionTokenLimitPerModel(defaults.compactionTokenLimitPerModel, models),
    specModelId: validModelId(defaults.specModelId, models) ?? validModelId(defaults.modelId, models) ?? cliDefault?.id,
    specReasoningEffort: validReasoning(defaults.specModelId, defaults.specReasoningEffort, models),
    workerModelId: validModelId(defaults.workerModelId, models) ?? cliDefault?.id,
    workerReasoningEffort: validReasoning(defaults.workerModelId, defaults.workerReasoningEffort, models),
    validatorModelId: validModelId(defaults.validatorModelId, models) ?? cliDefault?.id,
    validatorReasoningEffort: validReasoning(defaults.validatorModelId, defaults.validatorReasoningEffort, models),
  };
}

function runtimeFactoryDefaultsWithoutCatalog(defaults: FactoryDefaultSettings): FactoryDefaultSettings {
  return {
    ...defaults,
    compactionTokenLimit: normalizeCompactionTokenLimit(defaults.compactionTokenLimit),
    compactionTokenLimitPerModel: validCompactionTokenLimitRecord(defaults.compactionTokenLimitPerModel),
  };
}

function validModelId(modelId: string | undefined, models: ModelInfo[]): string | undefined {
  return modelId && models.some((model) => model.id === modelId) ? modelId : undefined;
}

function validReasoning(modelId: string | undefined, reasoning: ReasoningEffort | undefined, models: ModelInfo[]): ReasoningEffort | undefined {
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

function validCompactionTokenLimitRecord(limits: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!limits) return undefined;
  const entries = Object.entries(limits)
    .map(([modelId, limit]) => [modelId, normalizeCompactionTokenLimit(limit)] as const)
    .filter((entry): entry is [string, number] => Boolean(entry[0]) && entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function validCompactionTokenLimitPerModel(limits: Record<string, number> | undefined, models: ModelInfo[]): Record<string, number> | undefined {
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

function defaultModelForAgent(agent: ConfigurableAgent, mode: SessionInteractionMode, defaults: FactoryDefaultSettings): string | undefined {
  if (agent === 'worker') return defaults.workerModelId;
  if (agent === 'validator') return defaults.validatorModelId;
  return modelDefaultForMode(mode, defaults);
}

function modeForSummary(summary: MissionSummary): SessionInteractionMode {
  if (summary.kind === 'spec') return 'spec';
  if (summary.kind === 'mission_orchestrator') return 'agi';
  return 'auto';
}

function reasoningDefaultForMode(
  mode: SessionInteractionMode,
  defaults: Pick<FactoryDefaultSettings, 'reasoningEffort' | 'specReasoningEffort' | 'missionOrchestratorReasoningEffort'>,
): ReasoningEffort | undefined {
  if (mode === 'spec') return defaults.specReasoningEffort ?? defaults.reasoningEffort;
  if (mode === 'agi') return defaults.missionOrchestratorReasoningEffort ?? defaults.reasoningEffort;
  return defaults.reasoningEffort;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
