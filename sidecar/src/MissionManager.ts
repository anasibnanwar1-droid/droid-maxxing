import {
  ContextBreakdownResultSchema,
  DecompSessionType,
  DroidInteractionMode,
  type AskUserHandler,
  type AskUserRequestParams,
  type AskUserResult,
  type DroidSession,
  type SdkMcpServer,
  type PermissionHandler,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';
import { homedir, tmpdir } from 'node:os';
import type {
  AgentRole,
  Autonomy,
  BridgeFeature,
  BrowserNativeRequest,
  BrowserNativeResult,
  ClientCommand,
  ConfigurableAgent,
  ContextBreakdownSnapshot,
  ContextStatsSnapshot,
  FactoryDefaultSettings,
  HistoryMission,
  InstallChannel,
  MissionPhase,
  MissionSummary,
  ModelInfo,
  PermissionKind,
  ReasoningEffort,
  ServerEvent,
  SessionInteractionMode,
  SessionKind,
  TranscriptEvent,
  WorkerHistoryLink,
} from './protocol.js';
import { DroidRuntime } from './DroidRuntime.js';
import { detectEnvironment } from './Environment.js';
import { buildInstallCommand, buildUpdateCommand, runStreaming } from './CliInstaller.js';
import {
  classifyPermission,
  confirmationType,
  isSessionCompactedNotification,
  mapFeature,
  normalizeNotification,
  normalizeStreamEvent,
  permissionSignature,
} from './normalize.js';
import {
  applyCachedSummary,
  HistoryIndex,
  hydrateHistoricalMission,
  loadHistoricalMissions,
  loadHistoricalSessions,
  loadMissionTranscriptWindow,
  loadSessionHistory,
  loadSessionPage,
  readFactoryDefaults,
  resolveSessionChain,
} from './history.js';
import { mergeModelCatalog } from './modelCatalog.js';
import { readDroidCliModelCatalog, readDroidCliModelCatalogCache } from './DroidCliCatalog.js';
import { BrowserSessionManager } from './browser/BrowserSessionManager.js';
import { createBrowserMcpServer } from './browser/browserMcpServer.js';
import { isDesignPrompt } from './browser/designPromptPacks.js';
import { NativeBrowserRuntime } from './browser/NativeBrowserRuntime.js';
import {
  boundedInt,
  contextBreakdownSnapshot,
  contextStatsSnapshot,
  createAutonomyForCommand,
  createMissionAgentDefaultsForMode,
  createModelDefaultsForMode,
  createSessionSettingsForAgent,
  defaultModelForAgent,
  errMsg,
  isWindowTokenCount,
  modeForSummary,
  normalizeAutonomy,
  startupFactoryDefaults,
  stringValue,
  uniqueStrings,
  validateFactoryDefaults,
  type AgentSettingPatch,
} from './missionManagerHelpers.js';
import {
  isAlwaysOutcome,
  isApprovalOutcome,
  normalizePermissionOutcome,
} from './permissionOutcomes.js';
import { filterMissionListSummaries, type MissionListFilterOptions } from './missionListFilter.js';
import {
  clampCompactionTokenLimit,
  compactionTokenLimitForModel,
  createCompactionSettingsForModel,
  normalizeCompactionTokenLimit,
  runCompaction,
  type CompactType,
} from './compaction.js';

export {
  createAutonomyForCommand,
  createMissionAgentDefaultsForMode,
  createModelDefaultsForMode,
  createSessionSettingsForAgent,
  startupFactoryDefaults,
  validateFactoryDefaults,
} from './missionManagerHelpers.js';

type Emit = (event: ServerEvent) => void;

interface MissionManagerOptions {
  assetUrlFor?: (path: string) => string;
}

interface LiveAgent {
  session: DroidSession;
  missionId: string;
  role: AgentRole;
  streaming: boolean;
  compacting?: boolean;
  pendingSends: string[];
  interruptingForSteer?: boolean;
  lastUsedAt: number;
  closeWhenIdle?: boolean;
  unsubscribe?: () => void;
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
  // Worker session ids tied to this mission by persisted spawn->worker links,
  // seeded on resume so historical subagents stay openable even before any live
  // spawn re-populates knownSubagents. Kept separate from knownSubagents so live
  // run-status reporting only reflects subagents actually seen this session.
  linkedSubagents: Set<string>;
  subagentToolUseIds: Map<string, string>;
  agentSessionAliases?: Map<string, string>;
  subagentSettings: Map<string, SubagentSettings>;
  pendingSubagents: PendingSubagent[];
  mcpServers: SdkMcpServer[];
  // The started local MCP server configs (handles to the running servers above),
  // retained so a post-compaction session swap can re-attach the same tools.
  mcpConfigs?: Awaited<ReturnType<SdkMcpServer['start']>>[];
  permissionGrants: Set<string>;
  // Tracks whether TodoWrite is currently disabled on the session so we only
  // call updateSettings when the design/normal turn policy actually changes.
  todoDisabledForDesign?: boolean;
  // Guards manual compactSession so it cannot overlap with another compaction
  // or a streaming turn.
  compacting?: boolean;
  unsubscribe?: () => void;
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

interface UsageOffset {
  tokensIn: number;
  tokensOut: number;
}

interface CompactionSettings {
  compactionTokenLimit?: number | null;
  compactionTokenLimitPerModel?: Record<string, number>;
}

interface CompactionSettingsPatch {
  compactionTokenLimit?: number | null | 'factory-default';
  compactionTokenLimitPerModel?: Record<string, number>;
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

function shouldSettleToPaused(phase: MissionPhase): boolean {
  return !['completed', 'failed', 'awaiting_plan_approval', 'awaiting_run_start'].includes(phase);
}

function hasCompactionSettingsPatch(
  settings: CompactionSettingsPatch | undefined,
): settings is CompactionSettingsPatch {
  return (
    settings?.compactionTokenLimit !== undefined ||
    settings?.compactionTokenLimitPerModel !== undefined
  );
}

const MAX_OPEN_AGENT_TRANSPORTS = boundedInt(process.env.DROID_CONTROL_MAX_OPEN_AGENTS, 4, 1, 24);
const BROWSER_NATIVE_TIMEOUT_MS = boundedInt(
  process.env.DROID_CONTROL_BROWSER_NATIVE_TIMEOUT_MS,
  12_000,
  1_000,
  60_000,
);

let permSeq = 0;
const nextRequestId = () => `req-${Date.now().toString(36)}-${(permSeq++).toString(36)}`;
let nativeBrowserSeq = 0;
const nextNativeBrowserRequestId = () =>
  `browser-native-${Date.now().toString(36)}-${(nativeBrowserSeq++).toString(36)}`;

interface PendingNativeBrowserRequest {
  resolve: (result: BrowserNativeResult) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class MissionManager {
  private ready = false;
  // Monotonic suffix so two status lines emitted in the same millisecond get
  // distinct transcript IDs (the UI drops duplicate IDs, which could otherwise
  // strand the in-progress compaction shimmer).
  private statusSeq = 0;
  private cachedModels: ModelInfo[] | null = null;
  private cachedFactoryDefaults: FactoryDefaultSettings = {};
  private modelRefresh: Promise<ModelInfo[] | null> | null = null;
  private readonly runtime = new DroidRuntime();
  private readonly history = new HistoryIndex();
  private readonly missions = new Map<string, Mission>();
  private readonly pendingAgentSettings = new Map<
    string,
    Partial<Record<ConfigurableAgent, AgentSettingPatch>>
  >();
  private readonly usageOffsets = new Map<string, UsageOffset>();
  private readonly contextSnapshots = new Map<string, ContextStatsSnapshot>();
  private readonly contextPollers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pendingNativeBrowserRequests = new Map<string, PendingNativeBrowserRequest>();
  private currentCompactionSettings: CompactionSettings = {};
  private readonly browsers: BrowserSessionManager;

  constructor(
    private readonly emit: Emit,
    options: MissionManagerOptions = {},
  ) {
    this.browsers = new BrowserSessionManager({
      assetUrlFor: options.assetUrlFor,
      emit: (event) => this.emit(event),
      runtimeFactory: (sessionId, viewport, missionId) =>
        new NativeBrowserRuntime({
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
        void this.pollAuthAfterLogin();
        return;
      case 'env.detect':
        await this.emitEnvironment();
        return;
      case 'cli.install':
        await this.runCliInstall(cmd.channel);
        return;
      case 'cli.update':
        await this.runCliUpdate(cmd.channel);
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
      case 'settings.compaction.update':
        await this.updateLiveCompactionSettings(cmd);
        return;
      case 'session.create':
        await this.createMission({ ...cmd, type: 'mission.create' });
        return;
      case 'mission.create':
        await this.createMission(cmd);
        return;
      case 'session.send':
      case 'mission.send':
        await this.send('sessionId' in cmd ? cmd.sessionId : cmd.missionId, cmd.text, {
          compactionTokenLimit: cmd.compactionTokenLimit,
          compactionTokenLimitPerModel: cmd.compactionTokenLimitPerModel,
        });
        return;
      case 'session.sendNow':
      case 'mission.sendNow':
        await this.sendNow('sessionId' in cmd ? cmd.sessionId : cmd.missionId, cmd.text, {
          compactionTokenLimit: cmd.compactionTokenLimit,
          compactionTokenLimitPerModel: cmd.compactionTokenLimitPerModel,
        });
        return;
      case 'approval.respond':
      case 'mission.respondPermission':
        await this.resolvePermission(cmd.missionId, cmd.requestId, cmd.outcome, {
          compactionTokenLimit: cmd.compactionTokenLimit,
          compactionTokenLimitPerModel: cmd.compactionTokenLimitPerModel,
        });
        return;
      case 'question.respond':
      case 'mission.respondQuestion':
        await this.resolveQuestion(cmd.missionId, cmd.requestId, cmd.cancelled, cmd.answers, {
          compactionTokenLimit: cmd.compactionTokenLimit,
          compactionTokenLimitPerModel: cmd.compactionTokenLimitPerModel,
        });
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
        await this.sendAgent(cmd.missionId, cmd.agentSessionId, cmd.text, {
          compactionTokenLimit: cmd.compactionTokenLimit,
          compactionTokenLimitPerModel: cmd.compactionTokenLimitPerModel,
        });
        return;
      case 'agent.sendNow':
        await this.sendAgentNow(cmd.missionId, cmd.agentSessionId, cmd.text, {
          compactionTokenLimit: cmd.compactionTokenLimit,
          compactionTokenLimitPerModel: cmd.compactionTokenLimitPerModel,
        });
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
        const activeAgent =
          (mission ? this.findActiveLiveAgent(mission) : undefined) ??
          this.findLiveAgent(missionId);
        if (mission?.streaming || mission?.compacting) {
          this.emitStatus(
            missionId,
            'Cannot compact while a turn is active. Try again when the model is idle.',
          );
          return;
        }
        if (activeAgent?.agent.streaming || activeAgent?.agent.compacting) {
          this.emitStatus(
            activeAgent.mission.summary.id,
            'Cannot compact while a turn is active. Try again when the model is idle.',
            undefined,
            activeAgent.agent.session.sessionId,
            activeAgent.agent.role,
          );
          return;
        }
        if (activeAgent) {
          await this.compactLiveAgent(
            activeAgent.mission,
            activeAgent.agent,
            cmd.customInstructions,
          );
          return;
        }
        await this.compactSession(missionId, cmd.customInstructions, 'manual');
        // Manual compaction is a standalone command. Drain one queued send now;
        // drive()'s finally chains the rest.
        const compacted = this.findMission(missionId);
        if (compacted && !compacted.streaming && !compacted.compacting) {
          const next = compacted.pendingSends.shift();
          if (next !== undefined) {
            this.patch(compacted.summary.id, { queuedSends: compacted.pendingSends.length });
            await this.drive(compacted.summary.id, next);
          }
        } else if (!compacted && mission) {
          // Stale-swap recovery dropped the live mission during compaction; the
          // queued prompts live on the detached mission object, so re-deliver
          // them through the resume path instead of discarding them.
          const queued = mission.pendingSends.splice(0);
          if (queued.length > 0) await this.redeliverQueuedSends(missionId, queued);
        }
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
        await this.withSession(cmd.sessionId, (session) =>
          session.executeRewind({ rewindId: cmd.rewindId } as never),
        );
        return;
      case 'session.resume':
      case 'mission.resume':
        await this.resumeMission(cmd.sessionId, cmd);
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
        this.loadMissionHistory(cmd.missionId, cmd.cursor);
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
        await this.handleBrowser(cmd.missionId, () =>
          this.browsers.open({ ...cmd, missionId: this.requireBrowserMissionId(cmd.missionId) }),
        );
        return;
      case 'browser.close':
        await this.handleBrowser(cmd.missionId, async () => {
          const missionId = this.requireBrowserMissionId(cmd.missionId);
          await this.browsers.close(missionId);
          this.emit({ type: 'browser.closed', missionId });
        });
        return;
      case 'browser.reload':
        await this.handleBrowser(cmd.missionId, () =>
          this.browsers.reload(this.requireBrowserMissionId(cmd.missionId)),
        );
        return;
      case 'browser.refresh':
        await this.handleBrowser(cmd.missionId, () =>
          this.browsers.refresh(this.requireBrowserMissionId(cmd.missionId)),
        );
        return;
      case 'browser.resizeViewport':
        await this.handleBrowser(cmd.missionId, () =>
          this.browsers.resizeViewport({
            ...cmd,
            missionId: this.requireBrowserMissionId(cmd.missionId),
          }),
        );
        return;
      case 'browser.click':
        await this.handleBrowser(cmd.missionId, () =>
          this.browsers.click({ ...cmd, missionId: this.requireBrowserMissionId(cmd.missionId) }),
        );
        return;
      case 'browser.type':
        await this.handleBrowser(cmd.missionId, () =>
          this.browsers.type(this.requireBrowserMissionId(cmd.missionId), cmd.text),
        );
        return;
      case 'browser.keypress':
        await this.handleBrowser(cmd.missionId, () =>
          this.browsers.keypress(this.requireBrowserMissionId(cmd.missionId), cmd.key),
        );
        return;
      case 'browser.scroll':
        await this.handleBrowser(cmd.missionId, () =>
          this.browsers.scroll(
            this.requireBrowserMissionId(cmd.missionId),
            cmd.direction,
            cmd.pixels,
            cmd.source,
          ),
        );
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
          const element = this.browsers.inspectPoint(
            this.requireBrowserMissionId(cmd.missionId),
            cmd.x,
            cmd.y,
          );
          if (!element) throw new Error('No browser element found at that point.');
        });
        return;
      case 'browser.design.addReference':
        await this.handleBrowser(cmd.missionId, async () => {
          await this.browsers.addReference(
            this.requireBrowserMissionId(cmd.missionId),
            {
              anchor: cmd.reference.anchor,
              detail: cmd.reference.detail,
              id: cmd.reference.id,
            },
            cmd.reference.screenshot,
          );
        });
        return;
      case 'browser.design.sendPrompt':
        await this.handleBrowser(cmd.missionId, async () => {
          const missionId = this.requireBrowserMissionId(cmd.missionId);
          const { prompt } = await this.browsers.designPrompt({ ...cmd, missionId });
          await this.send(missionId, prompt, {
            compactionTokenLimit: cmd.compactionTokenLimit,
            compactionTokenLimitPerModel: cmd.compactionTokenLimitPerModel,
          });
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
        const models = mergeModelCatalog(
          await readDroidCliModelCatalog(this.runtime.status().droidPath),
        );
        this.cachedModels = models;
        if (emit) {
          this.emit({ type: 'models.list', models });
          this.emit({ type: 'catalog.updated', catalog: 'models', items: models });
        }
        return models;
      } catch (err) {
        if (emit) this.emitError({ message: `models.list failed: ${errMsg(err)}` });
        return null;
      } finally {
        this.modelRefresh = null;
      }
    })();
    return this.modelRefresh;
  }

  private async emitEnvironment(): Promise<void> {
    const report = await detectEnvironment(this.runtime.status().apiKeyConfigured);
    this.emit({ type: 'env.report', report });
  }

  private async runCliInstall(channel: InstallChannel): Promise<void> {
    const cmd = buildInstallCommand(channel);
    const exitCode = await runStreaming(cmd, ({ stream, line }) =>
      this.emit({ type: 'cli.install.progress', phase: 'install', stream, line }),
    );
    this.emit({ type: 'cli.install.done', phase: 'install', ok: exitCode === 0, exitCode });
    this.emit({ type: 'runtime.updated', status: this.runtime.status() });
    await this.emitEnvironment();
  }

  private async runCliUpdate(channel?: InstallChannel): Promise<void> {
    const status = this.runtime.status();
    const env = await detectEnvironment(status.apiKeyConfigured);
    const cmd = buildUpdateCommand(channel, status.droidPath, env.cli.present);
    const exitCode = await runStreaming(cmd, ({ stream, line }) =>
      this.emit({ type: 'cli.install.progress', phase: 'update', stream, line }),
    );
    this.emit({ type: 'cli.install.done', phase: 'update', ok: exitCode === 0, exitCode });
    this.emit({ type: 'runtime.updated', status: this.runtime.status() });
    await this.emitEnvironment();
  }

  // After `droid login` opens the browser, the auth marker appears once the
  // user finishes. Re-emit environment a few times so the UI flips to signed-in
  // without forcing the user to click refresh.
  private async pollAuthAfterLogin(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const report = await detectEnvironment(this.runtime.status().apiKeyConfigured);
      this.emit({ type: 'env.report', report });
      if (report.auth.loginPresent) return;
    }
  }

  private async getFactoryDefaults(): Promise<FactoryDefaultSettings> {
    const defaults = readFactoryDefaults();
    const models = await this.getModels();
    const safeDefaults = validateFactoryDefaults(defaults, models);
    this.cachedFactoryDefaults = safeDefaults;
    return safeDefaults;
  }

  private async emitFactoryDefaults(): Promise<void> {
    const defaults = readFactoryDefaults();
    const droidPath = this.runtime.status().droidPath;
    const models = this.cachedModels ?? mergeModelCatalog(readDroidCliModelCatalogCache(droidPath));
    if (!this.cachedModels && models.length > 0) this.cachedModels = models;
    const safeDefaults = startupFactoryDefaults(defaults, models);
    this.cachedFactoryDefaults = safeDefaults;
    this.emit({ type: 'settings.defaults', defaults: safeDefaults });
  }

  private async updateLiveCompactionSettings(
    cmd: Extract<ClientCommand, { type: 'settings.compaction.update' }>,
  ): Promise<void> {
    const defaults = await this.getFactoryDefaults();
    this.cachedFactoryDefaults = defaults;
    const settings = this.compactionSettingsForCommand(cmd);
    await Promise.all(
      [...this.missions.values()].map(async (mission) => {
        const appSessionId = mission.summary.id;
        try {
          await this.applyCompactionSettingsToMission(mission, settings, defaults);
          await this.refreshContext(appSessionId, mission.session);
          await Promise.all(
            [...mission.agents.values()].map((agent) =>
              this.refreshContext(agent.session.sessionId, agent.session),
            ),
          );
        } catch (err) {
          this.emitError({
            missionId: appSessionId,
            message: `Could not update live compaction settings: ${errMsg(err)}`,
            recoverable: true,
          });
        }
      }),
    );
  }

  private compactionSettingsForCommand(settings?: CompactionSettingsPatch): CompactionSettings {
    if (hasCompactionSettingsPatch(settings)) {
      const next: CompactionSettings = { ...this.currentCompactionSettings };
      if (settings.compactionTokenLimit === 'factory-default') {
        delete next.compactionTokenLimit;
      } else if (settings.compactionTokenLimit !== undefined) {
        next.compactionTokenLimit = settings.compactionTokenLimit;
      }
      if (settings.compactionTokenLimitPerModel !== undefined)
        next.compactionTokenLimitPerModel = { ...settings.compactionTokenLimitPerModel };
      this.currentCompactionSettings = next;
    }
    return this.currentCompactionSettings;
  }

  private async applyCompactionSettingsToMission(
    mission: Mission,
    settings: CompactionSettings,
    defaults: FactoryDefaultSettings,
  ): Promise<void> {
    await this.applyDaemonCompactionSettings(
      mission.session,
      this.compactionModelIdForSummary(mission.summary, defaults),
      settings,
      defaults,
    );
    for (const [agentSessionId, agent] of mission.agents) {
      const modelId = this.modelIdForAgent(mission, agentSessionId, agent.role, defaults);
      await this.applyDaemonCompactionSettings(agent.session, modelId, settings, defaults);
    }
  }

  private async startLocalMcpServers(ref: {
    id: string;
  }): Promise<{ servers: SdkMcpServer[]; configs: Awaited<ReturnType<SdkMcpServer['start']>>[] }> {
    const servers = [createBrowserMcpServer(this.browsers, () => ref.id)];
    const configs: Awaited<ReturnType<SdkMcpServer['start']>>[] = [];
    try {
      for (const server of servers) configs.push(await server.start());
      return { servers, configs };
    } catch (err) {
      await Promise.all(servers.map((server) => server.close().catch(() => {})));
      throw err;
    }
  }

  private maxContextTokensForModel(modelId?: string): number | undefined {
    if (!modelId) return undefined;
    return this.cachedModels?.find((model) => model.id === modelId)?.maxContextTokens;
  }

  private visibleContextLimitForModel(
    modelId: string | undefined,
    defaults: Partial<FactoryDefaultSettings> = {},
    fallback?: number,
  ): number | undefined {
    const modelMax = this.maxContextTokensForModel(modelId);
    const configured = clampCompactionTokenLimit(
      compactionTokenLimitForModel(modelId, this.currentCompactionSettings, defaults),
      modelMax,
    );
    if (configured !== undefined) return configured;
    if (this.compactionLimitClearedForModel(modelId, defaults)) return modelMax;
    return fallback ?? modelMax;
  }

  private visibleContextLimitForSummary(
    summary: MissionSummary,
    defaults: Partial<FactoryDefaultSettings> = {},
    fallback?: number,
  ): number | undefined {
    return this.visibleContextLimitForModel(
      this.compactionModelIdForSummary(summary, defaults),
      defaults,
      fallback,
    );
  }

  private compactionLimitClearedForModel(
    modelId: string | undefined,
    defaults: Partial<FactoryDefaultSettings> = {},
  ): boolean {
    const perModel = this.currentCompactionSettings.compactionTokenLimitPerModel;
    if (modelId && normalizeCompactionTokenLimit(perModel?.[modelId]) !== undefined) return false;
    const globalLimit = this.currentCompactionSettings.compactionTokenLimit;
    if (normalizeCompactionTokenLimit(globalLimit) !== undefined) return false;
    if (globalLimit === null) return true;
    if (perModel === undefined) return false;
    return normalizeCompactionTokenLimit(defaults.compactionTokenLimit) === undefined;
  }

  private modelIdForAgent(
    mission: Mission,
    agentSessionId: string,
    role: AgentRole,
    defaults: Partial<FactoryDefaultSettings> = {},
  ): string | undefined {
    const configured = mission.subagentSettings.get(agentSessionId)?.modelId;
    if (configured) return configured;
    if (role === 'worker')
      return (
        mission.summary.workerModelId ??
        defaultModelForAgent('worker', modeForSummary(mission.summary), defaults) ??
        this.compactionModelIdForSummary(mission.summary, defaults)
      );
    if (role === 'validator')
      return (
        mission.summary.validatorModelId ??
        defaultModelForAgent('validator', modeForSummary(mission.summary), defaults) ??
        this.compactionModelIdForSummary(mission.summary, defaults)
      );
    return this.compactionModelIdForSummary(mission.summary, defaults);
  }

  private visibleContextLimitForAgent(
    mission: Mission,
    agent: LiveAgent,
    defaults: Partial<FactoryDefaultSettings> = {},
  ): number | undefined {
    return this.visibleContextLimitForModel(
      this.modelIdForAgent(mission, agent.session.sessionId, agent.role, defaults),
      defaults,
    );
  }

  private async updateAgentSettings(
    cmd: Extract<ClientCommand, { type: 'settings.agent.update' }>,
  ): Promise<void> {
    try {
      const mission = cmd.missionId ? this.findMission(cmd.missionId) : undefined;
      const summary =
        mission?.summary ?? (cmd.missionId ? this.resolveSummary(cmd.missionId) : undefined);
      if (
        cmd.missionId &&
        cmd.agent !== 'orchestrator' &&
        summary &&
        summary.kind !== 'mission_orchestrator'
      ) {
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
          if (historical)
            this.emit({
              type: 'mission.updated',
              mission: { ...historical, ...patch, updatedAt: Date.now() },
            });
        }
        if (mission && missionId && cmd.agent === 'orchestrator')
          await this.refreshContext(missionId, mission.session);
      }
    } catch (err) {
      this.emitError({
        missionId: cmd.missionId,
        message: `Could not update agent settings: ${errMsg(err)}`,
      });
    }
  }

  private rememberPendingAgentSettings(
    cmd: Extract<ClientCommand, { type: 'settings.agent.update' }>,
  ): void {
    if (!cmd.missionId) return;
    const missionId =
      this.findMission(cmd.missionId)?.summary.id ??
      this.resolveSummary(cmd.missionId)?.id ??
      cmd.missionId;
    const existing = this.pendingAgentSettings.get(missionId) ?? {};
    const agent = { ...(existing[cmd.agent] ?? {}) };
    if (cmd.modelId !== undefined) agent.modelId = cmd.modelId;
    if (cmd.reasoningEffort !== undefined) agent.reasoningEffort = cmd.reasoningEffort;
    this.pendingAgentSettings.set(missionId, { ...existing, [cmd.agent]: agent });
  }

  private summaryPatchForAgent(
    agent: ConfigurableAgent,
    settings: AgentSettingPatch,
  ): Partial<MissionSummary> {
    const patch: Partial<MissionSummary> = {};
    if (agent === 'orchestrator') {
      if (settings.modelId !== undefined) {
        patch.modelId = settings.modelId ?? undefined;
        patch.maxContextTokens = this.maxContextTokensForModel(settings.modelId ?? undefined);
      }
      if (settings.reasoningEffort !== undefined) patch.reasoningEffort = settings.reasoningEffort;
    } else if (agent === 'worker') {
      if (settings.modelId !== undefined) patch.workerModelId = settings.modelId ?? undefined;
      if (settings.reasoningEffort !== undefined)
        patch.workerReasoningEffort = settings.reasoningEffort;
    } else {
      if (settings.modelId !== undefined) patch.validatorModelId = settings.modelId ?? undefined;
      if (settings.reasoningEffort !== undefined)
        patch.validatorReasoningEffort = settings.reasoningEffort;
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

  private async applyAgentSessionSettings(
    mission: Mission,
    agent: ConfigurableAgent,
    settings: AgentSettingPatch,
  ): Promise<void> {
    const next = createSessionSettingsForAgent(agent, settings);
    if (agent === 'orchestrator' && settings.modelId !== undefined) {
      const defaults = await this.getFactoryDefaults();
      const nextModelId =
        settings.modelId ??
        defaultModelForAgent('orchestrator', modeForSummary(mission.summary), defaults);
      Object.assign(
        next,
        createCompactionSettingsForModel(
          nextModelId,
          this.currentCompactionSettings,
          defaults,
          this.maxContextTokensForModel(nextModelId),
        ),
      );
    }
    if (Object.keys(next).length > 0) await mission.session.updateSettings(next as never);
  }

  private async applyDaemonCompactionSettings(
    session: DroidSession,
    modelId: string | undefined,
    settings: CompactionSettings,
    defaults: FactoryDefaultSettings,
  ): Promise<void> {
    await session.updateSettings(
      createCompactionSettingsForModel(
        modelId,
        settings,
        defaults,
        this.maxContextTokensForModel(modelId),
      ) as never,
    );
  }

  private compactionCountForSummary(
    summary: Pick<MissionSummary, 'compactionCount' | 'compactedFromSessionIds'>,
  ): number {
    return Math.max(summary.compactionCount ?? 0, summary.compactedFromSessionIds?.length ?? 0);
  }

  private nextCompactionCountForSummary(
    summary: Pick<MissionSummary, 'compactionCount' | 'compactedFromSessionIds'>,
  ): number {
    return this.compactionCountForSummary(summary) + 1;
  }

  private markMissionCompacted(mission: Mission): number {
    const compactionCount = this.nextCompactionCountForSummary(mission.summary);
    this.patch(mission.summary.id, { compactionCount });
    return compactionCount;
  }

  private async markMissionCompactedAndRefresh(
    mission: Mission,
    compacted?: { sessionId: string; session: DroidSession },
  ): Promise<number> {
    const compactionCount = this.markMissionCompacted(mission);
    try {
      const defaults = await this.getFactoryDefaults();
      await this.applyCompactionSettingsToMission(
        mission,
        this.currentCompactionSettings,
        defaults,
      );
      await this.refreshContext(mission.summary.id, mission.session);
      if (compacted && compacted.session !== mission.session)
        await this.refreshContext(compacted.sessionId, compacted.session);
    } catch (err) {
      this.emitError({
        missionId: mission.summary.id,
        sessionId: mission.summary.sessionId,
        message: `Could not refresh daemon compaction settings after compaction: ${errMsg(err)}`,
        recoverable: true,
      });
    }
    return compactionCount;
  }

  private nextCompactedSessionState(
    summary: Pick<MissionSummary, 'sessionId' | 'compactedFromSessionIds' | 'compactionCount'>,
  ): { compactedFromSessionIds: string[]; compactionCount: number } {
    const compactedFromSessionIds = uniqueStrings([
      ...(summary.compactedFromSessionIds ?? []),
      summary.sessionId,
    ]);
    return {
      compactedFromSessionIds,
      compactionCount: Math.max(
        this.nextCompactionCountForSummary(summary),
        compactedFromSessionIds.length,
      ),
    };
  }

  private compactionModelIdForSummary(
    summary: MissionSummary,
    defaults: Partial<FactoryDefaultSettings>,
  ): string | undefined {
    return (
      summary.modelId ?? defaultModelForAgent('orchestrator', modeForSummary(summary), defaults)
    );
  }

  private subscribeSessionNotifications(
    appSessionId: string,
    agentSessionId: string,
    role: AgentRole,
    session: DroidSession,
    options: { sessionCompactedOnly?: boolean } = {},
  ): () => void {
    return session.onNotification((note: Record<string, unknown>) => {
      const sessionCompacted = isSessionCompactedNotification(note);
      if (options.sessionCompactedOnly && !sessionCompacted) return;
      if (sessionCompacted) this.markDaemonCompacted(appSessionId, agentSessionId, session);
      for (const n of normalizeNotification(appSessionId, agentSessionId, role, note))
        this.applyNormalized(appSessionId, n);
    });
  }

  private markDaemonCompacted(
    appSessionId: string,
    agentSessionId: string,
    session: DroidSession,
  ): void {
    const mission = this.findMission(appSessionId);
    if (!mission || mission.compacting) return;
    const liveAgent = this.findLiveAgent(agentSessionId);
    if (liveAgent?.agent.compacting) return;
    void this.markMissionCompactedAndRefresh(mission, { sessionId: agentSessionId, session });
  }

  private async runtimeAgentSettings(
    mission: Mission,
    agent: ConfigurableAgent,
    settings: AgentSettingPatch,
  ): Promise<AgentSettingPatch> {
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
      for (const [agent, settings] of Object.entries(pending) as [
        ConfigurableAgent,
        AgentSettingPatch,
      ][]) {
        await this.applyAgentSessionSettings(
          mission,
          agent,
          await this.runtimeAgentSettings(mission, agent, settings),
        );
        patch = { ...patch, ...this.summaryPatchForAgent(agent, settings) };
      }
      this.patch(appSessionId, patch);
      return true;
    } catch (err) {
      this.emitError({
        missionId: appSessionId,
        message: `Could not apply selected model before send: ${errMsg(err)}`,
      });
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
    return (
      this.missions.get(id) ??
      [...this.missions.values()].find(
        (mission) =>
          mission.summary.sessionId === id ||
          Boolean(mission.summary.compactedFromSessionIds?.includes(id)),
      )
    );
  }

  private findMissionKey(id: string): string | undefined {
    if (this.missions.has(id)) return id;
    for (const [key, mission] of this.missions) {
      if (mission.summary.sessionId === id || mission.summary.compactedFromSessionIds?.includes(id))
        return key;
    }
    return undefined;
  }

  private findLiveAgent(id: string): { mission: Mission; agent: LiveAgent } | undefined {
    for (const mission of this.missions.values()) {
      const resolvedId = this.resolveAgentSessionId(mission, id);
      const direct = mission.agents.get(resolvedId);
      if (direct) return { mission, agent: direct };
      for (const agent of mission.agents.values()) {
        if (agent.session.sessionId === id) return { mission, agent };
      }
    }
    return undefined;
  }

  private findActiveLiveAgent(
    mission: Mission,
  ): { mission: Mission; agent: LiveAgent } | undefined {
    for (const agent of mission.agents.values()) {
      if (agent.streaming || agent.compacting) return { mission, agent };
    }
    return undefined;
  }

  private resolveAgentSessionId(mission: Mission, agentSessionId: string): string {
    const aliases = mission.agentSessionAliases;
    if (!aliases || aliases.size === 0) return agentSessionId;
    let resolved = agentSessionId;
    const seen = new Set<string>();
    while (!seen.has(resolved)) {
      seen.add(resolved);
      const next = aliases.get(resolved);
      if (!next) return resolved;
      resolved = next;
    }
    return resolved;
  }

  private remapAgentSessionAlias(
    mission: Mission,
    oldSessionId: string,
    newSessionId: string,
  ): void {
    const aliases = mission.agentSessionAliases ?? new Map<string, string>();
    mission.agentSessionAliases = aliases;
    aliases.set(oldSessionId, newSessionId);
    for (const [alias, target] of aliases) {
      if (target === oldSessionId) aliases.set(alias, newSessionId);
    }
  }

  private clearAgentSessionAliases(mission: Mission, sessionId: string): void {
    const aliases = mission.agentSessionAliases;
    if (!aliases) return;
    for (const [alias, target] of aliases) {
      if (alias === sessionId || target === sessionId) aliases.delete(alias);
    }
  }

  private resolveSummary(id: string): MissionSummary | undefined {
    return this.listAllSummaries().find(
      (summary) =>
        summary.id === id ||
        summary.sessionId === id ||
        Boolean(summary.compactedFromSessionIds?.includes(id)),
    );
  }

  private async resumeMission(
    sessionId: string,
    compactionSettings?: CompactionSettingsPatch,
  ): Promise<void> {
    if (!this.ready) this.connect();
    const settings = this.compactionSettingsForCommand(compactionSettings);
    const historical = this.resolveSummary(sessionId);
    const appSessionId = historical?.id ?? sessionId;
    const droidSessionId = historical?.sessionId ?? sessionId;
    const existing = this.findMission(appSessionId);
    if (existing) {
      try {
        const defaults = await this.getFactoryDefaults();
        await this.applyCompactionSettingsToMission(existing, settings, defaults);
      } catch (err) {
        this.emitError({
          missionId: appSessionId,
          message: `Could not refresh daemon compaction settings before resume: ${errMsg(err)}`,
          recoverable: true,
        });
      }
      this.emit({
        type: 'mission.created',
        clientRef: `resume:${appSessionId}`,
        mission: existing.summary,
      });
      void this.refreshContext(existing.summary.id, existing.session);
      return;
    }
    // Key local MCP servers and permission handlers by the stable app session id
    // (not the droid session id, which compaction swaps). This keeps the browser
    // session key consistent across compaction so browser tools keep targeting the
    // visible chat. Mirrors create(), which sets ref.id to the app session id.
    const ref = { id: appSessionId };
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
      const cwd =
        historical?.workspaceKind === 'none'
          ? ''
          : stringValue(init.cwd) || stringValue(init.session?.cwd) || historical?.cwd || '';
      const modelId = init.settings?.modelId ?? historical?.modelId ?? defaults.modelId;
      const summary = this.applyPendingSettingsToSummary({
        id: appSessionId,
        sessionId: droidSessionId,
        compactedFromSessionIds: historical?.compactedFromSessionIds ?? [],
        compactionCount: historical ? this.compactionCountForSummary(historical) : 0,
        missionId: classification.missionId,
        parentSessionId: classification.parentSessionId,
        kind: classification.kind,
        role: classification.role,
        title:
          stringValue(init.session?.title) ||
          stringValue(init.session?.sessionTitle) ||
          historical?.title ||
          `Session ${droidSessionId.slice(0, 8)}`,
        goal: historical?.goal ?? '',
        cwd,
        workspaceKind: cwd ? 'folder' : (historical?.workspaceKind ?? 'none'),
        modelId,
        reasoningEffort:
          (init.settings?.reasoningEffort as ReasoningEffort | undefined) ??
          historical?.reasoningEffort ??
          defaults.reasoningEffort,
        compactionModel:
          init.settings?.compactionModel ??
          historical?.compactionModel ??
          defaults.compactionModel ??
          'current-model',
        workerModelId: historical?.workerModelId ?? defaults.workerModelId,
        workerReasoningEffort: historical?.workerReasoningEffort ?? defaults.workerReasoningEffort,
        validatorModelId: historical?.validatorModelId ?? defaults.validatorModelId,
        validatorReasoningEffort:
          historical?.validatorReasoningEffort ?? defaults.validatorReasoningEffort,
        autonomy:
          (init.settings?.autonomyLevel as Autonomy | undefined) ??
          historical?.autonomy ??
          defaults.autonomy ??
          'low',
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
      await this.applyDaemonCompactionSettings(session, summary.modelId, settings, defaults);
      const mission: Mission = this.createLiveMission(summary, session, mcp.servers, mcp.configs);
      // Seed the spawn->worker links persisted for this mission so historical
      // subagents are recognized (and thus openable/steerable) after a resume,
      // even before any live spawn re-populates knownSubagents.
      for (const link of this.history.subagentLinks(appSessionId)) {
        mission.linkedSubagents.add(link.workerSessionId);
        if (link.toolUseId) mission.subagentToolUseIds.set(link.toolUseId, link.workerSessionId);
      }
      this.missions.set(appSessionId, mission);
      this.history.syncSummaries([summary]);
      this.emit({ type: 'mission.created', clientRef: `resume:${appSessionId}`, mission: summary });
      this.emit({ type: 'session.updated', session: summary });
      if (features.length)
        this.emit({ type: 'mission.features', missionId: appSessionId, features });
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
      if (hiddenDroidSessionIds.has(historical.summary.sessionId ?? historical.summary.id))
        continue;
      const summary = this.applyPendingSettingsToSummary(
        applyCachedSummary(historical.summary, cached),
      );
      map.set(summary.id, summary);
    }
    for (const historical of loadHistoricalMissions(options)) {
      if (hiddenDroidSessionIds.has(historical.summary.sessionId ?? historical.summary.id))
        continue;
      const summary = this.applyPendingSettingsToSummary(
        applyCachedSummary(historical.summary, cached),
      );
      map.set(summary.id, summary);
    }
    for (const live of this.listSummaries())
      map.set(live.id, this.applyPendingSettingsToSummary(live));
    return filterMissionListSummaries(
      [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      options,
    );
  }

  private emitMissionList(options?: MissionListFilterOptions): void {
    this.emit({ type: 'mission.list', missions: this.listAllSummaries(options) });
  }

  // Annotate persisted subagent links with the live run state from the active
  // mission so a renderer reconnect/reload doesn't render a still-running
  // subagent as finished. Historical (non-live) loads leave status undefined,
  // which the renderer treats as completed.
  private withLiveWorkerStatus(
    appSessionId: string,
    links: WorkerHistoryLink[],
  ): WorkerHistoryLink[] {
    const mission = this.findMission(appSessionId);
    if (!mission) return links;
    // A resumed worker that the user has opened is live in mission.agents but is
    // not re-added to knownSubagents (that only happens on a live spawn), so
    // check both; otherwise a history reload would render it as completed.
    return links.map((link) =>
      mission.knownSubagents.has(link.workerSessionId) || mission.agents.has(link.workerSessionId)
        ? {
            ...link,
            status: mission.completedSubagents.has(link.workerSessionId) ? 'completed' : 'running',
          }
        : link,
    );
  }

  private loadMissionHistory(missionId: string, cursor?: string): void {
    const summary = this.resolveSummary(missionId);
    const appSessionId = summary?.id ?? missionId;
    const droidSessionId = summary?.sessionId ?? missionId;
    try {
      const history = this.hydrateMissionHistory(appSessionId, droidSessionId, { cursor });
      const transcripts = history.transcripts.map((event) => ({
        ...event,
        missionId: appSessionId,
      }));
      transcripts.forEach((event) => this.history.recordEvent(event));
      // An older page only extends the orchestrator scrollback upward; prepend it
      // without touching the already-delivered workers/progress.
      if (cursor) {
        this.emit({
          type: 'mission.history',
          missionId: appSessionId,
          progress: [],
          transcripts,
          mode: 'prepend',
          olderCursor: history.olderCursor,
        });
        return;
      }
      const workers = this.withLiveWorkerStatus(
        appSessionId,
        this.history.subagentLinks(appSessionId),
      );
      this.emit({
        type: 'mission.history',
        missionId: appSessionId,
        progress: history.progress,
        transcripts,
        workers,
        mode: 'replace',
        olderCursor: history.olderCursor,
      });
    } catch {
      // No mission directory (plain chat / spec session). These have no workers
      // or progress, but their orchestrator transcript can still span a
      // compaction CHAIN, so replay the full chain - not just the newest backing
      // file - and page it with the same cursor the mission path uses.
      try {
        const chain = resolveSessionChain(appSessionId, droidSessionId);
        if (chain.length === 0) throw new Error(`Session history not found for ${droidSessionId}`);
        const window = loadMissionTranscriptWindow(appSessionId, chain, { cursor });
        const transcripts = window.events.map((event) => ({ ...event, missionId: appSessionId }));
        transcripts.forEach((event) => this.history.recordEvent(event));
        if (cursor) {
          this.emit({
            type: 'mission.history',
            missionId: appSessionId,
            progress: [],
            transcripts,
            mode: 'prepend',
            olderCursor: window.olderCursor,
          });
          return;
        }
        const workers = this.withLiveWorkerStatus(
          appSessionId,
          this.history.subagentLinks(appSessionId),
        );
        this.emit({
          type: 'mission.history',
          missionId: appSessionId,
          progress: [],
          transcripts,
          workers,
          mode: 'replace',
          olderCursor: window.olderCursor,
        });
      } catch (err) {
        // Always answer an older-page request, even on failure, so the client's
        // historyLoadingOlder flag clears instead of sticking and blocking all
        // further pagination.
        if (cursor) {
          this.emit({
            type: 'mission.history',
            missionId: appSessionId,
            progress: [],
            transcripts: [],
            mode: 'prepend',
            olderCursor: undefined,
          });
          return;
        }
        if (!this.findMission(appSessionId)) {
          this.emitError({
            missionId: appSessionId,
            sessionId: droidSessionId,
            message: errMsg(err),
          });
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
      this.emit({
        type: 'mission.history',
        missionId: appSessionId,
        progress: [],
        transcripts: page.events,
      });
    } catch (err) {
      this.emitError({ missionId: appSessionId, sessionId: droidSessionId, message: errMsg(err) });
    }
  }

  private hydrateMissionHistory(
    appSessionId: string,
    droidSessionId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): ReturnType<typeof hydrateHistoricalMission> {
    try {
      return hydrateHistoricalMission(appSessionId, opts);
    } catch {
      return hydrateHistoricalMission(droidSessionId, opts);
    }
  }

  private async createMission(
    cmd: Extract<ClientCommand, { type: 'mission.create' }>,
  ): Promise<void> {
    if (!this.ready) this.connect();
    const appCwd = cmd.cwd ?? '';
    const runtimeCwd = appCwd || homedir();
    const ref = { id: '' };
    let pendingMcpServers: SdkMcpServer[] = [];
    try {
      const defaults = await this.getFactoryDefaults();
      const mode = cmd.interactionMode ?? defaults.interactionMode ?? 'agi';
      const autonomy = createAutonomyForCommand(cmd, defaults);
      const { modelId: orchestratorModelId, reasoningEffort: orchestratorReasoning } =
        createModelDefaultsForMode(mode, cmd, defaults);
      const activeCompactionSettings = this.compactionSettingsForCommand(cmd);
      const compactionModel = cmd.compactionModel ?? defaults.compactionModel ?? 'current-model';
      const compactionSettings = createCompactionSettingsForModel(
        orchestratorModelId,
        activeCompactionSettings,
        defaults,
        this.maxContextTokensForModel(orchestratorModelId),
      );
      const { workerModelId, workerReasoningEffort, validatorModelId, validatorReasoningEffort } =
        createMissionAgentDefaultsForMode(mode, cmd, defaults);
      const mcp = await this.startLocalMcpServers(ref);
      pendingMcpServers = mcp.servers;
      const session = await this.runtime.createSession({
        cwd: runtimeCwd,
        interactionMode: mode,
        modelId: orchestratorModelId,
        autonomyLevel: autonomy,
        reasoningEffort: orchestratorReasoning,
        specModeModelId: mode === 'spec' ? orchestratorModelId : defaults.specModelId,
        specModeReasoningEffort:
          mode === 'spec' ? orchestratorReasoning : defaults.specReasoningEffort,
        decompSessionType: mode === 'agi' ? DecompSessionType.Orchestrator : undefined,
        workerModelId,
        workerReasoningEffort,
        validatorModelId,
        validatorReasoningEffort,
        compactionModel,
        compactionThresholdCheckEnabled: compactionSettings.compactionThresholdCheckEnabled,
        mcpServers: mcp.configs,
        permissionHandler: this.makePermissionHandler(ref),
        askUserHandler: this.makeAskUserHandler(ref),
      });
      await this.applyDaemonCompactionSettings(
        session,
        orchestratorModelId,
        activeCompactionSettings,
        defaults,
      );

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
      const mission = this.createLiveMission(summary, session, mcp.servers, mcp.configs);
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

  private createLiveMission(
    summary: MissionSummary,
    session: DroidSession,
    mcpServers: SdkMcpServer[] = [],
    mcpConfigs: Awaited<ReturnType<SdkMcpServer['start']>>[] = [],
  ): Mission {
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
      linkedSubagents: new Set(),
      subagentToolUseIds: new Map(),
      agentSessionAliases: new Map(),
      subagentSettings: new Map(),
      pendingSubagents: [],
      mcpServers,
      mcpConfigs,
      permissionGrants: new Set(),
      unsubscribe: this.subscribeSessionNotifications(
        summary.id,
        summary.id,
        'orchestrator',
        session,
        { sessionCompactedOnly: true },
      ),
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
          mission.pendingPermissions.set(requestId, {
            resolve,
            kind: request.kind,
            signature: signature || undefined,
          });
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

  private async resolvePermission(
    missionId: string,
    requestId: string,
    outcome: string,
    compactionSettings?: CompactionSettingsPatch,
  ): Promise<void> {
    const mission = this.findMission(missionId);
    const pending = mission?.pendingPermissions.get(requestId);
    if (!mission || !pending) return;
    mission.pendingPermissions.delete(requestId);
    await this.applySendCompactionSettings(mission, compactionSettings);
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
    if (pending.kind === 'spec' && isApprovalOutcome(normalized))
      await this.prepareSpecExitForRun(mission);
    pending.resolve(normalized);
  }

  private async prepareSpecExitForRun(mission: Mission): Promise<void> {
    const appSessionId = mission.summary.id;
    this.patch(appSessionId, { kind: 'chat', phase: 'running' });
    try {
      await mission.session.updateSettings({ interactionMode: DroidInteractionMode.Auto } as never);
    } catch (err) {
      this.emitError({
        code: 'spec.exit_failed',
        missionId: appSessionId,
        message: `Could not switch spec session to Auto before run: ${errMsg(err)}`,
      });
    }
  }

  private async resolveQuestion(
    missionId: string,
    requestId: string,
    cancelled: boolean,
    answers: { index: number; question: string; answer: string }[],
    compactionSettings?: CompactionSettingsPatch,
  ): Promise<void> {
    const mission = this.findMission(missionId);
    const resolver = mission?.pendingQuestions.get(requestId);
    if (!mission || !resolver) return;
    mission.pendingQuestions.delete(requestId);
    await this.applySendCompactionSettings(mission, compactionSettings);
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
    try {
      if (!this.findMission(appSessionId)) return;
      this.startContextPolling(appSessionId, mission.session);
      await this.applyDesignToolPolicy(mission, isDesignPrompt(prompt));
      const stream = mission.session.stream(prompt, { includePartialMessages: true });
      for await (const ev of stream)
        this.applyEvent(appSessionId, appSessionId, 'orchestrator', ev);
    } catch (err) {
      const message = errMsg(err);
      if (message === 'interrupted') {
        const reason =
          mission.interruptingForSteer || mission.pendingSends.length > 0
            ? 'Current turn interrupted for steering.'
            : 'Current turn interrupted.';
        this.emitStatus(appSessionId, reason);
      } else {
        this.emitError({ missionId: appSessionId, message });
        this.patch(appSessionId, { phase: 'failed' });
      }
    } finally {
      if (this.findMission(appSessionId) !== mission) return;
      this.stopContextPolling(appSessionId);
      mission.interruptingForSteer = false;
      await this.refreshContext(appSessionId, mission.session);
      mission.streaming = false;
      const next = mission.pendingSends.shift();
      this.patch(appSessionId, {
        streaming: false,
        queuedSends: mission.pendingSends.length,
        ...(next === undefined && shouldSettleToPaused(mission.summary.phase)
          ? { phase: 'paused' as const }
          : {}),
      });
      if (next !== undefined) void this.drive(appSessionId, next);
    }
  }

  // Re-deliver sends that were queued while a turn streamed, after stale-compaction
  // recovery dropped the live mission. send() re-resumes the mission from the
  // persisted (compacted) backing id; delivering sequentially resumes it once and
  // preserves prompt order rather than racing multiple resumes.
  private async redeliverQueuedSends(missionId: string, queued: string[]): Promise<void> {
    for (const text of queued) {
      try {
        await this.send(missionId, text);
      } catch (err) {
        this.emitError({
          missionId,
          message: `Could not deliver a queued message after compaction recovery: ${errMsg(err)}`,
        });
      }
    }
  }

  // Design turns are a single focused task (extra prompts queue), so the model
  // does not need TodoWrite — it otherwise loops updating the list after it has
  // already answered. Disable TodoWrite for design turns and restore it for
  // normal turns, calling updateSettings only when the policy changes.
  private async applyDesignToolPolicy(mission: Mission, design: boolean): Promise<void> {
    // When the in-memory flag is unset (cold start / page reload) we don't
    // know the session's current disabledToolIds, so always call updateSettings
    // to synchronize. Once the flag is set we skip redundant calls.
    if (mission.todoDisabledForDesign !== undefined && mission.todoDisabledForDesign === design)
      return;
    try {
      await mission.session.updateSettings({ disabledToolIds: design ? ['TodoWrite'] : [] });
      mission.todoDisabledForDesign = design;
    } catch (err) {
      this.emitError({
        missionId: mission.summary.id,
        message: `Could not update design tool policy: ${errMsg(err)}`,
      });
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
    sub: {
      sessionId?: string;
      toolUseId?: string;
      label?: string;
      prompt?: string;
      done?: boolean;
    },
  ): void {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    const sessionId = sub.sessionId;
    if (!sessionId) {
      if (sub.done) {
        if (sub.toolUseId) this.completeSubagentForToolUse(mission, sub.toolUseId);
      } else if (sub.toolUseId || sub.label || sub.prompt) {
        mission.pendingSubagents.push({
          toolUseId: sub.toolUseId,
          label: sub.label,
          prompt: sub.prompt,
        });
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
    if (toolUseId) {
      mission.subagentToolUseIds.set(toolUseId, sessionId);
      this.history.recordSubagentLink(appSessionId, toolUseId, sessionId, label);
    }
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
    this.emit({
      type: 'agent.updated',
      missionId: appSessionId,
      agentSessionId: sessionId,
      role: 'worker',
      status: 'running',
    });
    void this.openAgent(appSessionId, sessionId, 'worker', 'running', false);
  }

  private takePendingSubagent(mission: Mission, sub: PendingSubagent): PendingSubagent | undefined {
    if (mission.pendingSubagents.length === 0) return undefined;
    if (sub.toolUseId) {
      const index = mission.pendingSubagents.findIndex(
        (pending) => pending.toolUseId === sub.toolUseId,
      );
      if (index >= 0) return mission.pendingSubagents.splice(index, 1)[0];
    }
    const label = sub.label?.toLowerCase();
    if (label) {
      const index = mission.pendingSubagents.findIndex(
        (pending) => pending.label?.toLowerCase() === label,
      );
      if (index >= 0) return mission.pendingSubagents.splice(index, 1)[0];
    }
    return mission.pendingSubagents.shift();
  }

  private completeSubagentForToolUse(mission: Mission, toolUseId: string): void {
    const sessionId = mission.subagentToolUseIds.get(toolUseId);
    if (sessionId) this.completeSubagent(mission, sessionId);
  }

  private completeSubagent(mission: Mission, sessionId: string): void {
    const resolvedSessionId = this.resolveAgentSessionId(mission, sessionId);
    if (
      !mission.knownSubagents.has(resolvedSessionId) ||
      mission.completedSubagents.has(resolvedSessionId)
    )
      return;
    const appSessionId = mission.summary.id;
    mission.completedSubagents.add(resolvedSessionId);
    const settings = mission.subagentSettings.get(resolvedSessionId) ?? {};
    this.emit({
      type: 'mission.worker',
      missionId: appSessionId,
      event: 'completed',
      workerSessionId: resolvedSessionId,
      ...settings,
    });
    this.emit({
      type: 'agent.updated',
      missionId: appSessionId,
      agentSessionId: sessionId,
      role: 'worker',
      status: 'completed',
    });
    void this.closeAgentWhenIdle(appSessionId, sessionId);
  }

  private applyNormalized(
    missionId: string,
    n: NonNullable<ReturnType<typeof normalizeStreamEvent>>,
  ): void {
    if (n.transcript) this.emitTranscript(n.transcript);
    if (n.features) {
      this.patch(missionId, { features: n.features });
      this.emit({ type: 'mission.features', missionId, features: n.features });
    }
    if (n.progress) this.emit({ type: 'mission.progress', missionId, entries: n.progress });
    if (n.missionState) {
      const phase = STATE_TO_PHASE[n.missionState];
      const mission = this.findMission(missionId);
      if (phase && !(mission?.streaming && phase === 'paused')) this.patch(missionId, { phase });
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
      if (n.worker.event === 'completed')
        void this.closeAgentWhenIdle(missionId, n.worker.workerSessionId);
    }
    if (n.subagent) this.applySubagent(missionId, n.subagent);
    if (n.tokens) {
      const m = this.findMission(missionId);
      if (m) {
        const appSessionId = m.summary.id;
        const offset = this.usageOffsets.get(appSessionId);
        m.summary.tokensIn = n.tokens.tokensIn + (offset?.tokensIn ?? 0);
        m.summary.tokensOut = n.tokens.tokensOut + (offset?.tokensOut ?? 0);
        const snapshot = this.contextSnapshots.get(appSessionId);
        const maxContextTokens = this.visibleContextLimitForSummary(
          m.summary,
          this.cachedFactoryDefaults,
          snapshot?.limit ?? m.summary.maxContextTokens,
        );
        if (maxContextTokens === undefined) delete m.summary.maxContextTokens;
        else m.summary.maxContextTokens = maxContextTokens;
        const contextLimit = maxContextTokens ?? snapshot?.limit;
        if (isWindowTokenCount(n.tokens.contextTokens, contextLimit)) {
          m.summary.contextTokens = n.tokens.contextTokens;
          this.emitContextEstimate(appSessionId, m.summary);
        } else if (!isWindowTokenCount(m.summary.contextTokens, contextLimit)) {
          const snapshotUsed = snapshot?.used;
          m.summary.contextTokens = isWindowTokenCount(
            snapshotUsed,
            snapshot?.limit ?? maxContextTokens,
          )
            ? snapshotUsed
            : 0;
        }
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
      id: `status-${Date.now().toString(36)}-${(this.statusSeq++).toString(36)}`,
      missionId,
      agentSessionId: agentSessionId ?? missionId,
      role,
      ts: Date.now(),
      kind: 'status',
      text,
      compactType,
    });
  }

  private async compactSession(
    sessionId: string,
    customInstructions?: string,
    compactType: CompactType = 'manual',
  ): Promise<void> {
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
  private async compactMission(
    mission: Mission,
    customInstructions: string | undefined,
    compactType: CompactType,
  ): Promise<void> {
    const appSessionId = mission.summary.id;
    const carryover: UsageOffset = {
      tokensIn: mission.summary.tokensIn ?? 0,
      tokensOut: mission.summary.tokensOut ?? 0,
    };
    mission.compacting = true;
    // Remembers the daemon's new backing id so a reload failure can be recovered
    // after runCompaction returns 'stale' (the hook sets it before adopting).
    let swapTarget: string | undefined;
    try {
      const outcome = await runCompaction(
        mission.session,
        {
          status: (text, ct) => this.emitStatus(appSessionId, text, ct),
          error: (message) =>
            this.emitError({
              sessionId: mission.summary.sessionId,
              missionId: appSessionId,
              message: `Could not compact session: ${message}`,
              recoverable: true,
            }),
          refresh: () => this.refreshContext(appSessionId, mission.session),
          reload: async (newSessionId) => {
            swapTarget = newSessionId;
            await this.swapMissionSession(mission, newSessionId, carryover);
          },
        },
        { customInstructions, compactType },
      );
      // The daemon swapped to a new backing id but adopting it threw, so
      // mission.session still points at the swapped-away (now-dead) old id.
      // Recover before later sends stream into that stale session.
      if (outcome === 'stale' && swapTarget) {
        await this.recoverStaleMissionSwap(mission, swapTarget, carryover);
      } else if (outcome === 'completed' && !swapTarget) {
        await this.markMissionCompactedAndRefresh(mission);
      }
    } finally {
      mission.compacting = false;
    }
  }

  // Adopt the daemon's compacted backing session behind the stable app id:
  // load the new id, swap it in, retire the old session, and persist the new id
  // with carried-over usage. Throws if the new session cannot be loaded.
  private async swapMissionSession(
    mission: Mission,
    newSessionId: string,
    carryover: UsageOffset,
  ): Promise<void> {
    const appSessionId = mission.summary.id;
    const compactedState = this.nextCompactedSessionState(mission.summary);
    const ref = { id: appSessionId };
    const oldSession = mission.session;
    const newSession = await this.runtime.loadSession(newSessionId, {
      permissionHandler: this.makePermissionHandler(ref),
      askUserHandler: this.makeAskUserHandler(ref),
      // Re-attach the same local MCP servers (still running) so the swapped
      // session keeps browser tools on subsequent turns.
      mcpServers: mission.mcpConfigs,
    });
    const previousUnsubscribe = mission.unsubscribe;
    mission.session = newSession;
    mission.unsubscribe = this.subscribeSessionNotifications(
      appSessionId,
      appSessionId,
      'orchestrator',
      mission.session,
      { sessionCompactedOnly: true },
    );
    previousUnsubscribe?.();
    try {
      const defaults = await this.getFactoryDefaults();
      await this.applyDaemonCompactionSettings(
        mission.session,
        this.compactionModelIdForSummary(mission.summary, defaults),
        this.currentCompactionSettings,
        defaults,
      );
    } catch (err) {
      this.emitError({
        missionId: appSessionId,
        sessionId: newSessionId,
        message: `Could not refresh daemon compaction settings after compaction: ${errMsg(err)}`,
        recoverable: true,
      });
    }
    // The replacement session starts with default tool settings, so the cached
    // design-tool policy no longer reflects reality. Clear it so the next turn
    // re-synchronizes disabledToolIds.
    mission.todoDisabledForDesign = undefined;
    await oldSession.close().catch(() => {});
    this.usageOffsets.set(appSessionId, carryover);
    this.patch(appSessionId, {
      sessionId: newSessionId,
      ...compactedState,
      tokensIn: carryover.tokensIn,
      tokensOut: carryover.tokensOut,
      contextTokens: 0,
    });
  }

  // Recovery for an orchestrator compaction that swapped backing sessions but
  // failed to adopt the new one (mission.session is now a dead id). Retry the
  // adoption once for a transient failure; if it still fails, persist the new
  // id and drop the live mission so the next send re-resumes against the live
  // (compacted) session instead of streaming into the dead one.
  private async recoverStaleMissionSwap(
    mission: Mission,
    newSessionId: string,
    carryover: UsageOffset,
  ): Promise<void> {
    const appSessionId = mission.summary.id;
    try {
      await this.swapMissionSession(mission, newSessionId, carryover);
      return;
    } catch {
      /* adoption still failing; persist the new id and drop the mission below */
    }
    const compactedState = this.nextCompactedSessionState(mission.summary);
    this.patch(appSessionId, {
      sessionId: newSessionId,
      ...compactedState,
      tokensIn: carryover.tokensIn,
      tokensOut: carryover.tokensOut,
      contextTokens: 0,
    });
    await this.closeMission(appSessionId);
    // closeMission clears the usage offset for this app id, so seed it AFTER the
    // teardown: when the next message re-resumes against the compacted backing
    // session (whose token counts restart low), the carried-over totals are
    // added back instead of the displayed usage collapsing to the new segment.
    this.usageOffsets.set(appSessionId, carryover);
    this.emitError({
      missionId: appSessionId,
      sessionId: newSessionId,
      message:
        'Compaction moved this conversation to a new session but reloading it failed; it will reload on your next message.',
      recoverable: true,
    });
  }

  // Compacting a session that is not currently loaded (e.g. from the sidebar
  // history). There is no live session to refresh; the swapped backing id is
  // persisted to history so the next resume continues from the compacted state.
  private async compactHistoricalSession(
    sessionId: string,
    customInstructions?: string,
  ): Promise<void> {
    const historical = this.resolveSummary(sessionId);
    const oldDroidSessionId = historical?.sessionId ?? sessionId;
    try {
      const result = await this.withSession(sessionId, (session) =>
        session.compactSession(customInstructions ? { customInstructions } : {}),
      );
      if (!result) return;
      const newSessionId = result.newSessionId || oldDroidSessionId;
      if (historical) {
        const compactionCount = this.nextCompactionCountForSummary(historical);
        const compactedFromSessionIds =
          newSessionId !== oldDroidSessionId
            ? uniqueStrings([...(historical.compactedFromSessionIds ?? []), oldDroidSessionId])
            : historical.compactedFromSessionIds;
        const updated = {
          ...historical,
          sessionId: newSessionId,
          compactedFromSessionIds,
          compactionCount,
          updatedAt: Date.now(),
        };
        this.history.syncSummaries([updated]);
        this.emit({ type: 'mission.updated', mission: updated });
        this.emit({ type: 'session.updated', session: updated });
      }
    } catch (err) {
      this.emitError({
        sessionId: oldDroidSessionId,
        missionId: historical?.id ?? sessionId,
        message: `Could not compact session: ${errMsg(err)}`,
      });
    }
  }

  private async send(
    missionId: string,
    text: string,
    compactionSettings?: CompactionSettingsPatch,
  ): Promise<void> {
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
    await this.applySendCompactionSettings(mission, compactionSettings);
    if (mission.streaming || mission.compacting) {
      mission.pendingSends.push(text);
      this.patch(appSessionId, { queuedSends: mission.pendingSends.length });
      return;
    }
    await this.drive(appSessionId, text);
  }

  private async sendNow(
    missionId: string,
    text: string,
    compactionSettings?: CompactionSettingsPatch,
  ): Promise<void> {
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
    await this.applySendCompactionSettings(mission, compactionSettings);
    if (!mission.streaming && !mission.compacting) {
      await this.drive(appSessionId, text);
      return;
    }
    // Run next after the in-flight turn/compaction; never interrupt a compaction
    // (driving or interrupting against it risks a failed compaction or lost steering).
    mission.pendingSends.unshift(text);
    this.patch(appSessionId, { queuedSends: mission.pendingSends.length });
    if (mission.compacting) return;
    mission.interruptingForSteer = true;
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

  private async applySendCompactionSettings(
    mission: Mission,
    settings?: CompactionSettingsPatch,
  ): Promise<void> {
    const effective = this.compactionSettingsForCommand(settings);
    if (!hasCompactionSettingsPatch(effective)) return;
    try {
      const defaults = await this.getFactoryDefaults();
      await this.applyCompactionSettingsToMission(mission, effective, defaults);
    } catch (err) {
      this.emitError({
        missionId: mission.summary.id,
        message: `Could not update live compaction settings: ${errMsg(err)}`,
        recoverable: true,
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
      this.emitError({
        missionId: appSessionId,
        message: `Unsupported autonomy level: ${autonomy}`,
      });
      return;
    }
    try {
      await mission.session.updateSettings({ autonomyLevel: nextAutonomy } as never);
      this.patch(appSessionId, { autonomy: nextAutonomy });
    } catch (err) {
      this.emitError({
        missionId: appSessionId,
        message: `Could not change autonomy: ${errMsg(err)}`,
      });
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
      this.emitError({
        missionId: appSessionId,
        message: `Could not switch interaction mode: ${errMsg(err)}`,
      });
    }
  }

  private async updateSessionSettings(
    sessionId: string,
    settings: {
      modelId?: string | null;
      reasoningEffort?: ReasoningEffort;
      autonomy?: Autonomy | 'none';
    },
  ): Promise<void> {
    const mission = this.findMission(sessionId);
    const historical = this.resolveSummary(sessionId);
    const appSessionId = mission?.summary.id ?? historical?.id ?? sessionId;
    const patch: Partial<MissionSummary> = {};
    const next: Record<string, unknown> = {};
    if (settings.modelId !== undefined) {
      const defaults = await this.getFactoryDefaults();
      const summary = mission?.summary ?? historical;
      const nextModelId =
        settings.modelId ??
        (summary
          ? defaultModelForAgent('orchestrator', modeForSummary(summary), defaults)
          : defaults.modelId);
      if (nextModelId) next.modelId = nextModelId;
      patch.modelId = settings.modelId ?? undefined;
      patch.maxContextTokens = this.maxContextTokensForModel(nextModelId);
      Object.assign(
        next,
        createCompactionSettingsForModel(
          nextModelId,
          this.currentCompactionSettings,
          defaults,
          this.maxContextTokensForModel(nextModelId),
        ),
      );
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
    // Never interrupt an in-flight compaction (it risks a failed/corrupt
    // compaction). Dropping queued sends is enough; compaction finishes on its
    // own and its drive()/command drain then settles streaming/phase.
    if (mission.compacting) {
      this.patch(appSessionId, { queuedSends: 0 });
      return;
    }
    await mission.session.interrupt();
    this.patch(appSessionId, { phase: 'paused', streaming: false, queuedSends: 0 });
  }

  private async openAgent(
    missionId: string,
    agentSessionId: string,
    role: AgentRole,
    status: 'opened' | 'running' = 'opened',
    emitHistory = true,
  ): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    const resolvedAgentSessionId = this.resolveAgentSessionId(mission, agentSessionId);
    if (!this.agentBelongsToMission(mission, resolvedAgentSessionId)) return;
    if (mission.agents.has(resolvedAgentSessionId)) {
      const agent = mission.agents.get(resolvedAgentSessionId);
      if (agent) agent.lastUsedAt = Date.now();
      this.emit({
        type: 'agent.updated',
        missionId: appSessionId,
        agentSessionId: resolvedAgentSessionId,
        role,
        status,
      });
      return;
    }
    try {
      if (!(await this.ensureAgentCapacity(mission, resolvedAgentSessionId))) return;
      const ref = { id: appSessionId };
      const session = await this.runtime.loadSession(resolvedAgentSessionId, {
        permissionHandler: this.makePermissionHandler(ref),
        askUserHandler: this.makeAskUserHandler(ref),
      });
      const actualSettings = subagentSettingsFromInit(session.initResult as InitResultLike);
      // For a chat/spec subagent, fall back to the session's model when the
      // droid inherits it. Mission Control workers/validators keep their own
      // configured model selection untouched.
      const inheritsSessionModel =
        mission.summary.kind === 'chat' || mission.summary.kind === 'spec';
      const resolvedSettings: SubagentSettings = inheritsSessionModel
        ? {
            modelId: actualSettings.modelId ?? mission.summary.modelId,
            reasoningEffort: actualSettings.reasoningEffort ?? mission.summary.reasoningEffort,
          }
        : actualSettings;
      if (resolvedSettings.modelId || resolvedSettings.reasoningEffort) {
        mission.subagentSettings.set(resolvedAgentSessionId, resolvedSettings);
        this.emit({
          type: 'mission.worker',
          missionId: appSessionId,
          event: 'updated',
          workerSessionId: resolvedAgentSessionId,
          ...resolvedSettings,
        });
      }
      const defaults = await this.getFactoryDefaults();
      const workerModelId = this.modelIdForAgent(mission, resolvedAgentSessionId, role, defaults);
      await this.applyDaemonCompactionSettings(
        session,
        workerModelId,
        this.currentCompactionSettings,
        defaults,
      );
      const agent: LiveAgent = {
        session,
        missionId: appSessionId,
        role,
        streaming: false,
        pendingSends: [],
        lastUsedAt: Date.now(),
      };
      agent.unsubscribe = this.subscribeSessionNotifications(
        appSessionId,
        resolvedAgentSessionId,
        role,
        session,
      );
      mission.agents.set(resolvedAgentSessionId, agent);
      if (emitHistory) this.emitAgentHistory(appSessionId, resolvedAgentSessionId);
      this.emit({
        type: 'agent.updated',
        missionId: appSessionId,
        agentSessionId: resolvedAgentSessionId,
        role,
        status,
      });
    } catch (err) {
      this.emit({
        type: 'error',
        code: 'agent.open_failed',
        missionId: appSessionId,
        sessionId: resolvedAgentSessionId,
        message: errMsg(err),
      });
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

  private async sendAgent(
    missionId: string,
    agentSessionId: string,
    text: string,
    compactionSettings?: CompactionSettingsPatch,
  ): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    const resolvedAgentSessionId = this.resolveAgentSessionId(mission, agentSessionId);
    if (!this.agentBelongsToMission(mission, resolvedAgentSessionId)) return;
    if (!mission.agents.has(resolvedAgentSessionId))
      await this.openAgent(appSessionId, resolvedAgentSessionId, 'worker');
    const agent = mission.agents.get(resolvedAgentSessionId);
    if (!agent) return;
    await this.applySendCompactionSettings(mission, compactionSettings);
    agent.lastUsedAt = Date.now();
    if (agent.streaming || agent.compacting) {
      agent.pendingSends.push(text);
      return;
    }
    await this.driveAgent(agent, text);
  }

  private async driveAgent(agent: LiveAgent, text: string): Promise<void> {
    agent.streaming = true;
    agent.lastUsedAt = Date.now();
    this.emit({
      type: 'agent.updated',
      missionId: agent.missionId,
      agentSessionId: agent.session.sessionId,
      role: agent.role,
      status: 'running',
    });
    try {
      if (!this.findLiveAgent(agent.session.sessionId)) return;
      this.startContextPolling(agent.session.sessionId, agent.session);
      const stream = agent.session.stream(text, { includePartialMessages: true });
      for await (const ev of stream)
        this.applyEvent(agent.missionId, agent.session.sessionId, agent.role, ev);
    } catch (err) {
      const message = errMsg(err);
      if (message === 'interrupted') {
        const reason =
          agent.interruptingForSteer || agent.pendingSends.length > 0
            ? 'Subagent turn interrupted for steering.'
            : 'Subagent turn interrupted.';
        this.emitStatus(agent.missionId, reason);
      } else {
        this.emit({
          type: 'agent.not_steerable',
          missionId: agent.missionId,
          agentSessionId: agent.session.sessionId,
          message,
        });
        this.emit({
          type: 'error',
          code: 'agent.not_steerable',
          missionId: agent.missionId,
          sessionId: agent.session.sessionId,
          message,
        });
      }
    } finally {
      this.stopContextPolling(agent.session.sessionId);
      agent.interruptingForSteer = false;
      agent.compacting = false;
      if (this.findLiveAgent(agent.session.sessionId)?.agent !== agent) return;
      if (agent.pendingSends.length === 0 && agent.closeWhenIdle) {
        agent.streaming = false;
        await this.closeAgent(agent.missionId, agent.session.sessionId);
      } else {
        // Refresh while streaming stays true so concurrent sends queue instead of
        // racing a second driveAgent().
        await this.refreshContext(agent.session.sessionId, agent.session);
        agent.streaming = false;
        const next = agent.pendingSends.shift();
        if (next !== undefined) void this.driveAgent(agent, next);
        else
          this.emit({
            type: 'agent.updated',
            missionId: agent.missionId,
            agentSessionId: agent.session.sessionId,
            role: agent.role,
            status: 'paused',
          });
      }
    }
  }

  private async compactLiveAgent(
    mission: Mission,
    agent: LiveAgent,
    customInstructions?: string,
  ): Promise<void> {
    agent.compacting = true;
    try {
      await this.compactAgent(mission, agent, undefined, 'manual', customInstructions);
    } finally {
      agent.compacting = false;
    }
    if (this.findLiveAgent(agent.session.sessionId)?.agent !== agent) return;
    const next = agent.pendingSends.shift();
    if (next !== undefined) void this.driveAgent(agent, next);
    else
      this.emit({
        type: 'agent.updated',
        missionId: agent.missionId,
        agentSessionId: agent.session.sessionId,
        role: agent.role,
        status: 'paused',
      });
  }

  private async compactAgent(
    mission: Mission,
    agent: LiveAgent,
    text?: string,
    compactType: CompactType = 'auto',
    customInstructions?: string,
  ): Promise<boolean> {
    const appSessionId = mission.summary.id;
    let swapTarget: string | undefined;
    const outcome = await runCompaction(
      agent.session,
      {
        status: (text, ct) =>
          this.emitStatus(appSessionId, text, ct, agent.session.sessionId, agent.role),
        error: (message) =>
          this.emitError({
            missionId: appSessionId,
            sessionId: agent.session.sessionId,
            message: `Could not compact worker session: ${message}`,
            recoverable: true,
          }),
        refresh: () => this.refreshContext(agent.session.sessionId, agent.session),
        reload: async (newSessionId) => {
          swapTarget = newSessionId;
          await this.swapAgentSession(mission, agent, newSessionId);
        },
      },
      { customInstructions, compactType },
    );
    if (outcome === 'stale' && swapTarget) {
      try {
        await this.swapAgentSession(mission, agent, swapTarget);
      } catch (err) {
        const oldSessionId = agent.session.sessionId;
        const queued = agent.pendingSends.splice(0);
        this.emitError({
          missionId: appSessionId,
          sessionId: agent.session.sessionId,
          message: `Compaction moved this worker to a new session but reloading it failed: ${errMsg(err)}`,
          recoverable: true,
        });
        mission.agents.delete(oldSessionId);
        this.stopContextPolling(oldSessionId);
        agent.unsubscribe?.();
        // Publish the alias before awaiting close so concurrent sends cannot
        // reopen the compacted-away worker id.
        this.rekeyAgentSessionReferences(mission, oldSessionId, swapTarget);
        try {
          await agent.session.close();
        } catch {
          /* stale transport close errors are non-fatal during recovery */
        }
        await this.recoverAgentAndRedeliverSends(
          mission,
          agent.role,
          swapTarget,
          text === undefined ? queued : [text, ...queued],
        );
        return false;
      }
    }
    if (outcome === 'completed' || (outcome === 'stale' && swapTarget))
      await this.markMissionCompactedAndRefresh(mission, {
        sessionId: agent.session.sessionId,
        session: agent.session,
      });
    return outcome !== 'stale' || !!swapTarget;
  }

  private async swapAgentSession(
    mission: Mission,
    agent: LiveAgent,
    newSessionId: string,
  ): Promise<void> {
    const appSessionId = mission.summary.id;
    const oldSessionId = agent.session.sessionId;
    const ref = { id: appSessionId };
    const nextSession = await this.runtime.loadSession(newSessionId, {
      permissionHandler: this.makePermissionHandler(ref),
      askUserHandler: this.makeAskUserHandler(ref),
    });
    await agent.session.close().catch(() => {});
    agent.unsubscribe?.();
    agent.session = nextSession;
    agent.unsubscribe = this.subscribeSessionNotifications(
      appSessionId,
      newSessionId,
      agent.role,
      nextSession,
    );
    mission.agents.delete(oldSessionId);
    mission.agents.set(newSessionId, agent);
    this.rekeyAgentSessionReferences(mission, oldSessionId, newSessionId);
  }

  private rekeyAgentSessionReferences(
    mission: Mission,
    oldSessionId: string,
    newSessionId: string,
  ): void {
    const appSessionId = mission.summary.id;
    const labelsByToolUseId = new Map(
      this.history
        .subagentLinks(appSessionId)
        .filter((link) => link.toolUseId)
        .map((link) => [link.toolUseId as string, link.label]),
    );
    this.remapAgentSessionAlias(mission, oldSessionId, newSessionId);
    transferSetKey(mission.knownSubagents, oldSessionId, newSessionId);
    transferSetKey(mission.completedSubagents, oldSessionId, newSessionId);
    transferSetKey(mission.linkedSubagents, oldSessionId, newSessionId);
    transferMapKey(mission.subagentSettings, oldSessionId, newSessionId);
    const relinkedToolUseIds: string[] = [];
    for (const [toolUseId, workerSessionId] of mission.subagentToolUseIds) {
      if (workerSessionId === oldSessionId) {
        mission.subagentToolUseIds.set(toolUseId, newSessionId);
        relinkedToolUseIds.push(toolUseId);
      }
    }
    for (const toolUseId of relinkedToolUseIds) {
      this.history.recordSubagentLink(
        appSessionId,
        toolUseId,
        newSessionId,
        labelsByToolUseId.get(toolUseId),
      );
    }
    const features = remapFeatureWorkerIds(mission.summary.features, oldSessionId, newSessionId);
    if (features) {
      this.patch(appSessionId, { features });
      this.emit({ type: 'mission.features', missionId: appSessionId, features });
    }
    this.emit({
      type: 'mission.worker.rekey',
      missionId: appSessionId,
      oldSessionId,
      newSessionId,
    });
    this.emit({
      type: 'mission.worker',
      missionId: appSessionId,
      event: 'updated',
      workerSessionId: newSessionId,
    });
  }

  private async recoverAgentAndRedeliverSends(
    mission: Mission,
    role: AgentRole,
    agentSessionId: string,
    sends: string[],
  ): Promise<void> {
    const filtered = sends.filter((text) => text.length > 0);
    if (filtered.length === 0) return;
    const appSessionId = mission.summary.id;
    await this.openAgent(appSessionId, agentSessionId, role);
    const resolvedAgentSessionId = this.resolveAgentSessionId(mission, agentSessionId);
    const agent = mission.agents.get(resolvedAgentSessionId);
    if (!agent) return;
    await this.markMissionCompactedAndRefresh(mission, {
      sessionId: agent.session.sessionId,
      session: agent.session,
    });
    for (const prompt of filtered) {
      if (agent.streaming || agent.compacting) agent.pendingSends.push(prompt);
      else await this.driveAgent(agent, prompt);
    }
  }

  private async sendAgentNow(
    missionId: string,
    agentSessionId: string,
    text: string,
    compactionSettings?: CompactionSettingsPatch,
  ): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    const resolvedAgentSessionId = this.resolveAgentSessionId(mission, agentSessionId);
    if (!this.agentBelongsToMission(mission, resolvedAgentSessionId)) return;
    if (!mission.agents.has(resolvedAgentSessionId))
      await this.openAgent(appSessionId, resolvedAgentSessionId, 'worker');
    const agent = mission.agents.get(resolvedAgentSessionId);
    if (!agent) return;
    await this.applySendCompactionSettings(mission, compactionSettings);
    agent.lastUsedAt = Date.now();
    if (!agent.streaming && !agent.compacting) {
      await this.driveAgent(agent, text);
      return;
    }
    // Run next after the in-flight turn.
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
        sessionId: resolvedAgentSessionId,
        message: `Could not interrupt subagent for steering: ${errMsg(err)}`,
      });
    }
  }

  private async interruptAgent(missionId: string, agentSessionId: string): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    const resolvedAgentSessionId = this.resolveAgentSessionId(mission, agentSessionId);
    if (!this.agentBelongsToMission(mission, resolvedAgentSessionId)) return;
    if (!mission.agents.has(resolvedAgentSessionId))
      await this.openAgent(appSessionId, resolvedAgentSessionId, 'worker');
    const agent = mission.agents.get(resolvedAgentSessionId);
    if (!agent) return;
    agent.pendingSends = [];
    agent.lastUsedAt = Date.now();
    if (agent.compacting) return;
    await agent.session.interrupt();
    agent.streaming = false;
    this.emit({
      type: 'agent.updated',
      missionId: appSessionId,
      agentSessionId: resolvedAgentSessionId,
      role: agent.role,
      status: 'paused',
    });
  }

  private agentBelongsToMission(mission: Mission, agentSessionId: string): boolean {
    const resolvedAgentSessionId = this.resolveAgentSessionId(mission, agentSessionId);
    if (mission.summary.kind === 'mission_orchestrator') return true;
    if (mission.knownSubagents.has(resolvedAgentSessionId)) return true;
    if (mission.linkedSubagents.has(resolvedAgentSessionId)) return true;
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

  private async ensureAgentCapacity(
    mission: Mission,
    requestedAgentSessionId: string,
  ): Promise<boolean> {
    if (mission.agents.size < MAX_OPEN_AGENT_TRANSPORTS) return true;
    const idle = [...mission.agents.entries()]
      .filter(
        ([sessionId, agent]) =>
          sessionId !== requestedAgentSessionId &&
          !agent.streaming &&
          agent.pendingSends.length === 0,
      )
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
    if (!mission) return;
    const resolvedAgentSessionId = this.resolveAgentSessionId(mission, agentSessionId);
    const agent = mission.agents.get(resolvedAgentSessionId);
    if (!agent) return;
    mission.agents.delete(resolvedAgentSessionId);
    this.clearAgentSessionAliases(mission, resolvedAgentSessionId);
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
    if (!mission) return;
    const resolvedAgentSessionId = this.resolveAgentSessionId(mission, agentSessionId);
    const agent = mission.agents.get(resolvedAgentSessionId);
    if (!agent) return;
    agent.closeWhenIdle = true;
    if (!agent.streaming && agent.pendingSends.length === 0)
      await this.closeAgent(missionId, resolvedAgentSessionId);
  }

  private async renameSession(sessionId: string, title: string): Promise<void> {
    await this.withSession(sessionId, (session) => session.renameSession({ title }));
    const appSessionId =
      this.findMission(sessionId)?.summary.id ?? this.resolveSummary(sessionId)?.id;
    if (appSessionId) this.patch(appSessionId, { title });
  }

  private async withSession<T>(
    sessionId: string,
    fn: (session: DroidSession) => Promise<T>,
  ): Promise<T | undefined> {
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

  private async catalogSession(
    sessionId?: string,
  ): Promise<{ session: DroidSession; close: () => Promise<void> }> {
    const first = this.listSummaries()[0];
    const live = sessionId
      ? this.findMission(sessionId)?.session
      : first
        ? this.findMission(first.id)?.session
        : undefined;
    if (live) return { session: live, close: async () => {} };
    const session = await this.runtime.createSession({
      cwd: tmpdir(),
      interactionMode: 'auto',
      autonomyLevel: 'low',
    });
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
      this.emit({
        type: 'catalog.updated',
        catalog: 'skills',
        items: arrayItems(result, 'skills'),
        sessionId: sessionId ?? null,
      });
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
    const limit = this.visibleContextLimitForSummary(
      summary,
      this.cachedFactoryDefaults,
      previous?.limit ?? summary.maxContextTokens,
    );
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

  private async refreshContext(
    sessionId: string,
    session: DroidSession,
    options: { persist?: boolean } = {},
  ): Promise<void> {
    try {
      const mission = this.findMission(sessionId);
      const liveAgent = mission ? undefined : this.findLiveAgent(sessionId);
      const contextSessionId =
        mission?.summary.id ?? liveAgent?.agent.session.sessionId ?? sessionId;
      const defaults =
        mission || liveAgent
          ? await this.getFactoryDefaults().catch(() => ({}) as FactoryDefaultSettings)
          : undefined;
      const visibleLimit = mission
        ? this.visibleContextLimitForSummary(
            mission.summary,
            defaults,
            mission.summary.maxContextTokens,
          )
        : liveAgent
          ? this.visibleContextLimitForAgent(liveAgent.mission, liveAgent.agent, defaults)
          : undefined;
      const stats = await session.getContextStats();
      const breakdown = await this.readContextBreakdown(session);
      const snapshot = contextStatsSnapshot(stats, breakdown, visibleLimit);
      this.contextSnapshots.set(contextSessionId, snapshot);
      this.emit({ type: 'context.updated', sessionId: contextSessionId, stats: snapshot });
      if (mission) {
        const contextPatch = {
          contextTokens: snapshot.used,
          contextRemainingTokens: snapshot.remaining,
          maxContextTokens: snapshot.limit,
          contextAccuracy: snapshot.accuracy,
          contextUpdatedAt: snapshot.updatedAt,
        };
        if (options.persist === false) mission.summary = { ...mission.summary, ...contextPatch };
        else this.patch(contextSessionId, contextPatch);
        const updated = this.findMission(contextSessionId)?.summary;
        if (updated) {
          this.emit({
            type: 'mission.tokens',
            missionId: contextSessionId,
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

  private async readContextBreakdown(
    session: DroidSession,
  ): Promise<ContextBreakdownSnapshot | undefined> {
    try {
      const exposed = session as unknown as { getContextBreakdown?: () => Promise<unknown> };
      if (typeof exposed.getContextBreakdown === 'function') {
        return contextBreakdownSnapshot(await exposed.getContextBreakdown());
      }

      const client = (
        session as unknown as {
          _client?: {
            _sessionRpcWithoutParams?: (method: string, schema: unknown) => Promise<unknown>;
          };
        }
      )._client;
      if (!client?._sessionRpcWithoutParams) return undefined;
      return contextBreakdownSnapshot(
        await client._sessionRpcWithoutParams(
          'droid.get_context_breakdown',
          ContextBreakdownResultSchema,
        ),
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
    mission.unsubscribe?.();
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
    // Browser sessions are keyed by the stable app session id (mission.id), not
    // the droid sessionId, which compaction swaps. Close by the app id so a
    // compacted mission's native browser is actually torn down.
    await this.browsers.close(mission.summary.id).catch(() => {});
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

  private emitError(error: {
    code?: string;
    sessionId?: string;
    missionId?: string;
    message: string;
    recoverable?: boolean;
  }): void {
    const { recoverable, ...rest } = error;
    // A recoverable error surfaces to the user (toast) without marking the whole
    // mission failed; the session stays usable (e.g. a transient compaction
    // error leaves the conversation intact and the next turn can proceed).
    if (!recoverable) {
      this.emit({
        type: 'mission.error',
        missionId: rest.missionId ?? rest.sessionId,
        message: rest.message,
      });
    }
    this.emit({ type: 'error', ...rest });
  }

  private async handleBrowser(
    missionId: string | undefined,
    action: () => Promise<void | unknown>,
  ): Promise<void> {
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
        reject(
          new Error(
            `Droid Control browser did not respond to ${request.action} within ${BROWSER_NATIVE_TIMEOUT_MS}ms.`,
          ),
        );
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
      throw new Error(
        'Browser sessions are scoped to a Droid chat. Select or create a chat before opening the browser.',
      );
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
    compactionTokenLimit?: number;
    compactionTokenLimitPerModel?: Record<string, number>;
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
  )
    return value;
  return undefined;
}

function classifySession(
  init: InitResultLike,
  historical?: MissionSummary,
): Pick<MissionSummary, 'kind' | 'role' | 'missionId' | 'parentSessionId'> {
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
  if (
    mode === 'agi' ||
    decompType === 'orchestrator' ||
    historical?.kind === 'mission_orchestrator'
  ) {
    return {
      kind: 'mission_orchestrator',
      role: 'orchestrator',
      missionId: missionId ?? historical?.id,
      parentSessionId: undefined,
    };
  }
  if (mode === 'spec' || historical?.kind === 'spec')
    return { kind: 'spec', role: 'orchestrator', missionId: undefined, parentSessionId: undefined };
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

function transferSetKey(set: Set<string>, from: string, to: string): void {
  if (!set.delete(from)) return;
  set.add(to);
}

function transferMapKey<T>(map: Map<string, T>, from: string, to: string): void {
  if (!map.has(from)) return;
  const value = map.get(from);
  map.delete(from);
  if (value !== undefined) map.set(to, value);
}

function remapFeatureWorkerIds(
  features: BridgeFeature[],
  oldSessionId: string,
  newSessionId: string,
): BridgeFeature[] | undefined {
  let changed = false;
  const remapId = (value?: string | null): string | null | undefined => {
    if (value !== oldSessionId) return value;
    changed = true;
    return newSessionId;
  };
  const remapIds = (values?: string[]): string[] | undefined => {
    if (!values) return values;
    let changedArray = false;
    const next = values.map((value) => {
      if (value !== oldSessionId) return value;
      changed = true;
      changedArray = true;
      return newSessionId;
    });
    return changedArray ? next : values;
  };
  const next = features.map((feature) => {
    const workerSessionIds = remapIds(feature.workerSessionIds);
    const currentWorkerSessionId = remapId(feature.currentWorkerSessionId);
    const completedWorkerSessionId = remapId(feature.completedWorkerSessionId);
    if (
      workerSessionIds === feature.workerSessionIds &&
      currentWorkerSessionId === feature.currentWorkerSessionId &&
      completedWorkerSessionId === feature.completedWorkerSessionId
    )
      return feature;
    return {
      ...feature,
      workerSessionIds,
      currentWorkerSessionId,
      completedWorkerSessionId,
    };
  });
  return changed ? next : undefined;
}
