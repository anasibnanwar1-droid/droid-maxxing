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
  SessionRole,
  Autonomy,
  BrowserNativeRequest,
  BrowserNativeResult,
  ClientCommand,
  ConfigurableSessionRole,
  ContextBreakdownSnapshot,
  ContextStatsSnapshot,
  ChildSessionHistoryLink,
  FactoryDefaultSettings,
  InstallChannel,
  SessionPhase,
  SessionHistoryEntry,
  SessionPurpose,
  SessionSummary,
  ModelInfo,
  PermissionKind,
  ProgressEntry,
  ReasoningEffort,
  ServerEvent,
  SessionInteractionMode,
  TranscriptEvent,
} from './protocol.js';
import { errMsg, isUserCancellation, normalizeAutonomy, uniqueStrings } from './sessionHelpers.js';
import { boundedInt, numberValue, stringValue } from './values.js';
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
import {
  filterSessionListSummaries,
  type SessionListFilterOptions,
} from './sessionListFilter.js';
import {
  daemonCompactionSettings,
  effectiveCompactionTriggerLimit,
  normalizeCompactionTokenLimit,
  runCompaction,
  type CompactionTokenLimitPatch,
  type CompactType,
} from './compaction.js';
import {
  AutoCompactionWatchdogs,
  POST_TURN_AUTO_COMPACTION_WATCHDOG_MS,
} from './autoCompactionWatchdog.js';
import {
  handleCompactionNotification as runCompactionNotification,
  onAutoCompactionWatchdogExpired as settleExpiredAutoCompaction,
  type AutoCompactionHost,
} from './sessionAutoCompaction.js';

type Emit = (event: ServerEvent) => void;

interface SessionManagerOptions {
  assetUrlFor?: (path: string) => string;
}

interface LiveAgent {
  session: DroidSession;
  // The parent session's agents map key (and watchdog key). Kept explicitly so paths
  // that only hold the agent never key timers off session.sessionId, which is
  // not guaranteed to match the map key.
  providerSessionId: string;
  appSessionId: string;
  role: SessionRole;
  streaming: boolean;
  autoCompacting: boolean;
  pendingSends: string[];
  interruptingForSteer?: boolean;
  // Set while a user Stop is in flight so the stream catch can attribute the
  // resulting abort to the user (settle quietly) instead of a real failure.
  interrupting?: boolean;
  lastUsedAt: number;
  closeWhenIdle?: boolean;
  unsubscribe?: () => void;
}

interface LiveSession {
  summary: SessionSummary;
  session: DroidSession;
  streaming: boolean;
  pendingSends: string[];
  interruptingForSteer?: boolean;
  // Set while a user Stop is in flight (see LiveAgent.interrupting).
  interrupting?: boolean;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, (r: AskUserResult) => void>;
  agents: Map<string, LiveAgent>;
  knownSubagents: Set<string>;
  completedSubagents: Set<string>;
  // Session ids (orchestrator or a worker) whose current streaming turn has
  // already produced its terminal `result`. Further model generation in the
  // same turn is quarantined so a turn renders exactly one final response, and
  // the set is cleared when that session's next turn starts.
  terminalAgents: Set<string>;
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
  // Guards manual compactSession so it cannot run concurrently with itself or
  // a streaming turn (the SDK session swap is not safe to overlap with either).
  compacting?: boolean;
  autoCompacting: boolean;
  // Raw daemon-notification subscription for the orchestrator session, used to
  // surface the daemon's in-place auto-compaction (compacting_conversation /
  // session_compacted). Re-created when a manual compaction swaps the session.
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

export interface AgentSettingPatch {
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
}

interface UsageOffset {
  tokensIn: number;
  tokensOut: number;
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

export class SessionManager {
  private ready = false;
  // Monotonic suffix so two status lines emitted in the same millisecond get
  // distinct transcript IDs (the UI drops duplicate IDs, which could otherwise
  // strand the in-progress compaction shimmer).
  private statusSeq = 0;
  private cachedModels: ModelInfo[] | null = null;
  private modelRefresh: Promise<ModelInfo[] | null> | null = null;
  private readonly runtime = new DroidRuntime();
  private readonly history = new HistoryIndex();
  private readonly sessions = new Map<string, LiveSession>();
  private readonly pendingAgentSettings = new Map<
    string,
    Partial<Record<ConfigurableSessionRole, AgentSettingPatch>>
  >();
  // Latest compaction limit snapshot pushed by the app UI. It outranks CLI
  // defaults so resume, model changes, and worker opens all follow the limits
  // the Settings panel shows.
  private uiCompactionSettings: CompactionTokenLimitPatch = {};
  // Monotonic revision of uiCompactionSettings; in-flight retunes from an
  // older revision stop instead of re-arming stale limits out of order.
  private compactionRetuneRev = 0;
  // Bounds how long an autoCompacting flag may stay raised without a
  // completion, so a lost session_compacted can never wedge a session forever.
  private readonly autoCompactionWatchdogs = new AutoCompactionWatchdogs((sessionKey) =>
    this.onAutoCompactionWatchdogExpired(sessionKey),
  );
  private readonly usageOffsets = new Map<string, UsageOffset>();
  private readonly contextSnapshots = new Map<string, ContextStatsSnapshot>();
  // In-place compactions completed per worker session; carried on that
  // session's context snapshots so the meter's ratchet resets (workers have no
  // summary-level generation counter of their own).
  private readonly agentCompactions = new Map<string, number>();
  private readonly contextPollers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pendingNativeBrowserRequests = new Map<string, PendingNativeBrowserRequest>();
  private readonly browsers: BrowserSessionManager;

