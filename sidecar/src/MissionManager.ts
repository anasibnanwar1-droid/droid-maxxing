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
  isAlwaysOutcome,
  isApprovalOutcome,
  normalizePermissionOutcome,
} from './permissionOutcomes.js';
import { filterMissionListSummaries, type MissionListFilterOptions } from './missionListFilter.js';
import {
  autoCompactionTokenLimit,
  autoCompactionDue,
  clampCompactionTokenLimit,
  compactionTokenLimitForModel,
  createCompactionSettingsForModel,
  normalizeCompactionTokenLimit,
  resumedCompactionTokenLimit,
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
  compactionTokenBudget?: number;
  compactionCount?: number;
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
  // Worker session ids tied to this mission by persisted spawn->worker links,
  // seeded on resume so historical subagents stay openable even before any live
  // spawn re-populates knownSubagents. Kept separate from knownSubagents so live
  // run-status reporting only reflects subagents actually seen this session.
  linkedSubagents: Set<string>;
  subagentToolUseIds: Map<string, string>;
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
  // Guards compactSession so neither auto nor manual compaction can run
  // concurrently (the SDK session swap is not safe to overlap with another
  // compact or a streaming turn).
  compacting?: boolean;
  // Droid Control's effective auto-compaction trigger, computed from the
  // configured budget plus the 90%-to-75% session-age policy. Stored so
  // maybeAutoCompact doesn't re-derive it from defaults that may have drifted.
  compactionTokenBudget?: number;
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
          this.emitStatus(
            missionId,
            'Cannot compact while a turn is active. Try again when the model is idle.',
          );
          return;
        }
        await this.compactSession(missionId, cmd.customInstructions, 'manual');
        // Manual compaction is a standalone command, so unlike auto-compaction
        // (which runs inside drive()'s finally and drains there) nothing else
        // delivers messages queued during it. Drain one now; drive()'s finally
        // chains the rest.
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
        this.emitError({ message: `models.list failed: ${errMsg(err)}` });
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
    return validateFactoryDefaults(defaults, models);
  }

  private async emitFactoryDefaults(): Promise<void> {
    const defaults = readFactoryDefaults();
    const droidPath = this.runtime.status().droidPath;
    const models = this.cachedModels ?? mergeModelCatalog(readDroidCliModelCatalogCache(droidPath));
    if (!this.cachedModels && models.length > 0) this.cachedModels = models;
    this.emit({ type: 'settings.defaults', defaults: startupFactoryDefaults(defaults, models) });
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

  private maxContextTokensForSummary(summary: MissionSummary): number | undefined {
    return this.maxContextTokensForModel(summary.modelId);
  }

  private maxContextTokensForModel(modelId?: string): number | undefined {
    if (!modelId) return undefined;
    return this.cachedModels?.find((model) => model.id === modelId)?.maxContextTokens;
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
        if (mission && missionId && cmd.agent === 'orchestrator') {
          // The auto-compaction threshold is derived from the orchestrator model,
          // so recompute it when the model changes; otherwise auto-compaction
          // keeps using the limit captured at create/resume time.
          if (cmd.modelId !== undefined) await this.recomputeOrchestratorCompactionLimit(mission);
          await this.refreshContext(missionId, mission.session);
        }
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
    if (Object.keys(next).length > 0) await mission.session.updateSettings(next as never);
  }

  // Refresh the auto-compaction threshold from the mission's effective orchestrator
  // model. When the model was reset to Default, summary.modelId is undefined, so
  // resolve the actual default model (its per-model limit and context-window clamp
  // would otherwise be ignored).
  private async recomputeOrchestratorCompactionLimit(mission: Mission): Promise<void> {
    const defaults = await this.getFactoryDefaults();
    const modelId =
      mission.summary.modelId ??
      defaultModelForAgent('orchestrator', modeForSummary(mission.summary), defaults);
    const budget = clampCompactionTokenLimit(
      compactionTokenLimitForModel(modelId, {}, defaults),
      this.maxContextTokensForModel(modelId),
    );
    mission.compactionTokenBudget = budget;
    mission.effectiveCompactionTokenLimit = autoCompactionTokenLimit(
      budget,
      mission.summary.compactedFromSessionIds?.length ?? 0,
    );
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
      if (pending.orchestrator?.modelId !== undefined) {
        // A pending orchestrator model applied before send changes the
        // auto-compaction threshold; recompute it to match the new model.
        await this.recomputeOrchestratorCompactionLimit(mission);
      }
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

  private resolveSummary(id: string): MissionSummary | undefined {
    return this.listAllSummaries().find(
      (summary) =>
        summary.id === id ||
        summary.sessionId === id ||
        Boolean(summary.compactedFromSessionIds?.includes(id)),
    );
  }

  private async resumeMission(sessionId: string): Promise<void> {
    if (!this.ready) this.connect();
    const historical = this.resolveSummary(sessionId);
    const appSessionId = historical?.id ?? sessionId;
    const droidSessionId = historical?.sessionId ?? sessionId;
    const existing = this.findMission(appSessionId);
    if (existing) {
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
      // Auto-compaction budget after resume: the SDK does not always expose a
      // per-session compactionTokenLimit, so honor one only if init reports it;
      // otherwise the budget follows current app defaults.
      const resumeCompactionLimit = clampCompactionTokenLimit(
        resumedCompactionTokenLimit(
          summary.modelId,
          {
            compactionTokenLimit: init.settings?.compactionTokenLimit,
            compactionTokenLimitPerModel: init.settings?.compactionTokenLimitPerModel,
          },
          defaults,
        ),
        this.maxContextTokensForSummary(summary),
      );
      const mission: Mission = this.createLiveMission(
        summary,
        session,
        mcp.servers,
        resumeCompactionLimit,
        mcp.configs,
      );
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
      const compactionModel = cmd.compactionModel ?? defaults.compactionModel ?? 'current-model';
      const compactionSettings = createCompactionSettingsForModel(
        orchestratorModelId,
        cmd,
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
      const mission = this.createLiveMission(
        summary,
        session,
        mcp.servers,
        compactionSettings.compactionTokenLimit,
        mcp.configs,
      );
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
    compactionTokenBudget?: number,
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
      subagentSettings: new Map(),
      pendingSubagents: [],
      mcpServers,
      mcpConfigs,
      permissionGrants: new Set(),
      compactionTokenBudget,
      effectiveCompactionTokenLimit: autoCompactionTokenLimit(compactionTokenBudget, summary.compactedFromSessionIds?.length ?? 0),
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
  ): Promise<void> {
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
    let mission = this.findMission(missionId);
    if (!mission) return;
    const preCompactionMission = mission;
    const appSessionId = mission.summary.id;
    mission.streaming = true;
    this.patch(appSessionId, {
      phase: mission.summary.kind === 'mission_orchestrator' ? 'planning' : 'running',
      streaming: true,
      queuedSends: mission.pendingSends.length,
    });
    await this.compactBeforeModelStep(appSessionId);
    mission = this.findMission(missionId);
    if (!mission) {
      const queued = [prompt, ...preCompactionMission.pendingSends.splice(0)];
      if (queued.length > 0) void this.redeliverQueuedSends(appSessionId, queued);
      return;
    }
    this.startContextPolling(appSessionId, mission.session);
    await this.applyDesignToolPolicy(mission, isDesignPrompt(prompt));
    try {
      const stream = mission.session.stream(prompt, { includePartialMessages: true });
      for await (const ev of stream)
        this.applyEvent(appSessionId, appSessionId, 'orchestrator', ev);
    } catch (err) {
      if (mission.interruptingForSteer)
        this.emitStatus(appSessionId, 'Current turn interrupted for steering.');
      else {
        this.emitError({ missionId: appSessionId, message: errMsg(err) });
        this.patch(appSessionId, { phase: 'failed' });
      }
    } finally {
      this.stopContextPolling(appSessionId);
      mission.interruptingForSteer = false;
      await this.refreshContext(appSessionId, mission.session);
      mission.streaming = false;
      if (!this.findMission(appSessionId)) {
        // maybeAutoCompact's stale-swap recovery can drop the live mission. A
        // drive() against the now-missing mission would silently discard the
        // queued sends, so re-deliver them through the resume path instead.
        const queued = mission.pendingSends.splice(0);
        if (queued.length > 0) void this.redeliverQueuedSends(appSessionId, queued);
      } else {
        const next = mission.pendingSends.shift();
        this.patch(appSessionId, { streaming: false, queuedSends: mission.pendingSends.length });
        if (next !== undefined) void this.drive(appSessionId, next);
      }
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

  // The SDK exposes manual compaction only; auto-compaction is the client's job
  // (the CLI runs its own loop). Before each model step, compact once the context
  // window crosses the effective limit stored on the Mission at creation/resume
  // time. This keeps compaction out of the completed final-answer turn.
  private async compactBeforeModelStep(appSessionId: string): Promise<void> {
    const mission = this.findMission(appSessionId);
    if (!mission || mission.compacting) return;
    await this.refreshContext(appSessionId, mission.session);
    await this.maybeAutoCompact(appSessionId);
  }

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
    if (!mission.knownSubagents.has(sessionId) || mission.completedSubagents.has(sessionId)) return;
    const appSessionId = mission.summary.id;
    mission.completedSubagents.add(sessionId);
    const settings = mission.subagentSettings.get(sessionId) ?? {};
    this.emit({
      type: 'mission.worker',
      missionId: appSessionId,
      event: 'completed',
      workerSessionId: sessionId,
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
    const compactedFromSessionIds = uniqueStrings([
      ...(mission.summary.compactedFromSessionIds ?? []),
      mission.summary.sessionId,
    ]);
    const ref = { id: appSessionId };
    const oldSession = mission.session;
    mission.session = await this.runtime.loadSession(newSessionId, {
      permissionHandler: this.makePermissionHandler(ref),
      askUserHandler: this.makeAskUserHandler(ref),
      // Re-attach the same local MCP servers (still running) so the swapped
      // session keeps browser tools on subsequent turns.
      mcpServers: mission.mcpConfigs,
    });
    // The replacement session starts with default tool settings, so the cached
    // design-tool policy no longer reflects reality. Clear it so the next turn
    // re-synchronizes disabledToolIds.
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
    mission.effectiveCompactionTokenLimit = autoCompactionTokenLimit(mission.compactionTokenBudget, compactedFromSessionIds.length);
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
    this.patch(appSessionId, {
      sessionId: newSessionId,
      compactedFromSessionIds: uniqueStrings([
        ...(mission.summary.compactedFromSessionIds ?? []),
        mission.summary.sessionId,
      ]),
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
      if (newSessionId !== oldDroidSessionId && historical) {
        const updated = {
          ...historical,
          sessionId: newSessionId,
          compactedFromSessionIds: uniqueStrings([
            ...(historical.compactedFromSessionIds ?? []),
            oldDroidSessionId,
          ]),
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
    if (mission && settings.modelId !== undefined) {
      // The model drives the auto-compaction threshold; recompute it so this
      // path doesn't leave maybeAutoCompact using the old limit.
      await this.recomputeOrchestratorCompactionLimit(mission);
    }
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
  ): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    if (!this.agentBelongsToMission(mission, agentSessionId)) return;
    if (mission.agents.has(agentSessionId)) {
      const agent = mission.agents.get(agentSessionId);
      if (agent) agent.lastUsedAt = Date.now();
      this.emit({
        type: 'agent.updated',
        missionId: appSessionId,
        agentSessionId,
        role,
        status: 'opened',
      });
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
      const inheritsSessionModel =
        mission.summary.kind === 'chat' || mission.summary.kind === 'spec';
      const resolvedSettings: SubagentSettings = inheritsSessionModel
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
      // When the loaded agent session doesn't report its own model, fall back to
      // the role's configured model (not the orchestrator's), so per-model limits
      // and context-window clamps stay correct for differing worker/validator models.
      const roleModelId =
        role === 'worker'
          ? mission.summary.workerModelId
          : role === 'validator'
            ? mission.summary.validatorModelId
            : undefined;
      const workerModelId = resolvedSettings.modelId ?? roleModelId ?? mission.summary.modelId;
      const compactionTokenBudget = clampCompactionTokenLimit(
        compactionTokenLimitForModel(workerModelId, {}, defaults),
        this.maxContextTokensForModel(workerModelId),
      );
      const agent: LiveAgent = {
        session,
        missionId: appSessionId,
        role,
        streaming: false,
        pendingSends: [],
        lastUsedAt: Date.now(),
        compactionTokenBudget,
        compactionCount: 0,
        effectiveCompactionTokenLimit: autoCompactionTokenLimit(compactionTokenBudget, 0),
      };
      agent.unsubscribe = session.onNotification((note: Record<string, unknown>) => {
        for (const n of normalizeNotification(appSessionId, agentSessionId, role, note))
          this.applyNormalized(appSessionId, n);
      });
      mission.agents.set(agentSessionId, agent);
      this.emitAgentHistory(appSessionId, agentSessionId);
      this.emit({
        type: 'agent.updated',
        missionId: appSessionId,
        agentSessionId,
        role,
        status: 'opened',
      });
    } catch (err) {
      this.emit({
        type: 'error',
        code: 'agent.open_failed',
        missionId: appSessionId,
        sessionId: agentSessionId,
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

  private async sendAgent(missionId: string, agentSessionId: string, text: string): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    if (!this.agentBelongsToMission(mission, agentSessionId)) return;
    if (!mission.agents.has(agentSessionId))
      await this.openAgent(appSessionId, agentSessionId, 'worker');
    const agent = mission.agents.get(agentSessionId);
    if (!agent) return;
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
    this.startContextPolling(agent.session.sessionId, agent.session);
    try {
      const stream = agent.session.stream(text, { includePartialMessages: true });
      for await (const ev of stream)
        this.applyEvent(agent.missionId, agent.session.sessionId, agent.role, ev);
    } catch (err) {
      if (agent.interruptingForSteer)
        this.emitStatus(agent.missionId, 'Subagent turn interrupted for steering.');
      else {
        const message = errMsg(err);
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
      if (agent.pendingSends.length === 0 && agent.closeWhenIdle) {
        agent.streaming = false;
        await this.closeAgent(agent.missionId, agent.session.sessionId);
      } else {
        // Refresh + auto-compact while streaming stays true so concurrent sends
        // queue instead of racing a second driveAgent(). Compaction is scoped to
        // this worker's own session/history (and may re-key it to a new id).
        await this.refreshContext(agent.session.sessionId, agent.session);
        const outcome = await this.maybeAutoCompactAgent(agent);
        agent.streaming = false;
        if (outcome === 'stale') {
          // The daemon swapped this worker to a new backing session but adopting
          // it failed, so agent.session now points at a dead id. Tear the worker
          // down instead of draining queued sends into a stale session; a later
          // open/send re-creates it against the live session.
          this.emitError({
            sessionId: agent.session.sessionId,
            missionId: agent.missionId,
            message:
              'Subagent compaction swapped sessions but could not be adopted; closing the subagent. Re-open it to continue.',
            recoverable: true,
          });
          await this.closeAgent(agent.missionId, agent.session.sessionId);
        } else {
          // Compaction is applied in place: 'completed' re-keys the worker to the
          // daemon's new backing session (via the reload hook) and a transient
          // 'failed' leaves the current session valid. Either way agent.session
          // stays usable, so drain queued sends against it normally.
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
  }

  // Workers compact their own session through the shared compaction path. The
  // daemon swaps to a new backing id on success, which the reload hook adopts
  // in place (re-keying the worker) so the worker stays alive and addressable.
  // Returns the compaction outcome (or undefined when no compaction was
  // attempted) so the caller can recover on a transient failure.
  private async maybeAutoCompactAgent(agent: LiveAgent): Promise<CompactionOutcome | undefined> {
    const used = this.contextSnapshots.get(agent.session.sessionId)?.used;
    if (!autoCompactionDue(agent, used)) return undefined;
    return this.compactAgent(agent, 'auto');
  }

  private async compactAgent(
    agent: LiveAgent,
    compactType: CompactType,
  ): Promise<CompactionOutcome> {
    const agentSessionId = agent.session.sessionId;
    agent.compacting = true;
    // Remembers the daemon's new backing id (set by the reload hook before it
    // adopts the swap) so a reload failure that returns 'stale' can still
    // recover the new id instead of losing it, mirroring the orchestrator's
    // swapTarget / recoverStaleMissionSwap path.
    let swapTarget: string | undefined;
    try {
      const outcome = await runCompaction(
        agent.session,
        {
          // Status lines stay keyed by the worker's original id so they land on
          // the worker the client is still showing; the rekey event below moves
          // that transcript to the new id afterwards.
          status: (text, ct) =>
            this.emitStatus(agent.missionId, text, ct, agentSessionId, agent.role),
          error: (message) =>
            this.emitError({
              sessionId: agentSessionId,
              missionId: agent.missionId,
              message: `Could not compact subagent: ${message}`,
              recoverable: true,
            }),
          // After a swap the snapshot must live under the worker's current id so
          // the next auto-compaction check reads the right usage.
          refresh: () => this.refreshContext(agent.session.sessionId, agent.session),
          // The daemon swaps to a new backing session id on a successful
          // compaction. Adopt it in place (re-key all maps and re-subscribe)
          // so the worker stays alive and queued sends keep flowing rather than
          // the session being treated as stale and torn down.
          reload: async (newSessionId) => {
            swapTarget = newSessionId;
            await this.rekeyAgentSession(agent, newSessionId);
          },
        },
        { compactType },
      );
      // In-place adoption succeeded: tell clients to remap state from the old id
      // to the new one. Emitted after runCompaction so all old-id-keyed
      // transcript/status events are flushed first.
      if (agent.session.sessionId !== agentSessionId) {
        this.emitWorkerRekey(agent.missionId, agentSessionId, agent.session.sessionId);
        return outcome;
      }
      // The daemon swapped to a new backing id but adopting it threw, so
      // agent.session still points at the swapped-away (now-dead) old id.
      // Recover so the new id isn't lost: otherwise queued sends and future
      // re-opens would target the dead old id.
      if (outcome === 'stale' && swapTarget) {
        return await this.recoverStaleAgentSwap(agent, agentSessionId, swapTarget);
      }
      return outcome;
    } finally {
      agent.compacting = false;
    }
  }

  private emitWorkerRekey(missionId: string, oldSessionId: string, newSessionId: string): void {
    this.emit({ type: 'mission.worker.rekey', missionId, oldSessionId, newSessionId });
  }

  // Recovery for a worker compaction that swapped backing sessions but failed to
  // adopt the new one (agent.session is now a dead id). Retry the adoption once
  // for a transient load failure; if it still fails, persist the new id to the
  // durable spawn link and mission features so a later re-open/resume targets
  // the live (compacted) session, then report 'stale' so the caller tears down
  // the dead-id worker instead of draining sends into it.
  private async recoverStaleAgentSwap(
    agent: LiveAgent,
    oldSessionId: string,
    newSessionId: string,
  ): Promise<CompactionOutcome> {
    try {
      await this.rekeyAgentSession(agent, newSessionId);
      this.emitWorkerRekey(agent.missionId, oldSessionId, agent.session.sessionId);
      return 'completed';
    } catch {
      /* adoption still failing; persist the new id below so re-open hits it */
    }
    const mission = this.findMission(agent.missionId);
    if (mission) this.persistWorkerSwap(mission, oldSessionId, newSessionId);
    this.emitWorkerRekey(agent.missionId, oldSessionId, newSessionId);
    return 'stale';
  }

  // Adopt a worker's swapped backing session id (returned by the daemon on a
  // successful compaction) in place: load the new session, move every map/set
  // keyed by the old id, re-subscribe notifications, and persist the updated
  // spawn links so a later resume points at the compacted session. Loading runs
  // first so a failure leaves the old (still valid) session untouched; the
  // synchronous re-keying that follows cannot throw.
  private async rekeyAgentSession(agent: LiveAgent, newSessionId: string): Promise<void> {
    const oldSessionId = agent.session.sessionId;
    if (newSessionId === oldSessionId) return;
    const ref = { id: agent.missionId };
    const newSession = await this.runtime.loadSession(newSessionId, {
      permissionHandler: this.makePermissionHandler(ref),
      askUserHandler: this.makeAskUserHandler(ref),
    });
    const oldSession = agent.session;
    agent.unsubscribe?.();
    agent.session = newSession;
    agent.unsubscribe = newSession.onNotification((note: Record<string, unknown>) => {
      for (const n of normalizeNotification(agent.missionId, newSessionId, agent.role, note))
        this.applyNormalized(agent.missionId, n);
    });
    const snapshot = this.contextSnapshots.get(oldSessionId);
    this.contextSnapshots.delete(oldSessionId);
    if (snapshot) this.contextSnapshots.set(newSessionId, snapshot);
    const mission = this.findMission(agent.missionId);
    if (mission) {
      if (mission.agents.delete(oldSessionId)) mission.agents.set(newSessionId, agent);
      if (mission.knownSubagents.delete(oldSessionId)) mission.knownSubagents.add(newSessionId);
      if (mission.completedSubagents.delete(oldSessionId))
        mission.completedSubagents.add(newSessionId);
      if (mission.linkedSubagents.delete(oldSessionId)) mission.linkedSubagents.add(newSessionId);
      const settings = mission.subagentSettings.get(oldSessionId);
      if (settings) {
        mission.subagentSettings.delete(oldSessionId);
        mission.subagentSettings.set(newSessionId, settings);
      }
      this.persistWorkerSwap(mission, oldSessionId, newSessionId);
    }
    await oldSession.close().catch(() => {});
    agent.compactionCount = (agent.compactionCount ?? 0) + 1;
    agent.effectiveCompactionTokenLimit = autoCompactionTokenLimit(agent.compactionTokenBudget, agent.compactionCount);
  }

  // Persist a worker's compaction swap to the durable spawn link and the mission
  // summary features so a later resume or re-open targets the compacted id (not
  // the dead old one). Shared by the in-place rekey and the stale-swap recovery
  // (which runs this even when the new session could not be loaded, so the new
  // id survives in history and the worker is re-openable).
  private persistWorkerSwap(mission: Mission, oldSessionId: string, newSessionId: string): void {
    // Authorize the new id for live agent.open/agent.send immediately. When
    // rekeyAgentSession succeeds it has already swapped these sets; but the
    // stale-recovery path runs persistWorkerSwap WITHOUT a successful rekey, so
    // without this the rekeyed id is in neither set and every open/send fails
    // with agent.not_in_session until the mission is reloaded. delete() guards
    // keep it idempotent when the rekey path already moved them.
    if (mission.knownSubagents.delete(oldSessionId)) mission.knownSubagents.add(newSessionId);
    if (mission.linkedSubagents.delete(oldSessionId)) mission.linkedSubagents.add(newSessionId);
    // Re-point any spawn link for this worker at the new id (preserving its
    // label) so a later resume seeds linkedSubagents with the compacted id.
    const labelByToolUseId = new Map(
      this.history.subagentLinks(mission.summary.id).map((l) => [l.toolUseId, l.label]),
    );
    for (const [toolUseId, sid] of mission.subagentToolUseIds) {
      if (sid !== oldSessionId) continue;
      mission.subagentToolUseIds.set(toolUseId, newSessionId);
      this.history.recordSubagentLink(
        mission.summary.id,
        toolUseId,
        newSessionId,
        labelByToolUseId.get(toolUseId),
      );
    }
    // Mission features pin workers by session id (feature focus + worker
    // numbering). Remap them on the summary too, so a later mission.list/
    // mission.updated (which re-emits summary.features) can't overwrite the
    // client's rekey with the dead id and make feature-focused views unopenable.
    const features = mission.summary.features;
    if (features?.length) {
      mission.summary.features = features.map((f) =>
        f.currentWorkerSessionId === oldSessionId ||
        f.completedWorkerSessionId === oldSessionId ||
        f.workerSessionIds?.includes(oldSessionId)
          ? {
              ...f,
              workerSessionIds: f.workerSessionIds?.map((id) =>
                id === oldSessionId ? newSessionId : id,
              ),
              currentWorkerSessionId:
                f.currentWorkerSessionId === oldSessionId ? newSessionId : f.currentWorkerSessionId,
              completedWorkerSessionId:
                f.completedWorkerSessionId === oldSessionId
                  ? newSessionId
                  : f.completedWorkerSessionId,
            }
          : f,
      );
    }
  }

  private async sendAgentNow(
    missionId: string,
    agentSessionId: string,
    text: string,
  ): Promise<void> {
    const mission = this.findMission(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.id;
    if (!this.agentBelongsToMission(mission, agentSessionId)) return;
    if (!mission.agents.has(agentSessionId))
      await this.openAgent(appSessionId, agentSessionId, 'worker');
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
    if (!mission.agents.has(agentSessionId))
      await this.openAgent(appSessionId, agentSessionId, 'worker');
    const agent = mission.agents.get(agentSessionId);
    if (!agent) return;
    agent.pendingSends = [];
    agent.lastUsedAt = Date.now();
    // Never interrupt an in-flight subagent compaction; let it finish and drain.
    if (agent.compacting) return;
    await agent.session.interrupt();
    agent.streaming = false;
    this.emit({
      type: 'agent.updated',
      missionId: appSessionId,
      agentSessionId,
      role: agent.role,
      status: 'paused',
    });
  }

  private agentBelongsToMission(mission: Mission, agentSessionId: string): boolean {
    if (mission.summary.kind === 'mission_orchestrator') return true;
    if (mission.knownSubagents.has(agentSessionId)) return true;
    if (mission.linkedSubagents.has(agentSessionId)) return true;
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
    if (!agent.streaming && agent.pendingSends.length === 0)
      await this.closeAgent(missionId, agentSessionId);
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
    const limit =
      this.maxContextTokensForSummary(summary) ?? summary.maxContextTokens ?? previous?.limit;
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
  const usedTokens =
    numberValue(value.usedTokens) ?? categories.reduce((sum, item) => sum + item.tokens, 0);
  const contextBudget =
    numberValue(value.contextBudget) ?? usedTokens + (numberValue(value.freeTokens) ?? 0);
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

function defaultModelForAgent(
  agent: ConfigurableAgent,
  mode: SessionInteractionMode,
  defaults: FactoryDefaultSettings,
): string | undefined {
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

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