  constructor(
    private readonly emit: Emit,
    options: SessionManagerOptions = {},
  ) {
    this.browsers = new BrowserSessionManager({
      assetUrlFor: options.assetUrlFor,
      emit: (event) => this.emit(event),
      runtimeFactory: (browserSessionId, viewport, appSessionId) =>
        new NativeBrowserRuntime({
          browserSessionId,
          appSessionId,
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
      case 'catalog.models': {
        const models = await this.getModels();
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
        await this.createSession(cmd);
        return;
      case 'session.send':
        await this.send(cmd.appSessionId, cmd.text);
        return;
      case 'session.sendNow':
        await this.sendNow(cmd.appSessionId, cmd.text);
        return;
      case 'approval.respond':
        await this.resolvePermission(cmd.appSessionId, cmd.requestId, cmd.outcome);
        return;
      case 'question.respond':
        this.resolveQuestion(cmd.appSessionId, cmd.requestId, cmd.cancelled, cmd.answers);
        return;
      case 'session.interrupt':
        await this.interrupt(cmd.appSessionId);
        return;
      case 'child.open':
        await this.openAgent(cmd.appSessionId, cmd.providerSessionId, cmd.role ?? 'worker');
        return;
      case 'child.send':
        await this.sendAgent(cmd.appSessionId, cmd.providerSessionId, cmd.text);
        return;
      case 'child.sendNow':
        await this.sendAgentNow(cmd.appSessionId, cmd.providerSessionId, cmd.text);
        return;
      case 'child.interrupt':
        await this.interruptAgent(cmd.appSessionId, cmd.providerSessionId);
        return;
      case 'session.updateSettings':
        await this.updateSessionSettings(cmd.appSessionId, cmd);
        if (cmd.autonomy !== undefined) {
          await this.setAutonomy(cmd.appSessionId, cmd.autonomy);
        }
        if (cmd.interactionMode !== undefined) {
          await this.setInteractionMode(cmd.appSessionId, cmd.interactionMode);
        }
        return;
      case 'session.compact': {
        const appSessionId = cmd.appSessionId;
        const liveSession = this.findSession(appSessionId);
        if (liveSession?.streaming || liveSession?.compacting || liveSession?.autoCompacting) {
          this.emitStatus(
            appSessionId,
            'Cannot compact while a turn is active. Try again when the model is idle.',
          );
          return;
        }
        await this.compactSession(appSessionId, cmd.customInstructions, 'manual');
        // Manual compaction is a standalone command, so nothing else delivers
        // messages queued during it. Drain one now; drive()'s finally chains
        // the rest.
        const compacted = this.findSession(appSessionId);
        if (
          compacted &&
          !compacted.streaming &&
          !compacted.compacting &&
          !compacted.autoCompacting
        ) {
          const next = compacted.pendingSends.shift();
          if (next !== undefined) {
            this.patch(compacted.summary.appSessionId, { queuedSends: compacted.pendingSends.length });
            await this.drive(compacted.summary.appSessionId, next);
          }
        } else if (!compacted && liveSession) {
          // Stale-swap recovery dropped the live mission during compaction; the
          // queued prompts live on the detached mission object, so re-deliver
          // them through the resume path instead of discarding them.
          const queued = liveSession.pendingSends.splice(0);
          if (queued.length > 0) await this.redeliverQueuedSends(appSessionId, queued);
        }
        return;
      }
      case 'session.fork':
        await this.withSession(cmd.appSessionId, (session) => session.forkSession());
        return;
      case 'session.rename':
        await this.renameSession(cmd.appSessionId, cmd.title);
        return;
      case 'session.rewindInfo':
        await this.withSession(cmd.appSessionId, (session) => session.getRewindInfo({} as never));
        return;
      case 'session.rewind':
        await this.withSession(cmd.appSessionId, (session) =>
          session.executeRewind({ rewindId: cmd.rewindId } as never),
        );
        return;
      case 'session.resume':
        await this.resumeSession(cmd.appSessionId);
        return;
      case 'session.close':
        await this.closeSession(cmd.appSessionId);
        return;
      case 'sessions.list':
        this.emitSessionList(cmd);
        return;
      case 'history.list':
        await this.listHistory();
        return;
      case 'history.page':
        this.loadHistoryPage(cmd.providerSessionId, cmd.cursor, cmd.limit);
        return;
      case 'session.loadHistory':
        this.loadSessionHistory(cmd.appSessionId, cmd.cursor);
        return;
      case 'settings.agent.update':
        await this.updateAgentSettings(cmd);
        return;
      case 'settings.compaction.update':
        await this.updateCompactionSettings(cmd);
        return;
      case 'browser.open':
        await this.handleBrowser(cmd.appSessionId, () =>
          this.browsers.open({
            ...cmd,
            appSessionId: this.requireBrowserAppSessionId(cmd.appSessionId),
          }),
        );
        return;
      case 'browser.close':
        await this.handleBrowser(cmd.appSessionId, async () => {
          const appSessionId = this.requireBrowserAppSessionId(cmd.appSessionId);
          await this.browsers.close(appSessionId);
          this.emit({ type: 'browser.closed', appSessionId });
        });
        return;
      case 'browser.reload':
        await this.handleBrowser(cmd.appSessionId, () =>
          this.browsers.reload(this.requireBrowserAppSessionId(cmd.appSessionId)),
        );
        return;
      case 'browser.refresh':
        await this.handleBrowser(cmd.appSessionId, () =>
          this.browsers.refresh(this.requireBrowserAppSessionId(cmd.appSessionId)),
        );
        return;
      case 'browser.resizeViewport':
        await this.handleBrowser(cmd.appSessionId, () =>
          this.browsers.resizeViewport({
            ...cmd,
            appSessionId: this.requireBrowserAppSessionId(cmd.appSessionId),
          }),
        );
        return;
      case 'browser.click':
        await this.handleBrowser(cmd.appSessionId, () =>
          this.browsers.click({
            ...cmd,
            appSessionId: this.requireBrowserAppSessionId(cmd.appSessionId),
          }),
        );
        return;
      case 'browser.type':
        await this.handleBrowser(cmd.appSessionId, () =>
          this.browsers.type(this.requireBrowserAppSessionId(cmd.appSessionId), cmd.text),
        );
        return;
      case 'browser.keypress':
        await this.handleBrowser(cmd.appSessionId, () =>
          this.browsers.keypress(this.requireBrowserAppSessionId(cmd.appSessionId), cmd.key),
        );
        return;
      case 'browser.scroll':
        await this.handleBrowser(cmd.appSessionId, () =>
          this.browsers.scroll(
            this.requireBrowserAppSessionId(cmd.appSessionId),
            cmd.direction,
            cmd.pixels,
            cmd.source,
            cmd.ref,
          ),
        );
        return;
      case 'browser.screenshot':
        await this.handleBrowser(cmd.appSessionId, async () => {
          await this.browsers.screenshot(this.requireBrowserAppSessionId(cmd.appSessionId), {
            fullPage: cmd.fullPage,
            deviceScaleFactor: cmd.deviceScaleFactor,
          });
        });
        return;
      case 'browser.inspectPoint':
        await this.handleBrowser(cmd.appSessionId, async () => {
          const element = this.browsers.inspectPoint(
            this.requireBrowserAppSessionId(cmd.appSessionId),
            cmd.x,
            cmd.y,
          );
          if (!element) throw new Error('No browser element found at that point.');
        });
        return;
      case 'browser.design.addReference':
        await this.handleBrowser(cmd.appSessionId, async () => {
          await this.browsers.addReference(
            this.requireBrowserAppSessionId(cmd.appSessionId),
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
        await this.handleBrowser(cmd.appSessionId, async () => {
          const appSessionId = this.requireBrowserAppSessionId(cmd.appSessionId);
          const { prompt } = await this.browsers.designPrompt({ ...cmd, appSessionId });
          await this.send(appSessionId, prompt);
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
        if (emit)
          this.emit({ type: 'catalog.updated', catalog: 'models', items: models });
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

  private maxContextTokensForSummary(summary: SessionSummary): number | undefined {
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
      const session = cmd.appSessionId ? this.findSession(cmd.appSessionId) : undefined;
      const summary =
        session?.summary ?? (cmd.appSessionId ? this.resolveSummary(cmd.appSessionId) : undefined);
      if (
        cmd.appSessionId &&
        cmd.agent !== 'primary' &&
        summary &&
        summary.sessionPurpose !== 'mission-control'
      ) {
        this.emitError({
          code: 'agent.settings_unsupported',
          appSessionId: summary.appSessionId,
          message: 'Worker and validator model settings only apply to Mission Control sessions.',
        });
        return;
      }
      if (cmd.appSessionId) this.rememberPendingAgentSettings(cmd);
      const appSessionId = session?.summary.appSessionId ?? cmd.appSessionId;
      if (session) {
        const settings = await this.runtimeAgentSettings(session, cmd.agent, {
          modelId: cmd.modelId,
          reasoningEffort: cmd.reasoningEffort,
        });
        await this.applyAgentSessionSettings(session, cmd.agent, settings);
      }
      if (cmd.appSessionId) {
        const patch = this.summaryPatchForAgent(cmd.agent, cmd);
        if (session && appSessionId) this.patch(appSessionId, patch);
        else {
          const historical = this.resolveSummary(cmd.appSessionId);
          if (historical)
            this.emit({
              type: 'session.updated',
              session: { ...historical, ...patch, updatedAt: Date.now() },
            });
        }
        if (session && appSessionId && cmd.agent === 'primary') {
          // The auto-compaction threshold is derived from the primary model,
          // so recompute it when the model changes; otherwise auto-compaction
          // keeps using the limit captured at create/resume time.
          if (cmd.modelId !== undefined) await this.recomputeSessionCompactionLimit(session);
          await this.refreshContext(appSessionId, session.session);
        }
      }
    } catch (err) {
      this.emitError({
        appSessionId: cmd.appSessionId,
        message: `Could not update agent settings: ${errMsg(err)}`,
      });
    }
  }

  private rememberPendingAgentSettings(
    cmd: Extract<ClientCommand, { type: 'settings.agent.update' }>,
  ): void {
    if (!cmd.appSessionId) return;
    const appSessionId =
      this.findSession(cmd.appSessionId)?.summary.appSessionId ??
      this.resolveSummary(cmd.appSessionId)?.appSessionId ??
      cmd.appSessionId;
    const existing = this.pendingAgentSettings.get(appSessionId) ?? {};
    const agent = { ...(existing[cmd.agent] ?? {}) };
    if (cmd.modelId !== undefined) agent.modelId = cmd.modelId;
    if (cmd.reasoningEffort !== undefined) agent.reasoningEffort = cmd.reasoningEffort;
    this.pendingAgentSettings.set(appSessionId, { ...existing, [cmd.agent]: agent });
  }

  private summaryPatchForAgent(
    agent: ConfigurableSessionRole,
    settings: AgentSettingPatch,
  ): Partial<SessionSummary> {
    const patch: Partial<SessionSummary> = {};
    if (agent === 'primary') {
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

  private applyPendingSettingsToSummary(summary: SessionSummary): SessionSummary {
    const pending = this.pendingAgentSettings.get(summary.appSessionId);
    if (!pending) return summary;
    return (Object.entries(pending) as [ConfigurableSessionRole, AgentSettingPatch][]).reduce(
      (next, [agent, settings]) => ({ ...next, ...this.summaryPatchForAgent(agent, settings) }),
      summary,
    );
  }

  private async applyAgentSessionSettings(
    mission: LiveSession,
    agent: ConfigurableSessionRole,
    settings: AgentSettingPatch,
  ): Promise<void> {
    const next = createSessionSettingsForAgent(agent, settings);
    if (Object.keys(next).length > 0) await mission.session.updateSettings(next as never);
  }

  // Refresh the daemon's auto-compaction threshold from the mission's effective
  // orchestrator model. When the model was reset to Default, summary.modelId is
  // undefined, so resolve the actual default model (its per-model limit and
  // context-window clamp would otherwise be ignored).
  private async recomputeSessionCompactionLimit(
    mission: LiveSession,
    stillCurrent: () => boolean = () => true,
  ): Promise<void> {
    const defaults = await this.getFactoryDefaults();
    const modelId =
      mission.summary.modelId ??
      defaultModelForAgent('primary', modeForSummary(mission.summary), defaults);
    const limit = await this.compactionLimit(modelId);
    if (!stillCurrent()) return;
    const armed = await this.enableDaemonAutoCompaction(mission.session, limit);
    if (!stillCurrent()) return;
    // The summary records the trigger the daemon actually accepted; an arm
    // failure clears it instead of advertising a limit that is not in force.
    this.patch(mission.summary.appSessionId, { compactionTokenLimit: armed ? limit : undefined });
  }

  // Thin binding of the shared derivation to this manager's state (UI settings
  // snapshot, CLI defaults, model catalog).
  private async compactionLimit(
    modelId: string | undefined,
    exposed: CompactionTokenLimitPatch = {},
  ): Promise<number> {
    const defaults = await this.getFactoryDefaults();
    return effectiveCompactionTriggerLimit({
      modelId,
      ui: this.uiCompactionSettings,
      exposed,
      defaults,
      maxContextTokens: this.maxContextTokensForModel(modelId),
    });
  }

  private agentModelId(
    mission: LiveSession,
    agentSessionId: string,
    role: SessionRole,
  ): string | undefined {
    let roleModelId: string | undefined;
    if (role === 'worker') roleModelId = mission.summary.workerModelId;
    else if (role === 'validator') roleModelId = mission.summary.validatorModelId;
    return (
      mission.subagentSettings.get(agentSessionId)?.modelId ??
      roleModelId ??
      mission.summary.modelId
    );
  }

  private async updateCompactionSettings(
    cmd: Extract<ClientCommand, { type: 'settings.compaction.update' }>,
  ): Promise<void> {
    const next: CompactionTokenLimitPatch = {};
    if (cmd.compactionTokenLimit !== undefined)
      next.compactionTokenLimit = cmd.compactionTokenLimit;
    if (cmd.compactionTokenLimitPerModel !== undefined)
      next.compactionTokenLimitPerModel = cmd.compactionTokenLimitPerModel;
    this.uiCompactionSettings = next;
    // Retune every live session (orchestrators and opened agents) so concurrent
    // chats on different models each follow their own effective limit. Sessions
    // retune in parallel so one hung updateSettings cannot stall the rest; the
    // revision guard keeps a slow batch from re-arming stale limits after a
    // newer settings change already retuned.
    const rev = ++this.compactionRetuneRev;
    const stillCurrent = () => rev === this.compactionRetuneRev;
    const retunes: Promise<unknown>[] = [];
    for (const mission of this.sessions.values()) {
      retunes.push(this.recomputeSessionCompactionLimit(mission, stillCurrent));
      for (const [agentSessionId, agent] of mission.agents) {
        const modelId = this.agentModelId(mission, agentSessionId, agent.role);
        retunes.push(
          this.compactionLimit(modelId).then((limit) => {
            if (!stillCurrent()) return;
            return this.enableDaemonAutoCompaction(agent.session, limit);
          }),
        );
      }
    }
    await Promise.allSettled(retunes);
  }

  // Best effort: turn on the daemon's own threshold check so it compacts the
  // session in place (same session id) once usage crosses the limit. A failure
  // leaves the daemon's default behavior in place and never blocks the caller;
  // the boolean lets callers avoid recording a trigger that is not in force.
  private async enableDaemonAutoCompaction(
    session: DroidSession,
    limit: number | undefined,
  ): Promise<boolean> {
    try {
      await session.updateSettings(daemonCompactionSettings(limit) as never);
      return true;
    } catch (err) {
      // The session stays usable, but auto-compaction is NOT armed: surface it
      // in the logs instead of failing silently ("compaction never happens").
      console.error(
        `[compaction] could not arm auto-compaction on ${session.sessionId}: ${errMsg(err)}`,
      );
      return false;
    }
  }

  private async runtimeAgentSettings(
    mission: LiveSession,
    agent: ConfigurableSessionRole,
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
    const mission = this.findSession(missionId);
    const appSessionId = mission?.summary.appSessionId ?? missionId;
    const pending = this.pendingAgentSettings.get(appSessionId);
    if (!mission || !pending) return true;
    try {
      let patch: Partial<SessionSummary> = {};
      for (const [agent, settings] of Object.entries(pending) as [
        ConfigurableSessionRole,
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
      if (pending.primary?.modelId !== undefined) {
        // A pending primary model applied before send changes the
        // auto-compaction threshold; recompute it to match the new model.
        await this.recomputeSessionCompactionLimit(mission);
      }
      return true;
    } catch (err) {
      this.emitError({
        appSessionId,
        message: `Could not apply selected model before send: ${errMsg(err)}`,
      });
      return false;
    }
  }

  private async listHistory(): Promise<void> {
    try {
      const sessions: SessionHistoryEntry[] = loadSessionHistory();
      this.emit({ type: 'history.list', sessions });
    } catch (err) {
      this.emitError({ message: errMsg(err) });
    }
  }

  private findSession(id: string): LiveSession | undefined {
    return (
      this.sessions.get(id) ??
      [...this.sessions.values()].find(
        (mission) =>
          mission.summary.providerSessionId === id ||
          Boolean(mission.summary.compactedFromProviderSessionIds?.includes(id)),
      )
    );
  }

  private findSessionKey(id: string): string | undefined {
    if (this.sessions.has(id)) return id;
    for (const [key, mission] of this.sessions) {
      if (mission.summary.providerSessionId === id || mission.summary.compactedFromProviderSessionIds?.includes(id))
        return key;
    }
    return undefined;
  }

  private resolveSummary(id: string): SessionSummary | undefined {
    return this.listAllSummaries().find(
      (summary) =>
        summary.appSessionId === id ||
        summary.providerSessionId === id ||
        Boolean(summary.compactedFromProviderSessionIds?.includes(id)),
    );
  }

  private async resumeSession(sessionId: string): Promise<void> {
    if (!this.ready) this.connect();
    const historical = this.resolveSummary(sessionId);
    const appSessionId = historical?.appSessionId ?? sessionId;
    const providerSessionId = historical?.providerSessionId ?? sessionId;
    const existing = this.findSession(appSessionId);
    if (existing) {
      this.emit({
        type: 'session.created',
        clientRef: `resume:${appSessionId}`,
        session: existing.summary,
      });
      void this.refreshContext(existing.summary.appSessionId, existing.session);
      return;
    }
    // Key local MCP servers and permission handlers by the stable app session id
    // (not the provider session id, which compaction swaps). This keeps the browser
    // session key consistent across compaction so browser tools keep targeting the
    // visible chat. Mirrors create(), which sets ref.id to the app session id.
    const ref = { id: appSessionId };
    let pendingMcpServers: SdkMcpServer[] = [];
    try {
      const mcp = await this.startLocalMcpServers(ref);
      pendingMcpServers = mcp.servers;
      const session = await this.runtime.loadSession(providerSessionId, {
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
        appSessionId,
        providerSessionId,
        compactedFromProviderSessionIds: historical?.compactedFromProviderSessionIds ?? [],
        missionId: classification.missionId,
        parentProviderSessionId: classification.parentProviderSessionId,
        sessionPurpose: classification.sessionPurpose,
        interactionMode: classification.interactionMode,
        role: classification.role,
        title:
          stringValue(init.session?.title) ||
          stringValue(init.session?.sessionTitle) ||
          historical?.title ||
          `Session ${providerSessionId.slice(0, 8)}`,
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
        autoCompactions: historical?.autoCompactions,
        maxContextTokens: historical?.maxContextTokens ?? this.maxContextTokensForModel(modelId),
        createdAt: historical?.createdAt ?? now,
        updatedAt: now,
      });
      // Auto-compaction threshold after resume: the current UI settings
      // snapshot wins; failing that, honor a limit the resumed init settings
      // expose, then CLI-file defaults.
      const resumeCompactionLimit = await this.compactionLimit(summary.modelId, {
        compactionTokenLimit: init.settings?.compactionTokenLimit,
        compactionTokenLimitPerModel: init.settings?.compactionTokenLimitPerModel,
      });
      const armed = await this.enableDaemonAutoCompaction(session, resumeCompactionLimit);
      if (armed) summary.compactionTokenLimit = resumeCompactionLimit;
      const mission: LiveSession = this.createLiveSession(summary, session, mcp.servers, mcp.configs);
      this.subscribeSessionCompaction(mission);
      // Seed the spawn->worker links persisted for this mission so historical
      // subagents are recognized (and thus openable/steerable) after a resume,
      // even before any live spawn re-populates knownSubagents.
      for (const link of this.history.subagentLinks(appSessionId)) {
        mission.linkedSubagents.add(link.providerSessionId);
        if (link.toolUseId)
          mission.subagentToolUseIds.set(link.toolUseId, link.providerSessionId);
      }
      this.sessions.set(appSessionId, mission);
      this.history.syncSummaries([summary]);
      this.emit({ type: 'session.created', clientRef: `resume:${appSessionId}`, session: summary });
      this.emit({ type: 'session.updated', session: summary });
      if (features.length)
        this.emit({ type: 'mission.features', appSessionId, missionId: summary.missionId, features });
      void this.refreshContext(appSessionId, session);
    } catch (err) {
      await Promise.all(pendingMcpServers.map((server) => server.close().catch(() => {})));
      this.emitError({ appSessionId, providerSessionId, message: errMsg(err) });
    }
  }

  private listSummaries(): SessionSummary[] {
    return [...this.sessions.values()].map((m) => m.summary);
  }

  private listAllSummaries(options?: SessionListFilterOptions): SessionSummary[] {
    const map = new Map<string, SessionSummary>();
    const cached = this.history.summaryPatches();
    const hiddenProviderSessionIds = this.history.hiddenProviderSessionIds();
    for (const historical of loadHistoricalSessions(options)) {
      if (
        hiddenProviderSessionIds.has(
          historical.summary.providerSessionId ?? historical.summary.appSessionId,
        )
      )
        continue;
      const summary = this.applyPendingSettingsToSummary(
        applyCachedSummary(historical.summary, cached),
      );
      map.set(summary.appSessionId, summary);
    }
    for (const historical of loadHistoricalMissions(options)) {
      if (
        hiddenProviderSessionIds.has(
          historical.summary.providerSessionId ?? historical.summary.appSessionId,
        )
      )
        continue;
      const summary = this.applyPendingSettingsToSummary(
        applyCachedSummary(historical.summary, cached),
      );
      map.set(summary.appSessionId, summary);
    }
    for (const live of this.listSummaries())
      map.set(live.appSessionId, this.applyPendingSettingsToSummary(live));
    return filterSessionListSummaries(
      [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      options,
    );
  }

  private emitSessionList(options?: SessionListFilterOptions): void {
    this.emit({ type: 'sessions.list', sessions: this.listAllSummaries(options) });
  }

  // Annotate persisted subagent links with the live run state from the active
  // mission so a renderer reconnect/reload doesn't render a still-running
  // subagent as finished. Historical (non-live) loads leave status undefined,
  // which the renderer treats as completed.
  private withLiveWorkerStatus(
    appSessionId: string,
    links: ChildSessionHistoryLink[],
  ): ChildSessionHistoryLink[] {
    const session = this.findSession(appSessionId);
    if (!session) return links;
    // A resumed worker that the user has opened is live in session.agents but is
    // not re-added to knownSubagents (that only happens on a live spawn), so
    // check both; otherwise a history reload would render it as completed.
    return links.map((link) =>
      session.knownSubagents.has(link.providerSessionId) ||
      session.agents.has(link.providerSessionId)
        ? {
            ...link,
            status: session.completedSubagents.has(link.providerSessionId)
              ? 'completed'
              : 'running',
          }
        : link,
    );
  }

  // Single emit point for session.history so every page carries restore
  // telemetry (count + whether older history remains) the client uses to show
  // an explicit restoring/partial/complete state.
  private emitSessionHistory(args: {
    appSessionId: string;
    progress: ProgressEntry[];
    transcripts: TranscriptEvent[];
    workers?: ChildSessionHistoryLink[];
    mode: 'replace' | 'prepend';
    olderCursor?: string;
  }): void {
    this.emit({
      type: 'session.history',
      appSessionId: args.appSessionId,
      progress: args.progress,
      transcripts: args.transcripts,
      workers: args.workers,
      mode: args.mode,
      olderCursor: args.olderCursor,
      loadedCount: args.transcripts.length,
      hasMore: Boolean(args.olderCursor),
    });
  }

  private loadSessionHistory(appSessionIdOrProviderSessionId: string, cursor?: string): void {
    const summary = this.resolveSummary(appSessionIdOrProviderSessionId);
    const appSessionId = summary?.appSessionId ?? appSessionIdOrProviderSessionId;
    const providerSessionId =
      summary?.providerSessionId ?? appSessionIdOrProviderSessionId;
    try {
      const history = this.hydrateMissionHistory(appSessionId, providerSessionId, { cursor });
      const transcripts = history.transcripts.map((event) => ({
        ...event,
        appSessionId,
      }));
      transcripts.forEach((event) => this.history.recordEvent(event));
      // An older page only extends the orchestrator scrollback upward; prepend it
      // without touching the already-delivered workers/progress.
      if (cursor) {
        this.emitSessionHistory({
          appSessionId,
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
      this.emitSessionHistory({
        appSessionId,
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
        const chain = resolveSessionChain(appSessionId, providerSessionId);
        if (chain.length === 0)
          throw new Error(`Session history not found for ${providerSessionId}`);
        const window = loadMissionTranscriptWindow(appSessionId, chain, { cursor });
        const transcripts = window.events.map((event) => ({ ...event, appSessionId }));
        transcripts.forEach((event) => this.history.recordEvent(event));
        if (cursor) {
          this.emitSessionHistory({
            appSessionId,
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
        this.emitSessionHistory({
          appSessionId,
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
          this.emitSessionHistory({
            appSessionId,
            progress: [],
            transcripts: [],
            mode: 'prepend',
            olderCursor: undefined,
          });
          return;
        }
        if (this.findSession(appSessionId)) {
          // A live mission with no persisted history yet is an empty (not
          // failed) restore; live events seed it. Answer with an empty
          // authoritative snapshot so the client settles to a loaded state
          // instead of hanging on "Restoring" forever.
          this.emitSessionHistory({
            appSessionId,
            progress: [],
            transcripts: [],
            workers: this.withLiveWorkerStatus(
              appSessionId,
              this.history.subagentLinks(appSessionId),
            ),
            mode: 'replace',
            olderCursor: undefined,
          });
        } else {
          // No live mission to fall back on: signal a restore failure so the
          // client can show a retry affordance instead of a silent blank.
          this.emit({
            type: 'session.history.error',
            appSessionId,
            message: errMsg(err),
          });
          // Recoverable: a restore failure surfaces a toast and the retry
          // affordance (via mission.history.error) but must not mark the session
          // phase failed, so a later successful retry restores it intact.
          this.emitError({
            appSessionId,
            providerSessionId,
            message: errMsg(err),
            recoverable: true,
          });
        }
      }
    }
  }

  private loadHistoryPage(providerSessionId: string, cursor?: string, limit?: number): void {
    const summary = this.resolveSummary(providerSessionId);
    const appSessionId = summary?.appSessionId ?? providerSessionId;
    const resolvedProviderSessionId = summary?.providerSessionId ?? providerSessionId;
    try {
      const page = loadSessionPage(resolvedProviderSessionId, cursor, limit, appSessionId);
      page.events.forEach((event) => this.history.recordEvent(event));
      this.emit({
        type: 'session.history',
        appSessionId,
        progress: [],
        transcripts: page.events,
      });
    } catch (err) {
      this.emitError({
        appSessionId,
        providerSessionId: resolvedProviderSessionId,
        message: errMsg(err),
      });
    }
  }

  private hydrateMissionHistory(
    appSessionId: string,
    providerSessionId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): ReturnType<typeof hydrateHistoricalMission> {
    try {
      return hydrateHistoricalMission(appSessionId, opts);
    } catch {
      return hydrateHistoricalMission(providerSessionId, opts);
    }
  }

  private async createSession(
    cmd: Extract<ClientCommand, { type: 'session.create' }>,
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
      const { modelId: primaryModelId, reasoningEffort: primaryReasoning } =
        createModelDefaultsForMode(mode, cmd, defaults);
      const compactionModel = cmd.compactionModel ?? defaults.compactionModel ?? 'current-model';
      const compactionTokenLimit = effectiveCompactionTriggerLimit({
        modelId: primaryModelId,
        ui: {
          compactionTokenLimit:
            cmd.compactionTokenLimit !== undefined
              ? cmd.compactionTokenLimit
              : this.uiCompactionSettings.compactionTokenLimit,
          compactionTokenLimitPerModel:
            cmd.compactionTokenLimitPerModel ??
            this.uiCompactionSettings.compactionTokenLimitPerModel,
        },
        defaults,
        maxContextTokens: this.maxContextTokensForModel(primaryModelId),
      });
      const { workerModelId, workerReasoningEffort, validatorModelId, validatorReasoningEffort } =
        createMissionAgentDefaultsForMode(mode, cmd, defaults);
      const mcp = await this.startLocalMcpServers(ref);
      pendingMcpServers = mcp.servers;
      const session = await this.runtime.createSession({
        cwd: runtimeCwd,
        interactionMode: mode,
        modelId: primaryModelId,
        autonomyLevel: autonomy,
        reasoningEffort: primaryReasoning,
        // The chat shows one model; when the user picked one explicitly, spec
        // turns must run on it too (spec mode uses specModeModelId), otherwise
        // fall back to the CLI's spec defaults.
        specModeModelId:
          mode === 'spec' || cmd.modelId || cmd.reasoningEffort
            ? primaryModelId
            : defaults.specModelId,
        specModeReasoningEffort:
          mode === 'spec' || cmd.modelId || cmd.reasoningEffort
            ? primaryReasoning
            : defaults.specReasoningEffort,
        decompSessionType: mode === 'agi' ? DecompSessionType.Orchestrator : undefined,
        workerModelId,
        workerReasoningEffort,
        validatorModelId,
        validatorReasoningEffort,
        compactionModel,
        compactionTokenLimit,
        compactionThresholdCheckEnabled: true,
        mcpServers: mcp.configs,
        permissionHandler: this.makePermissionHandler(ref),
        askUserHandler: this.makeAskUserHandler(ref),
      });
      // The createSession init payload above already armed the trigger; this
      // follow-up push is belt and braces, so its outcome does not gate the
      // summary field recorded below.
      await this.enableDaemonAutoCompaction(session, compactionTokenLimit);

      const appSessionId = session.sessionId;
      const now = Date.now();
      const summary: SessionSummary = {
        appSessionId,
        providerSessionId: session.sessionId,
        missionId: mode === 'agi' ? appSessionId : undefined,
        sessionPurpose: cmd.sessionPurpose,
        interactionMode: mode,
        role: 'primary',
        title: cmd.title,
        goal: cmd.goal,
        cwd: appCwd,
        workspaceKind: appCwd ? 'folder' : 'none',
        modelId: primaryModelId,
        reasoningEffort: primaryReasoning,
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
        maxContextTokens: this.maxContextTokensForModel(primaryModelId),
        compactionTokenLimit,
        createdAt: now,
        updatedAt: now,
      };
      ref.id = appSessionId;
      const liveSession = this.createLiveSession(summary, session, mcp.servers, mcp.configs);
      this.subscribeSessionCompaction(liveSession);
      this.sessions.set(appSessionId, liveSession);
      this.history.syncSummaries([summary]);
      this.emit({ type: 'session.created', clientRef: cmd.clientRef, session: summary });
      void this.drive(appSessionId, cmd.goal);
    } catch (err) {
      await Promise.all(pendingMcpServers.map((server) => server.close().catch(() => {})));
      this.emitError({ message: errMsg(err) });
    }
  }

  private createLiveSession(
    summary: SessionSummary,
    session: DroidSession,
    mcpServers: SdkMcpServer[] = [],
    mcpConfigs: Awaited<ReturnType<SdkMcpServer['start']>>[] = [],
  ): LiveSession {
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
      terminalAgents: new Set(),
      linkedSubagents: new Set(),
      subagentToolUseIds: new Map(),
      subagentSettings: new Map(),
      pendingSubagents: [],
      mcpServers,
      mcpConfigs,
      permissionGrants: new Set(),
      autoCompacting: false,
    };
  }

  private makePermissionHandler(ref: { id: string }): PermissionHandler {
    return (params: RequestPermissionRequestParams) =>
      new Promise<RequestPermissionHandlerResult>((resolve) => {
        const mission = this.findSession(ref.id);
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
        this.emit({ type: 'approval.requested', request });
      });
  }

  private makeAskUserHandler(ref: { id: string }): AskUserHandler {
    return (params: AskUserRequestParams) =>
      new Promise<AskUserResult>((resolve) => {
        const mission = this.findSession(ref.id);
        const requestId = nextRequestId();
        const questions = (params.questions ?? []).map((q) => ({
          index: q.index,
          question: q.question,
          options: q.options ?? [],
        }));
        if (mission) mission.pendingQuestions.set(requestId, resolve);
        const question = { appSessionId: ref.id, requestId, questions };
        this.emit({ type: 'question.requested', question });
      });
  }

  private async resolvePermission(
    missionId: string,
    requestId: string,
    outcome: string,
  ): Promise<void> {
    const mission = this.findSession(missionId);
    const pending = mission?.pendingPermissions.get(requestId);
    if (!mission || !pending) return;
    mission.pendingPermissions.delete(requestId);
    let normalized: RequestPermissionHandlerResult;
    try {
      normalized = normalizePermissionOutcome(outcome);
    } catch (err) {
      this.emitError({
        code: 'permission.invalid_outcome',
        appSessionId: missionId,
        message: errMsg(err),
      });
      normalized = normalizePermissionOutcome('cancel');
    }
    if (pending.signature && isAlwaysOutcome(outcome)) {
      mission.permissionGrants.add(pending.signature);
    }
    if (pending.kind === 'spec' && isApprovalOutcome(normalized))
      await this.prepareSpecExitForRun(mission);
    pending.resolve(normalized);
  }

  private async prepareSpecExitForRun(mission: LiveSession): Promise<void> {
    const appSessionId = mission.summary.appSessionId;
    this.patch(appSessionId, { interactionMode: 'auto', phase: 'running' });
    try {
      await mission.session.updateSettings({ interactionMode: DroidInteractionMode.Auto } as never);
    } catch (err) {
      this.emitError({
        code: 'spec.exit_failed',
        appSessionId,
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
    const mission = this.findSession(missionId);
    const resolver = mission?.pendingQuestions.get(requestId);
    if (!mission || !resolver) return;
    mission.pendingQuestions.delete(requestId);
    resolver({ cancelled, answers });
  }

  private async drive(missionId: string, prompt: string): Promise<void> {
    const mission = this.findSession(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.appSessionId;
    mission.streaming = true;
    mission.terminalAgents.delete(appSessionId);
    this.patch(appSessionId, {
      phase: mission.summary.sessionPurpose === 'mission-control' ? 'planning' : 'running',
      streaming: true,
      queuedSends: mission.pendingSends.length,
    });
    this.startContextPolling(appSessionId, mission.session);
    await this.applyDesignToolPolicy(mission, isDesignPrompt(prompt));
    try {
      const stream = mission.session.stream(prompt, { includePartialMessages: true });
      for await (const ev of stream)
        this.applyEvent(appSessionId, appSessionId, 'primary', ev);
    } catch (err) {
      if (mission.interruptingForSteer)
        this.emitStatus(appSessionId, 'Current turn interrupted for steering.');
      else if (mission.interrupting && isUserCancellation(err))
        // The user pressed Stop; interrupt() already set the paused phase, so
        // settle quietly without surfacing an error.
        this.patch(appSessionId, { phase: 'paused' });
      else {
        this.emitError({ appSessionId, message: errMsg(err) });
        this.patch(appSessionId, { phase: 'failed' });
      }
    } finally {
      this.stopContextPolling(appSessionId);
      mission.interruptingForSteer = false;
      mission.interrupting = false;
      // Keep streaming=true while refreshContext is in flight so concurrent
      // sends queue instead of racing a second drive().
      await this.refreshContext(appSessionId, mission.session);
      mission.streaming = false;
      if (!this.findSession(appSessionId)) {
        // A manual compaction's stale-swap recovery (or a concurrent close) can
        // drop the live mission. A drive() against the now-missing mission would
        // silently discard the queued sends, so re-deliver them through the
        // resume path instead.
        const queued = mission.pendingSends.splice(0);
        if (queued.length > 0) void this.redeliverQueuedSends(appSessionId, queued);
      } else {
        if (mission.autoCompacting) {
          // The turn is over, so any mid-turn compaction already finished; if
          // the completion notification got lost, settle quickly instead of
          // holding queued sends until the long start-of-compaction watchdog.
          this.autoCompactionWatchdogs.arm(appSessionId, POST_TURN_AUTO_COMPACTION_WATCHDOG_MS);
          this.patch(appSessionId, { streaming: false, queuedSends: mission.pendingSends.length });
        } else {
          const next = mission.pendingSends.shift();
          this.patch(appSessionId, { streaming: false, queuedSends: mission.pendingSends.length });
          if (next !== undefined) void this.drive(appSessionId, next);
        }
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
          appSessionId: missionId,
          message: `Could not deliver a queued message after compaction recovery: ${errMsg(err)}`,
        });
      }
    }
  }

  // Design turns are a single focused task (extra prompts queue), so the model
  // does not need TodoWrite — it otherwise loops updating the list after it has
  // already answered. Disable TodoWrite for design turns and restore it for
  // normal turns, calling updateSettings only when the policy changes.
  private async applyDesignToolPolicy(mission: LiveSession, design: boolean): Promise<void> {
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
        appSessionId: mission.summary.appSessionId,
        message: `Could not update design tool policy: ${errMsg(err)}`,
      });
    }
  }

  private applyEvent(
    missionId: string,
    agentSessionId: string,
    role: SessionRole,
    ev: Parameters<typeof normalizeStreamEvent>[3],
  ): void {
    const n = normalizeStreamEvent(missionId, agentSessionId, role, ev);
    if (!n) return;
    this.applyNormalizedForAgent(missionId, agentSessionId, n);
  }

  // Single live entry point that enforces per-turn terminal gating before
  // applying a normalized event. Both the orchestrator/worker stream loops and
  // the worker notification subscriptions route through here so post-terminal
  // generation is dropped no matter which channel delivers it. History replay
  // does not pass through this path (it uses emitTranscript directly).
  private applyNormalizedForAgent(
    missionId: string,
    agentSessionId: string,
    n: NonNullable<ReturnType<typeof normalizeStreamEvent>>,
  ): void {
    const mission = this.findSession(missionId);
    if (mission) {
      // The first `result` of a streaming turn is its terminal final. Mark the
      // producing session terminal so any further model generation in the same
      // turn is dropped, keeping one final response per turn.
      if (n.done) {
        mission.terminalAgents.add(agentSessionId);
        return;
      }
      // After terminal, quarantine only this session's model-generated chat/tool
      // transcript. Any side effects attached to the same event (a subagent
      // spawn/completion, tokens, mission state) and errors still flow.
      if (mission.terminalAgents.has(agentSessionId) && isPostTerminalGeneration(n)) {
        const { transcript: _quarantined, ...sideEffects } = n;
        if (hasNormalizedSideEffects(sideEffects))
          this.applyNormalized(missionId, sideEffects, agentSessionId);
        return;
      }
    }
    this.applyNormalized(missionId, n, agentSessionId);
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
    const mission = this.findSession(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.appSessionId;
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
      type: 'session.child',
      appSessionId,
      event: 'started',
      providerSessionId: sessionId,
      label,
      prompt,
      toolUseId,
    });
    if (prompt) {
      this.emitTranscript({
        id: `subagent-task-${sessionId}`,
        appSessionId,
        sourceSessionId: sessionId,
        role: 'worker',
        ts: Date.now(),
        kind: 'status',
        text: `Task prompt\n\n${prompt}`,
      });
    }
    this.emit({
      type: 'child.updated',
      appSessionId,
      providerSessionId: sessionId,
      role: 'worker',
      status: 'running',
    });
  }

  private takePendingSubagent(mission: LiveSession, sub: PendingSubagent): PendingSubagent | undefined {
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

  private completeSubagentForToolUse(mission: LiveSession, toolUseId: string): void {
    const sessionId = mission.subagentToolUseIds.get(toolUseId);
    if (sessionId) this.completeSubagent(mission, sessionId);
  }

  private completeSubagent(mission: LiveSession, sessionId: string): void {
    if (!mission.knownSubagents.has(sessionId) || mission.completedSubagents.has(sessionId)) return;
    const appSessionId = mission.summary.appSessionId;
    mission.completedSubagents.add(sessionId);
    const settings = mission.subagentSettings.get(sessionId) ?? {};
    this.emit({
      type: 'session.child',
      appSessionId,
      event: 'completed',
      providerSessionId: sessionId,
      ...settings,
    });
    this.emit({
      type: 'child.updated',
      appSessionId,
      providerSessionId: sessionId,
      role: 'worker',
      status: 'completed',
    });
    void this.closeAgentWhenIdle(appSessionId, sessionId);
  }

  private applyNormalized(
    missionId: string,
    n: NonNullable<ReturnType<typeof normalizeStreamEvent>>,
    agentSessionId?: string,
  ): void {
    if (n.transcript) this.emitTranscript(n.transcript);
    if (n.features) {
      this.patch(missionId, { features: n.features });
      const missionControlId = this.findSession(missionId)?.summary.missionId;
      this.emit({
        type: 'mission.features',
        appSessionId: missionId,
        missionId: missionControlId,
        features: n.features,
      });
    }
    if (n.progress) {
      const missionControlId = this.findSession(missionId)?.summary.missionId;
      this.emit({
        type: 'mission.progress',
        appSessionId: missionId,
        missionId: missionControlId,
        entries: n.progress,
      });
    }
    if (n.missionState) {
      const phase = STATE_TO_PHASE[n.missionState];
      if (phase) this.patch(missionId, { phase });
    }
    if (n.worker) {
      this.emit({
        type: 'session.child',
        appSessionId: missionId,
        event: n.worker.event,
        providerSessionId: n.worker.workerSessionId,
        exitCode: n.worker.exitCode,
      });
      this.emit({
        type: 'child.updated',
        appSessionId: missionId,
        providerSessionId: n.worker.workerSessionId,
        role: 'worker',
        status: n.worker.event === 'completed' ? 'completed' : 'running',
      });
      if (n.worker.event === 'completed')
        void this.closeAgentWhenIdle(missionId, n.worker.workerSessionId);
    }
    if (n.subagent) this.applySubagent(missionId, n.subagent);
    if (n.tokens) {
      const m = this.findSession(missionId);
      if (m) {
        const appSessionId = m.summary.appSessionId;
        const offset = this.usageOffsets.get(appSessionId);
        m.summary.tokensIn = n.tokens.tokensIn + (offset?.tokensIn ?? 0);
        m.summary.tokensOut = n.tokens.tokensOut + (offset?.tokensOut ?? 0);
        // The summary's context reading belongs to the primary session
        // only. Worker turns still update the running totals above, but their
        // context usage must never land on the summary: it would repaint the
        // mission meter with the worker's window, and a leftover 'exact'
        // marker would make refreshContext pin the meter there. Workers get
        // their own context.updated snapshots keyed by their session id.
        const fromOrchestrator = agentSessionId === undefined || agentSessionId === missionId;
        if (fromOrchestrator) {
          m.summary.contextTokens = n.tokens.contextTokens;
          // Provider-reported usage of the last call is exactly what the
          // daemon's compaction threshold checks: the authoritative reading.
          if (n.tokens.contextTokens > 0) {
            m.summary.contextAccuracy = 'exact';
            m.summary.contextUpdatedAt = new Date().toISOString();
          }
          // Keep the last known window when the catalog cannot resolve the
          // model (e.g. Default): deleting it here made the meter flip between
          // "no max" and the stats limit on every token event.
          const maxContextTokens = this.maxContextTokensForSummary(m.summary);
          if (maxContextTokens !== undefined) m.summary.maxContextTokens = maxContextTokens;
          this.emitContextEstimate(appSessionId, m.summary);
        }
        this.emit({
          type: 'session.updated',
          session: { ...m.summary, updatedAt: Date.now() },
        });
      }
    }
  }

  private emitTranscript(event: TranscriptEvent): void {
    this.history.recordEvent(event);
    this.emit({ type: 'event.appended', event });
  }

  private emitStatus(
    missionId: string,
    text: string,
    compactType?: CompactType,
    agentSessionId?: string,
    role: SessionRole = 'primary',
  ): void {
    this.emitTranscript({
      id: `status-${Date.now().toString(36)}-${(this.statusSeq++).toString(36)}`,
      appSessionId: missionId,
      sourceSessionId: agentSessionId ?? missionId,
      role,
      ts: Date.now(),
      kind: 'status',
      text,
      compactType,
    });
  }

  // Subscribe the primary session to raw daemon notifications so the
  // daemon's in-place auto-compaction surfaces in the transcript. Everything
  // else the orchestrator needs already arrives through the streaming turn, so
  // only compaction notifications are handled here.
  private subscribeSessionCompaction(mission: LiveSession): void {
    const session = mission.session;
    mission.unsubscribe?.();
    mission.unsubscribe = session.onNotification((note: Record<string, unknown>) => {
      // The daemon emits the same compacting/compacted notifications during a
      // manual compactSession RPC; runCompaction owns that path's statuses and
      // refresh, so reacting here too would duplicate them.
      if (mission.compacting) return;
      const appSessionId = mission.summary.appSessionId;
      this.handleCompactionNotification(appSessionId, appSessionId, 'primary', session, note);
    });
  }

  // Surface a daemon auto-compaction (in place, same session id): a start
  // status drives the compacting shimmer and the completion status clears it,
  // then the context meter is refreshed against the compacted window. Returns
  // whether the notification was a compaction event.
  private handleCompactionNotification(
    missionId: string,
    agentSessionId: string,
    role: SessionRole,
    session: DroidSession,
    note: Record<string, unknown>,
  ): boolean {
    return runCompactionNotification(
      this.compactionHost(),
      missionId,
      agentSessionId,
      role,
      session,
      note,
    );
  }

  private onAutoCompactionWatchdogExpired(sessionKey: string): void {
    settleExpiredAutoCompaction(this.compactionHost(), sessionKey);
  }

  private compactionHost(): AutoCompactionHost<LiveAgent, LiveSession, DroidSession> {
    return {
      watchdogs: this.autoCompactionWatchdogs,
      sessions: () => this.sessions.values(),
      findSession: (appSessionId) => this.findSession(appSessionId),
      agentCompactions: this.agentCompactions,
      emitCompactionStatus: (appSessionId, text, providerSessionId, role) =>
        this.emitStatus(appSessionId, text, 'auto', providerSessionId, role),
      patchSummary: (appSessionId, patch) => this.patch(appSessionId, patch),
      refreshContext: (providerSessionId, session) =>
        this.refreshContext(providerSessionId, session),
      drive: (appSessionId, text) => this.drive(appSessionId, text),
      driveAgent: (agent, text) => this.driveAgent(agent, text),
      closeAgent: (appSessionId, providerSessionId) =>
        this.closeAgent(appSessionId, providerSessionId),
      emitAgentPaused: (agent) =>
        this.emit({
          type: 'child.updated',
          appSessionId: agent.appSessionId,
          providerSessionId: agent.session.sessionId,
          role: agent.role,
          status: 'paused',
        }),
    };
  }

  private async compactSession(
    sessionId: string,
    customInstructions?: string,
    compactType: CompactType = 'manual',
  ): Promise<void> {
    const mission = this.findSession(sessionId);
    if (mission) {
      await this.compactMission(mission, customInstructions, compactType);
      return;
    }
    await this.compactHistoricalSession(sessionId, customInstructions);
  }

  // Orchestrator (live chat) compaction. Runs the shared in-place path; if the
  // daemon returns a new backing id the `reload` hook swaps the session while
  // keeping the stable app id (summary.appSessionId) so the visible chat is unchanged.
  private async compactMission(
    mission: LiveSession,
    customInstructions: string | undefined,
    compactType: CompactType,
  ): Promise<void> {
    const appSessionId = mission.summary.appSessionId;
    const preCompactSessionId = mission.summary.providerSessionId;
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
              providerSessionId: mission.summary.providerSessionId,
              appSessionId,
              message: `Could not compact session: ${message}`,
              recoverable: true,
            }),
          refresh: () => {
            // The pre-compaction exact reading would otherwise override the
            // refreshed estimate; and when the daemon compacted in place (no
            // swap, so no compactedFromProviderSessionIds bump) the meter's ratchet
            // needs the generation counter to move to accept the lower value.
            const live = this.findSession(appSessionId);
            if (live) {
              this.patch(appSessionId, {
                contextTokens: 0,
                contextAccuracy: undefined,
                ...(live.summary.providerSessionId === preCompactSessionId
                  ? { autoCompactions: (live.summary.autoCompactions ?? 0) + 1 }
                  : {}),
              });
            }
            return this.refreshContext(appSessionId, mission.session);
          },
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
    mission: LiveSession,
    newSessionId: string,
    carryover: UsageOffset,
  ): Promise<void> {
    const appSessionId = mission.summary.appSessionId;
    const compactedFromProviderSessionIds = uniqueStrings([
      ...(mission.summary.compactedFromProviderSessionIds ?? []),
      mission.summary.providerSessionId,
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
    this.subscribeSessionCompaction(mission);
    // Settings live on the daemon session, not the persisted file, so the
    // replacement session starts without the auto-compaction threshold check.
    // Re-push it; a failure must not turn a successful swap into a stale one.
    await this.recomputeSessionCompactionLimit(mission).catch(() => {});
    // The replacement session starts with default tool settings, so the cached
    // design-tool policy no longer reflects reality. Clear it so the next turn
    // re-synchronizes disabledToolIds.
    mission.todoDisabledForDesign = undefined;
    await oldSession.close().catch(() => {});
    this.usageOffsets.set(appSessionId, carryover);
    this.patch(appSessionId, {
      providerSessionId: newSessionId,
      compactedFromProviderSessionIds,
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
    mission: LiveSession,
    newSessionId: string,
    carryover: UsageOffset,
  ): Promise<void> {
    const appSessionId = mission.summary.appSessionId;
    try {
      await this.swapMissionSession(mission, newSessionId, carryover);
      return;
    } catch {
      /* adoption still failing; persist the new id and drop the mission below */
    }
    this.patch(appSessionId, {
      providerSessionId: newSessionId,
      compactedFromProviderSessionIds: uniqueStrings([
        ...(mission.summary.compactedFromProviderSessionIds ?? []),
        mission.summary.providerSessionId,
      ]),
      tokensIn: carryover.tokensIn,
      tokensOut: carryover.tokensOut,
      contextTokens: 0,
    });
    await this.closeSession(appSessionId);
    // closeMission clears the usage offset for this app id, so seed it AFTER the
    // teardown: when the next message re-resumes against the compacted backing
    // session (whose token counts restart low), the carried-over totals are
    // added back instead of the displayed usage collapsing to the new segment.
    this.usageOffsets.set(appSessionId, carryover);
    this.emitError({
      appSessionId,
      providerSessionId: newSessionId,
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
    const oldProviderSessionId = historical?.providerSessionId ?? sessionId;
    try {
      const result = await this.withSession(sessionId, (session) =>
        session.compactSession(customInstructions ? { customInstructions } : {}),
      );
      if (!result) return;
      const newSessionId = result.newSessionId || oldProviderSessionId;
      if (newSessionId !== oldProviderSessionId && historical) {
        const updated = {
          ...historical,
          providerSessionId: newSessionId,
          compactedFromProviderSessionIds: uniqueStrings([
            ...(historical.compactedFromProviderSessionIds ?? []),
            oldProviderSessionId,
          ]),
          updatedAt: Date.now(),
        };
        this.history.syncSummaries([updated]);
        this.emit({ type: 'session.updated', session: updated });
      }
    } catch (err) {
      this.emitError({
        providerSessionId: oldProviderSessionId,
        appSessionId: historical?.appSessionId ?? sessionId,
        message: `Could not compact session: ${errMsg(err)}`,
      });
    }
  }

  private async send(missionId: string, text: string): Promise<void> {
    let mission = this.findSession(missionId);
    if (!mission) {
      await this.resumeSession(missionId);
      mission = this.findSession(missionId);
    }
    if (!mission) {
      this.emitError({ appSessionId: missionId, message: `Session ${missionId} is not resumable` });
      return;
    }
    const appSessionId = mission.summary.appSessionId;
    if (!(await this.applyPendingSessionSettings(appSessionId))) return;
    if (mission.streaming || mission.compacting || mission.autoCompacting) {
      mission.pendingSends.push(text);
      this.patch(appSessionId, { queuedSends: mission.pendingSends.length });
      return;
    }
    await this.drive(appSessionId, text);
  }

  private async sendNow(missionId: string, text: string): Promise<void> {
    let mission = this.findSession(missionId);
    if (!mission) {
      await this.resumeSession(missionId);
      mission = this.findSession(missionId);
    }
    if (!mission) {
      this.emitError({ appSessionId: missionId, message: `Session ${missionId} is not resumable` });
      return;
    }
    const appSessionId = mission.summary.appSessionId;
    if (!(await this.applyPendingSessionSettings(appSessionId))) return;
    if (!mission.streaming && !mission.compacting && !mission.autoCompacting) {
      await this.drive(appSessionId, text);
      return;
    }
    // Run next after the in-flight turn/compaction; never interrupt a compaction
    // (driving or interrupting against it risks a failed compaction or lost steering).
    mission.pendingSends.unshift(text);
    this.patch(appSessionId, { queuedSends: mission.pendingSends.length });
    if (mission.compacting || mission.autoCompacting) return;
    mission.interruptingForSteer = true;
    this.emitStatus(appSessionId, 'Steering now...');
    try {
      await mission.session.interrupt();
    } catch (err) {
      mission.interruptingForSteer = false;
      this.emitError({
        code: 'session.send_now_failed',
        appSessionId,
        message: `Could not interrupt session for steering: ${errMsg(err)}`,
      });
    }
  }

  private async setAutonomy(missionId: string, autonomy: Autonomy | 'none'): Promise<void> {
    const mission = this.findSession(missionId);
    if (!mission) {
      this.emitError({
        appSessionId: missionId,
        message: 'Autonomy can only be changed on a live session.',
      });
      return;
    }
    const appSessionId = mission.summary.appSessionId;
    const nextAutonomy = normalizeAutonomy(autonomy);
    if (!nextAutonomy) {
      this.emitError({
        appSessionId,
        message: `Unsupported autonomy level: ${autonomy}`,
      });
      return;
    }
    try {
      await mission.session.updateSettings({ autonomyLevel: nextAutonomy } as never);
      this.patch(appSessionId, { autonomy: nextAutonomy });
    } catch (err) {
      this.emitError({
        appSessionId,
        message: `Could not change autonomy: ${errMsg(err)}`,
      });
    }
  }

  private async setInteractionMode(missionId: string, mode: SessionInteractionMode): Promise<void> {
    const mission = this.findSession(missionId);
    if (!mission) {
      this.emitError({
        appSessionId: missionId,
        message: 'Spec mode can only be toggled on a live session.',
      });
      return;
    }
    const appSessionId = mission.summary.appSessionId;
    try {
      if (mode === 'spec') {
        await mission.session.enterSpecMode();
        await this.alignSpecModeModel(mission);
      } else {
        await mission.session.updateSettings({ interactionMode: DroidInteractionMode.Auto });
      }
      this.patch(appSessionId, {
        interactionMode: mode,
        sessionPurpose: mode === 'agi' ? 'mission-control' : mission.summary.sessionPurpose,
        missionId: mode === 'agi' ? (mission.summary.missionId ?? appSessionId) : undefined,
      });
    } catch (err) {
      this.emitError({
        appSessionId,
        message: `Could not switch interaction mode: ${errMsg(err)}`,
      });
    }
  }

  // Best effort: spec-mode turns run on specModeModelId, which the daemon may
  // have seeded from the CLI spec default at create time. Align it with the
  // chat's visible model so toggling into spec never switches models silently.
  private async alignSpecModeModel(mission: LiveSession): Promise<void> {
    const { modelId, reasoningEffort } = mission.summary;
    if (!modelId) return;
    const specSettings: Record<string, unknown> = { specModeModelId: modelId };
    if (reasoningEffort) specSettings.specModeReasoningEffort = reasoningEffort;
    try {
      await mission.session.updateSettings(specSettings as never);
    } catch {
      /* older daemons may reject the setting; spec mode still works on its default model */
    }
  }

  private async updateSessionSettings(
    sessionId: string,
    settings: {
      modelId?: string | null;
      reasoningEffort?: ReasoningEffort;
    },
  ): Promise<void> {
    const mission = this.findSession(sessionId);
    const historical = this.resolveSummary(sessionId);
    const appSessionId = mission?.summary.appSessionId ?? historical?.appSessionId ?? sessionId;
    const patch: Partial<SessionSummary> = {};
    const next: Record<string, unknown> = {};
    if (settings.modelId !== undefined) {
      // A null model means "reset to Default". The daemon has no such notion,
      // so resolve the actual default and push it; silently dropping the update
      // would leave the daemon generating with the previously selected model.
      // specModeModelId mirrors it because spec-mode turns run on that setting.
      const summaryForMode = mission?.summary ?? historical;
      const effectiveModelId =
        settings.modelId ??
        defaultModelForAgent(
          'primary',
          summaryForMode ? modeForSummary(summaryForMode) : 'auto',
          await this.getFactoryDefaults(),
        );
      if (effectiveModelId) {
        next.modelId = effectiveModelId;
        next.specModeModelId = effectiveModelId;
      }
      patch.modelId = settings.modelId ?? undefined;
      patch.maxContextTokens = this.maxContextTokensForModel(settings.modelId ?? undefined);
    }
    if (settings.reasoningEffort) {
      next.reasoningEffort = settings.reasoningEffort;
      next.specModeReasoningEffort = settings.reasoningEffort;
      patch.reasoningEffort = settings.reasoningEffort;
    }
    if (Object.keys(next).length === 0) return;
    const session = await this.withSession(appSessionId, async (activeSession) => {
      await activeSession.updateSettings(next as never);
      return activeSession;
    });
    if (mission) this.patch(appSessionId, patch);
    if (mission && settings.modelId !== undefined) {
      // The model drives the auto-compaction threshold; recompute it so the
      // daemon doesn't keep compacting against the old model's limit.
      await this.recomputeSessionCompactionLimit(mission);
    }
    if (mission && session) await this.refreshContext(appSessionId, session);
  }

  private async interrupt(missionId: string): Promise<void> {
    const mission = this.findSession(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.appSessionId;
    mission.pendingSends = [];
    // Never interrupt an in-flight manual compaction (it risks a failed/
    // corrupt swap). Dropping queued sends is enough; compaction finishes on
    // its own and its drive()/command drain then settles streaming/phase.
    if (mission.compacting) {
      this.patch(appSessionId, { queuedSends: 0 });
      return;
    }
    // A user interrupt is the escape hatch for a wedged in-place
    // auto-compaction: interrupt for real, then settle the flag. The flag and
    // its watchdog are only cleared once the interrupt actually landed; if it
    // throws they stay in place so the watchdog can still settle the session.
    const wasAutoCompacting = mission.autoCompacting;
    // Mark the in-flight turn as user-interrupted so drive()'s stream catch
    // settles the abort quietly instead of surfacing it as a failure. drive()'s
    // finally clears the flag once the turn unwinds.
    mission.interrupting = true;
    await mission.session.interrupt();
    if (wasAutoCompacting) {
      mission.autoCompacting = false;
      this.autoCompactionWatchdogs.clear(appSessionId);
    }
    // If no drive() is active (Stop while idle or between turns), nothing will
    // run the finally that clears the flag — clear it here so it can't persist
    // and misclassify a later turn's cancellation as a user Stop.
    if (!mission.streaming) mission.interrupting = false;
    this.patch(appSessionId, { phase: 'paused', streaming: false, queuedSends: 0 });
  }

  private async openAgent(
    missionId: string,
    agentSessionId: string,
    role: SessionRole,
  ): Promise<void> {
    const mission = this.findSession(missionId);
    if (!mission) {
      // No live mission to open against (e.g. a not-yet-resumed/historical
      // session). Settle the worker's loading state with an honest empty open
      // instead of leaving its card spinning forever.
      this.emit({
        type: 'child.updated',
        appSessionId: missionId,
        providerSessionId: agentSessionId,
        role,
        status: 'opened',
      });
      return;
    }
    const appSessionId = mission.summary.appSessionId;
    if (!this.agentBelongsToMission(mission, agentSessionId)) {
      this.emit({
        type: 'child.updated',
        appSessionId,
        providerSessionId: agentSessionId,
        role,
        status: 'opened',
      });
      return;
    }
    if (mission.agents.has(agentSessionId)) {
      const agent = mission.agents.get(agentSessionId);
      if (agent) agent.lastUsedAt = Date.now();
      this.emit({
        type: 'child.updated',
        appSessionId,
        providerSessionId: agentSessionId,
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
        mission.summary.sessionPurpose !== 'mission-control';
      const resolvedSettings: SubagentSettings = inheritsSessionModel
        ? {
            modelId: actualSettings.modelId ?? mission.summary.modelId,
            reasoningEffort: actualSettings.reasoningEffort ?? mission.summary.reasoningEffort,
          }
        : actualSettings;
      if (resolvedSettings.modelId || resolvedSettings.reasoningEffort) {
        mission.subagentSettings.set(agentSessionId, resolvedSettings);
        this.emit({
          type: 'session.child',
          appSessionId,
          event: 'updated',
          providerSessionId: agentSessionId,
          ...resolvedSettings,
        });
      }
      // When the loaded agent session doesn't report its own model, fall back to
      // the role's configured model (not the primary's), so per-model limits
      // and context-window clamps stay correct for differing worker/validator models.
      const workerModelId =
        resolvedSettings.modelId ?? this.agentModelId(mission, agentSessionId, role);
      // Workers auto-compact in place via the daemon's own threshold check,
      // using the worker model's effective limit (so differing worker/validator
      // models keep their own thresholds).
      await this.enableDaemonAutoCompaction(session, await this.compactionLimit(workerModelId));
      const agent: LiveAgent = {
        session,
        providerSessionId: agentSessionId,
        appSessionId,
        role,
        streaming: false,
        autoCompacting: false,
        pendingSends: [],
        lastUsedAt: Date.now(),
      };
      agent.unsubscribe = session.onNotification((note: Record<string, unknown>) => {
        // The daemon's auto-compaction notifications are handled by
        // handleCompactionNotification, which owns the agent's status and
        // refresh; any other notification is normalized and applied here.
        if (this.handleCompactionNotification(appSessionId, agentSessionId, role, session, note))
          return;
        for (const n of normalizeNotification(appSessionId, agentSessionId, role, note))
          this.applyNormalizedForAgent(appSessionId, agentSessionId, n);
      });
      mission.agents.set(agentSessionId, agent);
      this.emitAgentHistory(appSessionId, agentSessionId);
      this.emit({
        type: 'child.updated',
        appSessionId,
        providerSessionId: agentSessionId,
        role,
        status: 'opened',
      });
    } catch (err) {
      this.emit({
        type: 'error',
        code: 'agent.open_failed',
        appSessionId,
        providerSessionId: agentSessionId,
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
    const mission = this.findSession(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.appSessionId;
    if (!this.agentBelongsToMission(mission, agentSessionId)) return;
    if (!mission.agents.has(agentSessionId))
      await this.openAgent(appSessionId, agentSessionId, 'worker');
    const agent = mission.agents.get(agentSessionId);
    if (!agent) return;
    agent.lastUsedAt = Date.now();
    if (agent.streaming || agent.autoCompacting) {
      agent.pendingSends.push(text);
      return;
    }
    await this.driveAgent(agent, text);
  }

  private async driveAgent(agent: LiveAgent, text: string): Promise<void> {
    agent.streaming = true;
    agent.lastUsedAt = Date.now();
    this.findSession(agent.appSessionId)?.terminalAgents.delete(agent.session.sessionId);
    this.emit({
      type: 'child.updated',
      appSessionId: agent.appSessionId,
      providerSessionId: agent.session.sessionId,
      role: agent.role,
      status: 'running',
    });
    this.startContextPolling(agent.session.sessionId, agent.session);
    try {
      const stream = agent.session.stream(text, { includePartialMessages: true });
      for await (const ev of stream)
        this.applyEvent(agent.appSessionId, agent.session.sessionId, agent.role, ev);
    } catch (err) {
      if (agent.interruptingForSteer)
        this.emitStatus(agent.appSessionId, 'Subagent turn interrupted for steering.');
      else if (!(agent.interrupting && isUserCancellation(err))) {
        const message = errMsg(err);
        this.emit({
          type: 'child.not_steerable',
          appSessionId: agent.appSessionId,
          providerSessionId: agent.session.sessionId,
          message,
        });
        this.emit({
          type: 'error',
          code: 'agent.not_steerable',
          appSessionId: agent.appSessionId,
          providerSessionId: agent.session.sessionId,
          message,
        });
      }
    } finally {
      this.stopContextPolling(agent.session.sessionId);
      agent.interruptingForSteer = false;
      agent.interrupting = false;
      if (agent.pendingSends.length === 0 && agent.closeWhenIdle && !agent.autoCompacting) {
        agent.streaming = false;
        // closeAgent resolves the worker by the agents-map id, which is not
        // guaranteed to match the live session id.
        await this.closeAgent(agent.appSessionId, agent.providerSessionId);
      } else {
        // Refresh while streaming stays true so concurrent sends queue instead
        // of racing a second driveAgent(). The daemon auto-compacts the worker
        // in place (same session id), so no swap handling is needed here.
        await this.refreshContext(agent.session.sessionId, agent.session);
        agent.streaming = false;
        if (agent.autoCompacting) {
          // Key by the agents-map id: every other watchdog op (initial arm,
          // interrupt, close, expiry lookup) uses it, so the tightened timer
          // actually replaces the 5-minute one.
          this.autoCompactionWatchdogs.arm(
            agent.providerSessionId,
            POST_TURN_AUTO_COMPACTION_WATCHDOG_MS,
          );
          return;
        }
        const next = agent.pendingSends.shift();
        if (next !== undefined) void this.driveAgent(agent, next);
        else
          this.emit({
            type: 'child.updated',
            appSessionId: agent.appSessionId,
            providerSessionId: agent.session.sessionId,
            role: agent.role,
            status: 'paused',
          });
      }
    }
  }

  private async sendAgentNow(
    missionId: string,
    agentSessionId: string,
    text: string,
  ): Promise<void> {
    const mission = this.findSession(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.appSessionId;
    if (!this.agentBelongsToMission(mission, agentSessionId)) return;
    if (!mission.agents.has(agentSessionId))
      await this.openAgent(appSessionId, agentSessionId, 'worker');
    const agent = mission.agents.get(agentSessionId);
    if (!agent) return;
    agent.lastUsedAt = Date.now();
    if (!agent.streaming && !agent.autoCompacting) {
      await this.driveAgent(agent, text);
      return;
    }
    agent.pendingSends.unshift(text);
    if (agent.autoCompacting) return;
    agent.interruptingForSteer = true;
    this.emitStatus(appSessionId, 'Steering subagent now...');
    try {
      await agent.session.interrupt();
    } catch (err) {
      agent.interruptingForSteer = false;
      this.emit({
        type: 'error',
        code: 'agent.send_now_failed',
        appSessionId,
        providerSessionId: agentSessionId,
        message: `Could not interrupt subagent for steering: ${errMsg(err)}`,
      });
    }
  }

  private async interruptAgent(missionId: string, agentSessionId: string): Promise<void> {
    const mission = this.findSession(missionId);
    if (!mission) return;
    const appSessionId = mission.summary.appSessionId;
    if (!this.agentBelongsToMission(mission, agentSessionId)) return;
    if (!mission.agents.has(agentSessionId))
      await this.openAgent(appSessionId, agentSessionId, 'worker');
    const agent = mission.agents.get(agentSessionId);
    if (!agent) return;
    agent.pendingSends = [];
    agent.lastUsedAt = Date.now();
    // Same escape hatch as the primary session: interrupt first, and settle the
    // wedged auto-compaction flag only once the interrupt landed.
    const wasAutoCompacting = agent.autoCompacting;
    agent.interrupting = true;
    await agent.session.interrupt();
    if (wasAutoCompacting) {
      agent.autoCompacting = false;
      this.autoCompactionWatchdogs.clear(agentSessionId);
    }
    // If no driveAgent() is active to clear the flag in its finally, clear it
    // here so it can't leak into a later turn and misclassify its cancellation.
    if (!agent.streaming) agent.interrupting = false;
    agent.streaming = false;
    this.emit({
      type: 'child.updated',
      appSessionId,
      providerSessionId: agentSessionId,
      role: agent.role,
      status: 'paused',
    });
  }

  private agentBelongsToMission(mission: LiveSession, agentSessionId: string): boolean {
    if (mission.summary.sessionPurpose === 'mission-control') return true;
    if (mission.knownSubagents.has(agentSessionId)) return true;
    if (mission.linkedSubagents.has(agentSessionId)) return true;
    const appSessionId = mission.summary.appSessionId;
    this.emit({
      type: 'error',
      code: 'agent.not_in_session',
      appSessionId,
      providerSessionId: agentSessionId,
      message: `Subagent ${agentSessionId} is not tied to session ${appSessionId}.`,
    });
    return false;
  }

  private async ensureAgentCapacity(
    mission: LiveSession,
    requestedAgentSessionId: string,
  ): Promise<boolean> {
    if (mission.agents.size < MAX_OPEN_AGENT_TRANSPORTS) return true;
    const idle = [...mission.agents.entries()]
      .filter(
        ([sessionId, agent]) =>
          sessionId !== requestedAgentSessionId &&
          !agent.streaming &&
          !agent.autoCompacting &&
          agent.pendingSends.length === 0,
      )
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (idle) {
      await this.closeAgent(mission.summary.appSessionId, idle[0]);
      return true;
    }
    this.emitError({
      appSessionId: mission.summary.appSessionId,
      // Scope to the requested worker so its loading state settles, not just the
      // mission-level toast.
      providerSessionId: requestedAgentSessionId,
      message: `Open live agent transport limit reached (${MAX_OPEN_AGENT_TRANSPORTS}). Wait for one running worker view to finish before opening another live worker view.`,
    });
    return false;
  }

  private async closeAgent(missionId: string, agentSessionId: string): Promise<void> {
    const mission = this.findSession(missionId);
    const agent = mission?.agents.get(agentSessionId);
    if (!mission || !agent) return;
    mission.agents.delete(agentSessionId);
    this.agentCompactions.delete(agentSessionId);
    this.contextSnapshots.delete(agentSessionId);
    this.autoCompactionWatchdogs.clear(agentSessionId);
    this.stopContextPolling(agent.session.sessionId);
    agent.unsubscribe?.();
    try {
      await agent.session.close();
    } catch {
      /* ignore */
    }
  }

  private async closeAgentWhenIdle(missionId: string, agentSessionId: string): Promise<void> {
    const mission = this.findSession(missionId);
    const agent = mission?.agents.get(agentSessionId);
    if (!mission || !agent) return;
    agent.closeWhenIdle = true;
    if (!agent.streaming && !agent.autoCompacting && agent.pendingSends.length === 0)
      await this.closeAgent(missionId, agentSessionId);
  }

  private async renameSession(sessionId: string, title: string): Promise<void> {
    await this.withSession(sessionId, (session) => session.renameSession({ title }));
    const appSessionId =
      this.findSession(sessionId)?.summary.appSessionId ??
      this.resolveSummary(sessionId)?.appSessionId;
    if (appSessionId) this.patch(appSessionId, { title });
  }

  private async withSession<T>(
    sessionId: string,
    fn: (session: DroidSession) => Promise<T>,
  ): Promise<T | undefined> {
    const liveMission = this.findSession(sessionId);
    const live = liveMission?.session;
    if (live) return fn(live);
    const providerSessionId = this.resolveSummary(sessionId)?.providerSessionId ?? sessionId;
    const session = await this.runtime.loadSession(providerSessionId);
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
      ? this.findSession(sessionId)?.session
      : first
        ? this.findSession(first.appSessionId)?.session
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

  private emitContextEstimate(sessionId: string, summary: SessionSummary): void {
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
      accuracy: summary.contextAccuracy ?? previous?.accuracy ?? 'estimated',
      updatedAt: new Date().toISOString(),
      breakdown,
    };
    this.contextSnapshots.set(sessionId, snapshot);
    this.emit({
      type: 'context.updated',
      appSessionId: summary.appSessionId,
      sourceSessionId: sessionId,
      stats: snapshot,
    });
  }

  private async refreshContext(
    sessionId: string,
    session: DroidSession,
    options: { persist?: boolean } = {},
  ): Promise<void> {
    try {
      const stats = await session.getContextStats();
      const breakdown = await this.readContextBreakdown(session);
      let snapshot = contextStatsSnapshot(stats, breakdown);
      const mission =
        this.findSession(sessionId) ??
        [...this.sessions.values()].find((candidate) => candidate.agents.has(sessionId));
      const appSessionId = mission?.summary.appSessionId ?? sessionId;
      const isPrimarySession =
        mission !== undefined &&
        (sessionId === mission.summary.appSessionId ||
          sessionId === mission.summary.providerSessionId);
      // The daemon's get_context_stats is a chars/4 estimate that over-counts;
      // when a provider-reported reading exists it matches the compaction
      // threshold count exactly, so it wins over the estimate. The stats call
      // still supplies the limit and breakdown.
      const exact =
        mission?.summary.contextAccuracy === 'exact' && mission.summary.contextTokens > 0
          ? mission.summary.contextTokens
          : undefined;
      if (exact !== undefined && snapshot.limit > 0) {
        const used = Math.min(exact, snapshot.limit);
        snapshot = {
          ...snapshot,
          used,
          remaining: Math.max(0, snapshot.limit - used),
          accuracy: 'exact',
          breakdown: snapshot.breakdown
            ? {
                ...snapshot.breakdown,
                usedTokens: used,
                freeTokens: Math.max(0, snapshot.limit - used),
              }
            : undefined,
        };
      }
      // Worker sessions have no mission summary to carry a compaction
      // generation, so the snapshot carries it for the meter's ratchet reset.
      if (!isPrimarySession)
        snapshot = { ...snapshot, compactions: this.agentCompactions.get(sessionId) ?? 0 };
      this.contextSnapshots.set(sessionId, snapshot);
      this.emit({
        type: 'context.updated',
        appSessionId,
        sourceSessionId: sessionId,
        stats: snapshot,
      });
      if (mission && isPrimarySession) {
        const contextPatch = {
          contextTokens: snapshot.used,
          contextRemainingTokens: snapshot.remaining,
          // summary.maxContextTokens means "model window". The catalog wins;
          // the daemon's stats limit only fills in for unknown models, so the
          // meter's window row stops flip-flopping between the two sources.
          maxContextTokens: this.maxContextTokensForSummary(mission.summary) ?? snapshot.limit,
          contextAccuracy: snapshot.accuracy,
          contextUpdatedAt: snapshot.updatedAt,
        };
        if (options.persist === false) mission.summary = { ...mission.summary, ...contextPatch };
        else this.patch(appSessionId, contextPatch);
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

  private async closeSession(missionId: string): Promise<void> {
    const key = this.findSessionKey(missionId);
    if (!key) return;
    const mission = this.sessions.get(key);
    if (!mission) return;
    this.stopContextPolling(key);
    if (mission.summary.providerSessionId) this.stopContextPolling(mission.summary.providerSessionId);
    this.autoCompactionWatchdogs.clear(mission.summary.appSessionId);
    mission.unsubscribe?.();
    for (const [agentSessionId, agent] of mission.agents) {
      this.stopContextPolling(agent.session.sessionId);
      // Worker snapshots can live under either key: refreshContext stores by
      // the id it was called with, which is the agents-map id on the
      // compaction path and the live session id on the polling path.
      this.contextSnapshots.delete(agent.session.sessionId);
      this.contextSnapshots.delete(agentSessionId);
      // Keyed by the app-level agent session id (like closeAgent), which is
      // never reused, so a missed delete would linger forever.
      this.agentCompactions.delete(agentSessionId);
      this.autoCompactionWatchdogs.clear(agentSessionId);
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
    await this.browsers.close(mission.summary.appSessionId).catch(() => {});
    this.sessions.delete(key);
    this.usageOffsets.delete(key);
    this.contextSnapshots.delete(key);
    if (mission.summary.providerSessionId) this.contextSnapshots.delete(mission.summary.providerSessionId);
    this.emitSessionList();
  }

  private patch(missionId: string, partial: Partial<SessionSummary>): void {
    const key = this.findSessionKey(missionId);
    const mission = key ? this.sessions.get(key) : undefined;
    if (!mission) return;
    mission.summary = { ...mission.summary, ...partial, updatedAt: Date.now() };
    this.history.syncSummaries([mission.summary]);
    this.emit({ type: 'session.updated', session: mission.summary });
  }

  private emitError(error: {
    code?: string;
    providerSessionId?: string;
    appSessionId?: string;
    message: string;
    recoverable?: boolean;
  }): void {
    const { recoverable, ...rest } = error;
    this.emit({ type: 'error', ...rest });
  }

  private async handleBrowser(
    appSessionId: string | undefined,
    action: () => Promise<void | unknown>,
  ): Promise<void> {
    try {
      await action();
    } catch (err) {
      const message = errMsg(err);
      this.emit({ type: 'browser.error', appSessionId, message });
      this.emitError({ code: 'browser.error', appSessionId, message });
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

  private requireBrowserAppSessionId(appSessionId?: string): string {
    if (!appSessionId) {
      throw new Error(
        'Browser sessions are scoped to a Droid chat. Select or create a chat before opening the browser.',
      );
    }
    return appSessionId;
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
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
  historical?: SessionSummary,
): Pick<
  SessionSummary,
  | 'sessionPurpose'
  | 'interactionMode'
  | 'role'
  | 'missionId'
  | 'parentProviderSessionId'
> {
  const session = init.session ?? {};
  const decompType = stringValue(session.decompSessionType);
  const missionId = stringValue(session.decompMissionId) ?? historical?.missionId;
  if (decompType === 'worker') {
    return {
      sessionPurpose: 'mission-control',
      interactionMode: 'agi',
      role: historical?.role === 'validator' ? 'validator' : 'worker',
      missionId,
      parentProviderSessionId: historical?.parentProviderSessionId,
    };
  }
  const mode = init.settings?.interactionMode ?? (init.mission ? 'agi' : undefined);
  if (
    mode === 'agi' ||
    decompType === 'orchestrator' ||
    historical?.sessionPurpose === 'mission-control'
  ) {
    return {
      sessionPurpose: 'mission-control',
      interactionMode: 'agi',
      role: 'primary',
      missionId: missionId ?? historical?.appSessionId,
      parentProviderSessionId: undefined,
    };
  }
  if (mode === 'spec' || historical?.interactionMode === 'spec')
    return {
      sessionPurpose: historical?.sessionPurpose ?? 'chat',
      interactionMode: 'spec',
      role: 'primary',
      missionId: undefined,
      parentProviderSessionId: undefined,
    };
  return {
    sessionPurpose: historical?.sessionPurpose ?? 'chat',
    interactionMode: 'auto',
    role: 'primary',
    missionId: undefined,
    parentProviderSessionId: undefined,
  };
}

function phaseFromInit(init: InitResultLike): SessionPhase {
  if (init.mission?.state) return STATE_TO_PHASE[init.mission.state] ?? 'paused';
  return 'paused';
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
  SessionSummary,
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
  agent: ConfigurableSessionRole,
  settings: AgentSettingPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  if (agent === 'primary') {
    // Spec-mode turns run on specModeModelId, so keep it in lockstep with the
    // chat's single visible model; otherwise a spec session keeps generating
    // with the model selected at create time (or the CLI spec default).
    if (settings.modelId) {
      next.modelId = settings.modelId;
      next.specModeModelId = settings.modelId;
    }
    if (settings.reasoningEffort !== undefined) {
      next.reasoningEffort = settings.reasoningEffort;
      next.specModeReasoningEffort = settings.reasoningEffort;
    }
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
  agent: ConfigurableSessionRole,
  mode: SessionInteractionMode,
  defaults: FactoryDefaultSettings,
): string | undefined {
  if (agent === 'worker') return defaults.workerModelId;
  if (agent === 'validator') return defaults.validatorModelId;
  return modelDefaultForMode(mode, defaults);
}

function modeForSummary(summary: SessionSummary): SessionInteractionMode {
  return summary.interactionMode;
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

// Model-generated transcript kinds that, once a turn is terminal, would form a
// second/buried final response if appended. A failed result (isError) and
// non-transcript signals (tokens, state, worker, subagent) are never quarantined.
const POST_TERMINAL_GENERATION_KINDS = new Set(['text', 'thinking', 'tool_call', 'tool_result']);

function isPostTerminalGeneration(
  n: NonNullable<ReturnType<typeof normalizeStreamEvent>>,
): boolean {
  return (
    !!n.transcript && !n.transcript.isError && POST_TERMINAL_GENERATION_KINDS.has(n.transcript.kind)
  );
}

// Whether a normalized event still carries non-transcript work that must be
// applied even when its quarantined model transcript is dropped post-terminal.
function hasNormalizedSideEffects(
  n: Omit<NonNullable<ReturnType<typeof normalizeStreamEvent>>, 'transcript'>,
): boolean {
  return !!(n.features || n.progress || n.missionState || n.worker || n.subagent || n.tokens);
}
