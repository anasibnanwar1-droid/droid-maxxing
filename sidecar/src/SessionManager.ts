import {
  ContextBreakdownResultSchema,
  DroidInteractionMode,
  type AskUserHandler,
  type ContextBreakdownResult,
  type AskUserRequestParams,
  type AskUserResult,
  type GetContextStatsResult,
  type McpServerConfig,
  type PermissionHandler,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';
import { tmpdir } from 'node:os';
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
  SessionHistoryEntry,
  SessionSummary,
  ModelInfo,
  ProgressEntry,
  ReasoningEffort,
  ServerEvent,
  SessionInteractionMode,
  TranscriptEvent,
} from './protocol.js';
import {
  errMsg,
  isUserCancellation,
  modelDefaultForMode,
  normalizeAutonomy,
  phaseFromState,
  reasoningValue,
  type SessionInitResult,
} from './sessionHelpers.js';
import { boundedInt, numberValue, stringValue } from './values.js';
import { DroidRuntime, type FactoryRuntime, type FactorySession } from './DroidRuntime.js';
import { detectEnvironment } from './Environment.js';
import { buildInstallCommand, buildUpdateCommand, runStreaming } from './CliInstaller.js';
import {
  classifyPermission,
  confirmationType,
  normalizeNotification,
  normalizeStreamEvent,
  permissionSignature,
} from './normalize.js';
import {
  HistoryIndex,
  hydrateHistoricalSession,
  loadHistoricalSessions,
  loadMissionControlSessions,
  loadSessionTranscriptWindow,
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
import { SessionRegistry } from './SessionRegistry.js';
import {
  SessionLifecycle,
  type ChildSessionSettings,
  type LiveChildSession,
  type LiveSession,
  type PendingChildSession,
  type StartedLocalMcpResources,
} from './SessionLifecycle.js';
import {
  isAlwaysOutcome,
  isApprovalOutcome,
  normalizePermissionOutcome,
} from './permissionOutcomes.js';
import type { SessionListFilterOptions } from './sessionListFilter.js';
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

type SessionHistory = Pick<
  HistoryIndex,
  | 'syncSummaries'
  | 'summaryPatches'
  | 'hiddenProviderSessionIds'
  | 'childSessionLinks'
  | 'recordChildSessionLink'
  | 'recordEvent'
  | 'close'
>;

type SessionBrowsers = Pick<
  BrowserSessionManager,
  | 'open'
  | 'close'
  | 'closeAll'
  | 'reload'
  | 'refresh'
  | 'resizeViewport'
  | 'click'
  | 'type'
  | 'keypress'
  | 'scroll'
  | 'screenshot'
  | 'inspectPoint'
  | 'addReference'
  | 'designPrompt'
>;

export interface StartableLocalMcpResource {
  start(): Promise<McpServerConfig>;
  close(): Promise<void>;
}

export interface SessionManagerDependencies {
  runtime: FactoryRuntime;
  history: SessionHistory;
  browsers: SessionBrowsers;
  createLocalMcpResource: (appSessionId: () => string) => StartableLocalMcpResource;
}

export interface SessionManagerOptions {
  assetUrlFor?: (path: string) => string;
  dependencies?: SessionManagerDependencies;
  initialModels?: ModelInfo[];
}

export interface AgentSettingPatch {
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
}

interface UsageOffset {
  tokensIn: number;
  tokensOut: number;
}

const MAX_OPEN_CHILD_SESSIONS = boundedInt(
  process.env.DROID_CONTROL_MAX_OPEN_CHILD_SESSIONS,
  4,
  1,
  24,
);
const BROWSER_NATIVE_TIMEOUT_MS = boundedInt(
  process.env.DROID_CONTROL_BROWSER_NATIVE_TIMEOUT_MS,
  12_000,
  1_000,
  60_000,
);
const ignoreError = (): undefined => undefined;

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
  private readonly runtime: FactoryRuntime;
  private readonly history: SessionHistory;
  private readonly registry: SessionRegistry<LiveSession>;
  private readonly lifecycle: SessionLifecycle;
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
  private readonly autoCompactionWatchdogs = new AutoCompactionWatchdogs((sessionKey) => {
    this.onAutoCompactionWatchdogExpired(sessionKey);
  });
  private readonly usageOffsets = new Map<string, UsageOffset>();
  private readonly contextSnapshots = new Map<string, ContextStatsSnapshot>();
  // In-place compactions completed per worker session; carried on that
  // session's context snapshots so the meter's ratchet resets (child sessions have no
  // summary-level generation counter of their own).
  private readonly childSessionCompactions = new Map<string, number>();
  private readonly contextPollers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pendingNativeBrowserRequests = new Map<string, PendingNativeBrowserRequest>();
  private readonly browsers: SessionBrowsers;
  private readonly createLocalMcpResource: SessionManagerDependencies['createLocalMcpResource'];

  constructor(
    private readonly emit: Emit,
    options: SessionManagerOptions = {},
  ) {
    if (options.dependencies) {
      this.runtime = options.dependencies.runtime;
      this.history = options.dependencies.history;
      this.browsers = options.dependencies.browsers;
      this.createLocalMcpResource = options.dependencies.createLocalMcpResource;
    } else {
      this.runtime = new DroidRuntime();
      this.history = new HistoryIndex();
      const browsers = new BrowserSessionManager({
        assetUrlFor: options.assetUrlFor,
        emit: (event) => {
          this.emit(event);
        },
        runtimeFactory: (browserSessionId, viewport, appSessionId) =>
          new NativeBrowserRuntime({
            browserSessionId,
            appSessionId,
            viewport,
            request: (request) => this.requestNativeBrowser(request),
            nextRequestId: nextNativeBrowserRequestId,
          }),
      });
      this.browsers = browsers;
      this.createLocalMcpResource = (appSessionId) =>
        createBrowserMcpServer(browsers, appSessionId);
    }
    this.cachedModels = options.initialModels ? [...options.initialModels] : null;
    this.registry = new SessionRegistry({
      history: this.history,
      loadOrdinarySessions: loadHistoricalSessions,
      loadMissionControlSessions,
      projectSummary: (summary) => this.applyPendingSettingsToSummary({ ...summary }),
      onSummaryUpdated: (summary) => {
        this.emit({ type: 'session.updated', session: summary });
      },
      now: Date.now,
    });
    this.lifecycle = new SessionLifecycle({
      runtime: this.runtime,
      registry: this.registry,
      ensureConnected: () => {
        if (!this.ready) this.connect();
      },
      getFactoryDefaults: () => this.getFactoryDefaults(),
      maxContextTokensForModel: (modelId) => this.maxContextTokensForModel(modelId),
      startLocalMcpServers: (ref) => this.startLocalMcpServers(ref),
      makePermissionHandler: (ref) => this.makePermissionHandler(ref),
      makeAskUserHandler: (ref) => this.makeAskUserHandler(ref),
      compactionLimit: (modelId, request) => {
        if (request.kind === 'resume') return this.compactionLimit(modelId, request.exposed);
        return Promise.resolve(
          effectiveCompactionTriggerLimit({
            modelId,
            ui: {
              compactionTokenLimit:
                request.command.compactionTokenLimit !== undefined
                  ? request.command.compactionTokenLimit
                  : this.uiCompactionSettings.compactionTokenLimit,
              compactionTokenLimitPerModel:
                request.command.compactionTokenLimitPerModel ??
                this.uiCompactionSettings.compactionTokenLimitPerModel,
            },
            defaults: request.defaults,
            maxContextTokens: this.maxContextTokensForModel(modelId),
          }),
        );
      },
      enableDaemonAutoCompaction: (session, limit) =>
        this.enableDaemonAutoCompaction(session, limit),
      subscribeSessionCompaction: (liveSession) => {
        this.subscribeSessionCompaction(liveSession);
      },
      childSessionLinks: (appSessionId) => this.history.childSessionLinks(appSessionId),
      applyPendingSettingsToSummary: (summary) => this.applyPendingSettingsToSummary(summary),
      applyPendingSessionSettings: (appSessionId) => this.applyPendingSessionSettings(appSessionId),
      runPrimaryTurn: (liveSession, prompt) => this.runPrimaryTurn(liveSession, prompt),
      refreshContext: (sourceSessionId, session) => this.refreshContext(sourceSessionId, session),
      onTurnSettledWhileAutoCompacting: (appSessionId) => {
        this.autoCompactionWatchdogs.arm(appSessionId, POST_TURN_AUTO_COMPACTION_WATCHDOG_MS);
      },
      stopContextPolling: (sourceSessionId) => {
        this.stopContextPolling(sourceSessionId);
      },
      clearAutoCompactionWatchdog: (sessionId) => {
        this.autoCompactionWatchdogs.clear(sessionId);
      },
      clearSessionRuntimeCaches: (liveSession) => {
        this.clearSessionRuntimeCaches(liveSession);
      },
      closeBrowserSession: (appSessionId) => this.browsers.close(appSessionId),
      emit: (event) => {
        this.emit(event);
      },
      emitError: (error) => {
        this.emitError(error);
      },
      emitStatus: (appSessionId, text) => {
        this.emitStatus(appSessionId, text);
      },
      emitSessionList: () => {
        this.emitSessionList();
      },
    });
  }

  connect(apiKey?: string): void {
    this.runtime.connect(apiKey);
    this.ready = true;
    this.emit({ type: 'connection', status: 'connected' });
    this.emit({ type: 'runtime.updated', status: this.runtime.status() });
  }

  // eslint-disable-next-line complexity -- Public command dispatch is intentionally unchanged in PR 3.
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
        await this.emitToolCatalog(cmd.providerSessionId);
        return;
      case 'catalog.skills':
        await this.emitSkillCatalog(cmd.providerSessionId);
        return;
      case 'catalog.mcp':
        await this.emitMcpCatalog(cmd.providerSessionId);
        return;
      case 'settings.defaults':
        this.emitFactoryDefaults();
        return;
      case 'session.create':
        await this.lifecycle.create(cmd);
        return;
      case 'session.send':
        await this.lifecycle.send(cmd.appSessionId, cmd.text);
        return;
      case 'session.sendNow':
        await this.lifecycle.sendNow(cmd.appSessionId, cmd.text);
        return;
      case 'approval.respond':
        await this.resolvePermission(cmd.appSessionId, cmd.requestId, cmd.outcome);
        return;
      case 'question.respond':
        this.resolveQuestion(cmd.appSessionId, cmd.requestId, cmd.cancelled, cmd.answers);
        return;
      case 'session.interrupt':
        await this.lifecycle.interrupt(cmd.appSessionId);
        return;
      case 'child.open':
        await this.openChildSession(cmd.appSessionId, cmd.providerSessionId, cmd.role ?? 'worker');
        return;
      case 'child.send':
        await this.sendChildSession(cmd.appSessionId, cmd.providerSessionId, cmd.text);
        return;
      case 'child.sendNow':
        await this.sendChildSessionNow(cmd.appSessionId, cmd.providerSessionId, cmd.text);
        return;
      case 'child.interrupt':
        await this.interruptChildSession(cmd.appSessionId, cmd.providerSessionId);
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
        const previousLiveSession = this.registry.getLive(appSessionId);
        if (
          previousLiveSession?.streaming ||
          previousLiveSession?.compacting ||
          previousLiveSession?.autoCompacting
        ) {
          this.emitStatus(
            appSessionId,
            'Cannot compact while a turn is active. Try again when the model is idle.',
          );
          return;
        }
        await this.compactSession(appSessionId, cmd.customInstructions, 'manual');
        await this.lifecycle.settleAfterCompaction(appSessionId, previousLiveSession);
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
        await this.lifecycle.resume(cmd.appSessionId);
        return;
      case 'session.close':
        await this.lifecycle.close(cmd.appSessionId);
        return;
      case 'sessions.list':
        this.emitSessionList(cmd);
        return;
      case 'history.list':
        this.listHistory();
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
        await this.handleBrowser(cmd.appSessionId, () => {
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
          await this.lifecycle.send(appSessionId, prompt);
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
        if (emit) this.emit({ type: 'catalog.updated', catalog: 'models', items: models });
        return models;
      } catch (err) {
        this.emitError({ message: `catalog.models failed: ${errMsg(err)}` });
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
    const exitCode = await runStreaming(cmd, ({ stream, line }) => {
      this.emit({ type: 'cli.install.progress', phase: 'install', stream, line });
    });
    this.emit({ type: 'cli.install.done', phase: 'install', ok: exitCode === 0, exitCode });
    this.emit({ type: 'runtime.updated', status: this.runtime.status() });
    await this.emitEnvironment();
  }

  private async runCliUpdate(channel?: InstallChannel): Promise<void> {
    const status = this.runtime.status();
    const env = await detectEnvironment(status.apiKeyConfigured);
    const cmd = buildUpdateCommand(channel, status.droidPath, env.cli.present);
    const exitCode = await runStreaming(cmd, ({ stream, line }) => {
      this.emit({ type: 'cli.install.progress', phase: 'update', stream, line });
    });
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

  private emitFactoryDefaults(): void {
    const defaults = readFactoryDefaults();
    const droidPath = this.runtime.status().droidPath;
    const models = this.cachedModels ?? mergeModelCatalog(readDroidCliModelCatalogCache(droidPath));
    if (!this.cachedModels && models.length > 0) this.cachedModels = models;
    this.emit({ type: 'settings.defaults', defaults: startupFactoryDefaults(defaults, models) });
  }

  private async startLocalMcpServers(ref: { id: string }): Promise<StartedLocalMcpResources> {
    const servers = [this.createLocalMcpResource(() => ref.id)];
    const configs: StartedLocalMcpResources['configs'] = [];
    try {
      for (const server of servers) configs.push(await server.start());
      return { servers, configs };
    } catch (err) {
      await Promise.all(servers.map((server) => server.close().catch(ignoreError)));
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

  // eslint-disable-next-line complexity -- Agent-setting policy is preserved as-is in this extraction.
  private async updateAgentSettings(
    cmd: Extract<ClientCommand, { type: 'settings.agent.update' }>,
  ): Promise<void> {
    try {
      const session = cmd.appSessionId ? this.registry.getLive(cmd.appSessionId) : undefined;
      const summary =
        session?.summary ??
        (cmd.appSessionId ? this.registry.resolveSummary(cmd.appSessionId) : undefined);
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
        if (session && appSessionId) this.registry.updateSummary(appSessionId, patch);
        else {
          const historical = this.registry.resolveSummary(cmd.appSessionId);
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
      this.registry.getLive(cmd.appSessionId)?.summary.appSessionId ??
      this.registry.resolveSummary(cmd.appSessionId)?.appSessionId ??
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
    liveSession: LiveSession,
    agent: ConfigurableSessionRole,
    settings: AgentSettingPatch,
  ): Promise<void> {
    const next = createSessionSettingsForAgent(agent, settings);
    if (Object.keys(next).length > 0) await liveSession.session.updateSettings(next);
  }

  // Refresh the daemon's auto-compaction threshold from the session's effective
  // primary model. When the model was reset to Default, summary.modelId is
  // undefined, so resolve the actual default model (its per-model limit and
  // context-window clamp would otherwise be ignored).
  private async recomputeSessionCompactionLimit(
    liveSession: LiveSession,
    stillCurrent: () => boolean = () => true,
  ): Promise<void> {
    const defaults = await this.getFactoryDefaults();
    const modelId =
      liveSession.summary.modelId ??
      defaultModelForAgent('primary', defaultsModeForSummary(liveSession.summary), defaults);
    const limit = await this.compactionLimit(modelId);
    if (!stillCurrent()) return;
    const armed = await this.enableDaemonAutoCompaction(liveSession.session, limit);
    if (!stillCurrent()) return;
    // The summary records the trigger the daemon actually accepted; an arm
    // failure clears it instead of advertising a limit that is not in force.
    this.registry.updateSummary(liveSession.summary.appSessionId, {
      compactionTokenLimit: armed ? limit : undefined,
    });
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

  private childSessionModelId(
    liveSession: LiveSession,
    childProviderSessionId: string,
    role: SessionRole,
  ): string | undefined {
    let roleModelId: string | undefined;
    if (role === 'worker') roleModelId = liveSession.summary.workerModelId;
    else if (role === 'validator') roleModelId = liveSession.summary.validatorModelId;
    return (
      liveSession.childSessionSettings.get(childProviderSessionId)?.modelId ??
      roleModelId ??
      liveSession.summary.modelId
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
    // Retune every live provider session (primary and opened children) so concurrent
    // chats on different models each follow their own effective limit. Sessions
    // retune in parallel so one hung updateSettings cannot stall the rest; the
    // revision guard keeps a slow batch from re-arming stale limits after a
    // newer settings change already retuned.
    const rev = ++this.compactionRetuneRev;
    const stillCurrent = () => rev === this.compactionRetuneRev;
    const retunes: Promise<unknown>[] = [];
    for (const liveSession of this.registry.liveSessionsSnapshot()) {
      retunes.push(this.recomputeSessionCompactionLimit(liveSession, stillCurrent));
      for (const [childProviderSessionId, childSession] of liveSession.childSessions) {
        const modelId = this.childSessionModelId(
          liveSession,
          childProviderSessionId,
          childSession.role,
        );
        retunes.push(
          this.compactionLimit(modelId).then((limit) => {
            if (!stillCurrent()) return;
            return this.enableDaemonAutoCompaction(childSession.session, limit);
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
    session: FactorySession,
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
    liveSession: LiveSession,
    agent: ConfigurableSessionRole,
    settings: AgentSettingPatch,
  ): Promise<AgentSettingPatch> {
    if (settings.modelId !== null) return settings;
    const defaults = await this.getFactoryDefaults();
    return {
      ...settings,
      modelId: defaultModelForAgent(agent, defaultsModeForSummary(liveSession.summary), defaults),
    };
  }

  private async applyPendingSessionSettings(appSessionId: string): Promise<boolean> {
    const liveSession = this.registry.getLive(appSessionId);
    const pending = this.pendingAgentSettings.get(appSessionId);
    if (!liveSession || !pending) return true;
    try {
      let patch: Partial<SessionSummary> = {};
      for (const [agent, settings] of Object.entries(pending) as [
        ConfigurableSessionRole,
        AgentSettingPatch,
      ][]) {
        await this.applyAgentSessionSettings(
          liveSession,
          agent,
          await this.runtimeAgentSettings(liveSession, agent, settings),
        );
        patch = { ...patch, ...this.summaryPatchForAgent(agent, settings) };
      }
      this.registry.updateSummary(appSessionId, patch);
      if (pending.primary?.modelId !== undefined) {
        // A pending primary model applied before send changes the
        // auto-compaction threshold; recompute it to match the new model.
        await this.recomputeSessionCompactionLimit(liveSession);
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

  private listHistory(): void {
    try {
      const sessions: SessionHistoryEntry[] = loadSessionHistory();
      this.emit({ type: 'history.list', sessions });
    } catch (err) {
      this.emitError({ message: errMsg(err) });
    }
  }

  private emitSessionList(options?: SessionListFilterOptions): void {
    this.emit({ type: 'sessions.list', sessions: this.registry.listSummaries(options) });
  }

  // Annotate persisted child links with the live run state from the active
  // session so a renderer reconnect/reload doesn't render a still-running
  // child session as finished. Historical loads leave status undefined,
  // which the renderer treats as completed.
  private withLiveChildSessionStatus(
    appSessionId: string,
    links: ChildSessionHistoryLink[],
  ): ChildSessionHistoryLink[] {
    const session = this.registry.getLive(appSessionId);
    if (!session) return links;
    // A resumed worker that the user has opened is live in session.childSessions but is
    // not re-added to knownChildSessions (that only happens on a live spawn), so
    // check both; otherwise a history reload would render it as completed.
    return links.map((link) =>
      session.knownChildSessions.has(link.providerSessionId) ||
      session.childSessions.has(link.providerSessionId)
        ? {
            ...link,
            status: session.completedChildSessions.has(link.providerSessionId)
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
    childSessions?: ChildSessionHistoryLink[];
    mode: 'replace' | 'prepend';
    olderCursor?: string;
  }): void {
    this.emit({
      type: 'session.history',
      appSessionId: args.appSessionId,
      progress: args.progress,
      transcripts: args.transcripts,
      childSessions: args.childSessions,
      mode: args.mode,
      olderCursor: args.olderCursor,
      loadedCount: args.transcripts.length,
      hasMore: Boolean(args.olderCursor),
    });
  }

  private loadSessionHistory(appSessionIdOrProviderSessionId: string, cursor?: string): void {
    const summary = this.registry.resolveSummary(appSessionIdOrProviderSessionId);
    const appSessionId = summary?.appSessionId ?? appSessionIdOrProviderSessionId;
    const providerSessionId = summary?.providerSessionId ?? appSessionIdOrProviderSessionId;
    try {
      const history =
        summary?.sessionPurpose === 'mission-control'
          ? hydrateHistoricalSession(appSessionId, { cursor })
          : this.loadStandardSessionHistory(appSessionId, providerSessionId, cursor);
      const transcripts = history.transcripts.map((event) => ({
        ...event,
        appSessionId,
      }));
      transcripts.forEach((event) => {
        this.history.recordEvent(event);
      });
      // An older page only extends primary scrollback upward; prepend it without
      // touching the already-delivered child sessions or progress.
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
      const childSessions = this.withLiveChildSessionStatus(
        appSessionId,
        this.history.childSessionLinks(appSessionId),
      );
      this.emitSessionHistory({
        appSessionId,
        progress: history.progress,
        transcripts,
        childSessions,
        mode: 'replace',
        olderCursor: history.olderCursor,
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
      if (this.registry.getLive(appSessionId)) {
        // A live session with no persisted history yet is an empty restore.
        // Live events seed it; this authoritative snapshot settles the client.
        this.emitSessionHistory({
          appSessionId,
          progress: [],
          transcripts: [],
          childSessions: this.withLiveChildSessionStatus(
            appSessionId,
            this.history.childSessionLinks(appSessionId),
          ),
          mode: 'replace',
          olderCursor: undefined,
        });
      } else {
        this.emit({
          type: 'session.history.error',
          appSessionId,
          message: errMsg(err),
        });
        this.emitError({
          appSessionId,
          providerSessionId,
          message: errMsg(err),
          recoverable: true,
        });
      }
    }
  }

  private loadStandardSessionHistory(
    appSessionId: string,
    providerSessionId: string,
    cursor?: string,
  ): ReturnType<typeof hydrateHistoricalSession> {
    const chain = resolveSessionChain(appSessionId, providerSessionId);
    if (chain.length === 0) throw new Error(`Session history not found for ${providerSessionId}`);
    const window = loadSessionTranscriptWindow(appSessionId, chain, { cursor });
    return {
      progress: [],
      transcripts: window.events,
      olderCursor: window.olderCursor,
    };
  }

  private loadHistoryPage(providerSessionId: string, cursor?: string, limit?: number): void {
    const summary = this.registry.resolveSummary(providerSessionId);
    const appSessionId = summary?.appSessionId ?? providerSessionId;
    const resolvedProviderSessionId = summary?.providerSessionId ?? providerSessionId;
    try {
      const page = loadSessionPage(resolvedProviderSessionId, appSessionId, cursor, limit);
      page.events.forEach((event) => {
        this.history.recordEvent(event);
      });
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

  private makePermissionHandler(ref: { id: string }): PermissionHandler {
    return (params: RequestPermissionRequestParams) =>
      new Promise<RequestPermissionHandlerResult>((resolve) => {
        const liveSession = this.registry.getLive(ref.id);
        const requestId = nextRequestId();
        const type = confirmationType(params);
        const request = classifyPermission(ref.id, requestId, params);
        const signature = permissionSignature(params);
        if (liveSession && signature && liveSession.permissionGrants.has(signature)) {
          resolve(normalizePermissionOutcome('proceed_always'));
          return;
        }
        if (liveSession) {
          liveSession.pendingPermissions.set(requestId, {
            resolve,
            kind: request.kind,
            signature: signature || undefined,
          });
          if (type === 'propose_mission') {
            this.registry.updateSummary(ref.id, {
              phase: 'awaiting_plan_approval',
              proposal: request.detail,
            });
          } else if (type === 'start_mission_run') {
            this.registry.updateSummary(ref.id, { phase: 'awaiting_run_start' });
          }
        }
        this.emit({ type: 'approval.requested', request });
      });
  }

  private makeAskUserHandler(ref: { id: string }): AskUserHandler {
    return (params: AskUserRequestParams) =>
      new Promise<AskUserResult>((resolve) => {
        const liveSession = this.registry.getLive(ref.id);
        const requestId = nextRequestId();
        const questions = params.questions.map((q) => ({
          index: q.index,
          question: q.question,
          options: q.options,
        }));
        if (liveSession) liveSession.pendingQuestions.set(requestId, resolve);
        const question = { appSessionId: ref.id, requestId, questions };
        this.emit({ type: 'question.requested', question });
      });
  }

  private async resolvePermission(
    appSessionId: string,
    requestId: string,
    outcome: string,
  ): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    const pending = liveSession?.pendingPermissions.get(requestId);
    if (!liveSession || !pending) return;
    liveSession.pendingPermissions.delete(requestId);
    let normalized: RequestPermissionHandlerResult;
    try {
      normalized = normalizePermissionOutcome(outcome);
    } catch (err) {
      this.emitError({
        code: 'permission.invalid_outcome',
        appSessionId: appSessionId,
        message: errMsg(err),
      });
      normalized = normalizePermissionOutcome('cancel');
    }
    if (pending.signature && isAlwaysOutcome(outcome)) {
      liveSession.permissionGrants.add(pending.signature);
    }
    if (pending.kind === 'spec' && isApprovalOutcome(normalized))
      await this.prepareSpecExitForRun(liveSession);
    pending.resolve(normalized);
  }

  private async prepareSpecExitForRun(liveSession: LiveSession): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    this.registry.updateSummary(appSessionId, { interactionMode: 'auto', phase: 'running' });
    try {
      await liveSession.session.updateSettings({
        interactionMode: DroidInteractionMode.Auto,
      });
    } catch (err) {
      this.emitError({
        code: 'spec.exit_failed',
        appSessionId,
        message: `Could not switch spec session to Auto before run: ${errMsg(err)}`,
      });
    }
  }

  private resolveQuestion(
    appSessionId: string,
    requestId: string,
    cancelled: boolean,
    answers: { index: number; question: string; answer: string }[],
  ): void {
    const liveSession = this.registry.getLive(appSessionId);
    const resolver = liveSession?.pendingQuestions.get(requestId);
    if (!liveSession || !resolver) return;
    liveSession.pendingQuestions.delete(requestId);
    resolver({ cancelled, answers });
  }

  private async runPrimaryTurn(liveSession: LiveSession, prompt: string): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    this.startContextPolling(appSessionId, liveSession.session);
    try {
      await this.applyDesignToolPolicy(liveSession, isDesignPrompt(prompt));
      if (hasSessionCloseStarted(liveSession)) return;
      const stream = liveSession.session.stream(prompt, { includePartialMessages: true });
      for await (const ev of stream) {
        if (hasSessionCloseStarted(liveSession)) break;
        this.applyEvent(appSessionId, appSessionId, 'primary', ev);
      }
    } catch (err) {
      if (hasSessionCloseStarted(liveSession)) {
        return;
      } else if (liveSession.interruptingForSteer) {
        this.emitStatus(appSessionId, 'Current turn interrupted for steering.');
      } else if (liveSession.interrupting && isUserCancellation(err)) {
        // The user pressed Stop; interrupt() already set the paused phase, so
        // settle quietly without surfacing an error.
        this.registry.updateSummary(appSessionId, { phase: 'paused' });
      } else {
        this.emitError({ appSessionId, message: errMsg(err) });
        this.registry.updateSummary(appSessionId, { phase: 'failed' });
      }
    } finally {
      this.stopContextPolling(appSessionId);
      // Keep streaming=true while refreshContext is in flight so concurrent
      // sends queue instead of racing a second lifecycle turn.
      if (!hasSessionCloseStarted(liveSession)) {
        await this.refreshContext(appSessionId, liveSession.session);
      }
    }
  }

  // Design turns are a single focused task (extra prompts queue), so the model
  // does not need TodoWrite — it otherwise loops updating the list after it has
  // already answered. Disable TodoWrite for design turns and restore it for
  // normal turns, calling updateSettings only when the policy changes.
  private async applyDesignToolPolicy(liveSession: LiveSession, design: boolean): Promise<void> {
    // When the in-memory flag is unset (cold start / page reload) we don't
    // know the session's current disabledToolIds, so always call updateSettings
    // to synchronize. Once the flag is set we skip redundant calls.
    if (
      liveSession.todoDisabledForDesign !== undefined &&
      liveSession.todoDisabledForDesign === design
    )
      return;
    try {
      await liveSession.session.updateSettings({ disabledToolIds: design ? ['TodoWrite'] : [] });
      liveSession.todoDisabledForDesign = design;
    } catch (err) {
      this.emitError({
        appSessionId: liveSession.summary.appSessionId,
        message: `Could not update design tool policy: ${errMsg(err)}`,
      });
    }
  }

  private applyEvent(
    appSessionId: string,
    sourceProviderSessionId: string,
    role: SessionRole,
    ev: Parameters<typeof normalizeStreamEvent>[3],
  ): void {
    const n = normalizeStreamEvent(appSessionId, sourceProviderSessionId, role, ev);
    if (!n) return;
    this.applyNormalizedForSource(appSessionId, sourceProviderSessionId, n);
  }

  // Single live entry point that enforces per-turn terminal gating before
  // applying a normalized event. Both primary/child stream loops and
  // the worker notification subscriptions route through here so post-terminal
  // generation is dropped no matter which channel delivers it. History replay
  // does not pass through this path (it uses emitTranscript directly).
  private applyNormalizedForSource(
    appSessionId: string,
    sourceProviderSessionId: string,
    n: NonNullable<ReturnType<typeof normalizeStreamEvent>>,
  ): void {
    const liveSession = this.registry.getLive(appSessionId);
    if (liveSession) {
      // The first `result` of a streaming turn is its terminal final. Mark the
      // producing session terminal so any further model generation in the same
      // turn is dropped, keeping one final response per turn.
      if (n.done) {
        liveSession.terminalSources.add(sourceProviderSessionId);
        return;
      }
      // After terminal, quarantine only this session's model-generated chat/tool
      // transcript. Child spawn/completion, token, Mission Control state, and
      // error side effects still flow.
      if (liveSession.terminalSources.has(sourceProviderSessionId) && isPostTerminalGeneration(n)) {
        const sideEffects = { ...n };
        delete sideEffects.transcript;
        if (hasNormalizedSideEffects(sideEffects))
          this.applyNormalized(appSessionId, sideEffects, sourceProviderSessionId);
        return;
      }
    }
    this.applyNormalized(appSessionId, n, sourceProviderSessionId);
  }

  // eslint-disable-next-line complexity -- Child-session event policy remains with its PR 6 owner.
  private applyChildSession(
    appSessionId: string,
    child: {
      providerSessionId?: string;
      toolUseId?: string;
      label?: string;
      prompt?: string;
      done?: boolean;
    },
  ): void {
    const liveSession = this.registry.getLive(appSessionId);
    if (!liveSession) return;
    const providerSessionId = child.providerSessionId;
    if (!providerSessionId) {
      if (child.done) {
        if (child.toolUseId) this.completeChildSessionForToolUse(liveSession, child.toolUseId);
      } else if (child.toolUseId || child.label || child.prompt) {
        liveSession.pendingChildSessions.push({
          toolUseId: child.toolUseId,
          label: child.label,
          prompt: child.prompt,
        });
      }
      return;
    }
    if (child.done) {
      this.completeChildSession(liveSession, providerSessionId);
      return;
    }
    if (liveSession.knownChildSessions.has(providerSessionId)) return;
    const pending = this.takePendingChildSession(liveSession, child);
    const toolUseId = child.toolUseId ?? pending?.toolUseId;
    const label = child.label ?? pending?.label;
    const prompt = child.prompt ?? pending?.prompt;
    liveSession.knownChildSessions.add(providerSessionId);
    liveSession.completedChildSessions.delete(providerSessionId);
    if (toolUseId) {
      liveSession.childSessionToolUseIds.set(toolUseId, providerSessionId);
      this.history.recordChildSessionLink(appSessionId, toolUseId, providerSessionId, label);
    }
    this.emit({
      type: 'session.child',
      appSessionId,
      event: 'started',
      providerSessionId,
      label,
      prompt,
      toolUseId,
    });
    if (prompt) {
      this.emitTranscript({
        id: `child-session-task-${providerSessionId}`,
        appSessionId,
        sourceSessionId: providerSessionId,
        role: 'worker',
        ts: Date.now(),
        kind: 'status',
        text: `Task prompt\n\n${prompt}`,
      });
    }
    this.emit({
      type: 'child.updated',
      appSessionId,
      providerSessionId,
      role: 'worker',
      status: 'running',
    });
  }

  private takePendingChildSession(
    liveSession: LiveSession,
    child: PendingChildSession,
  ): PendingChildSession | undefined {
    if (liveSession.pendingChildSessions.length === 0) return undefined;
    if (child.toolUseId) {
      const index = liveSession.pendingChildSessions.findIndex(
        (pending) => pending.toolUseId === child.toolUseId,
      );
      if (index >= 0) return liveSession.pendingChildSessions.splice(index, 1)[0];
    }
    const label = child.label?.toLowerCase();
    if (label) {
      const index = liveSession.pendingChildSessions.findIndex(
        (pending) => pending.label?.toLowerCase() === label,
      );
      if (index >= 0) return liveSession.pendingChildSessions.splice(index, 1)[0];
    }
    return liveSession.pendingChildSessions.shift();
  }

  private completeChildSessionForToolUse(liveSession: LiveSession, toolUseId: string): void {
    const providerSessionId = liveSession.childSessionToolUseIds.get(toolUseId);
    if (providerSessionId) this.completeChildSession(liveSession, providerSessionId);
  }

  private completeChildSession(liveSession: LiveSession, providerSessionId: string): void {
    if (
      !liveSession.knownChildSessions.has(providerSessionId) ||
      liveSession.completedChildSessions.has(providerSessionId)
    )
      return;
    const appSessionId = liveSession.summary.appSessionId;
    liveSession.completedChildSessions.add(providerSessionId);
    const settings = liveSession.childSessionSettings.get(providerSessionId) ?? {};
    this.emit({
      type: 'session.child',
      appSessionId,
      event: 'completed',
      providerSessionId,
      ...settings,
    });
    this.emit({
      type: 'child.updated',
      appSessionId,
      providerSessionId,
      role: 'worker',
      status: 'completed',
    });
    void this.closeChildSessionWhenIdle(appSessionId, providerSessionId);
  }

  // eslint-disable-next-line complexity -- Event normalization behavior remains with its PR 4 owner.
  private applyNormalized(
    appSessionId: string,
    n: NonNullable<ReturnType<typeof normalizeStreamEvent>>,
    childProviderSessionId?: string,
  ): void {
    if (n.transcript) this.emitTranscript(n.transcript);
    if (n.features) {
      this.registry.updateSummary(appSessionId, { features: n.features });
      const missionControlId = this.registry.getLive(appSessionId)?.summary.missionId;
      this.emit({
        type: 'mission.features',
        appSessionId: appSessionId,
        missionId: missionControlId,
        features: n.features,
      });
    }
    if (n.progress) {
      const missionControlId = this.registry.getLive(appSessionId)?.summary.missionId;
      this.emit({
        type: 'mission.progress',
        appSessionId: appSessionId,
        missionId: missionControlId,
        entries: n.progress,
      });
    }
    if (n.missionState) {
      const phase = phaseFromState(n.missionState);
      if (phase) this.registry.updateSummary(appSessionId, { phase });
    }
    if (n.missionChild) {
      this.emit({
        type: 'session.child',
        appSessionId: appSessionId,
        event: n.missionChild.event,
        providerSessionId: n.missionChild.providerSessionId,
        exitCode: n.missionChild.exitCode,
      });
      this.emit({
        type: 'child.updated',
        appSessionId: appSessionId,
        providerSessionId: n.missionChild.providerSessionId,
        role: 'worker',
        status: n.missionChild.event === 'completed' ? 'completed' : 'running',
      });
      if (n.missionChild.event === 'completed')
        void this.closeChildSessionWhenIdle(appSessionId, n.missionChild.providerSessionId);
    }
    if (n.childSession) this.applyChildSession(appSessionId, n.childSession);
    if (n.tokens) {
      const m = this.registry.getLive(appSessionId);
      if (m) {
        const appSessionId = m.summary.appSessionId;
        const offset = this.usageOffsets.get(appSessionId);
        m.summary.tokensIn = n.tokens.tokensIn + (offset?.tokensIn ?? 0);
        m.summary.tokensOut = n.tokens.tokensOut + (offset?.tokensOut ?? 0);
        // The summary's context reading belongs to the primary session
        // only. Worker turns still update the running totals above, but their
        // context usage must never land on the summary: it would repaint the
        // primary context meter with the worker's window, and a leftover 'exact'
        // marker would make refreshContext pin the meter there. Workers get
        // their own context.updated snapshots keyed by their session id.
        const fromOrchestrator =
          childProviderSessionId === undefined || childProviderSessionId === appSessionId;
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
    appSessionId: string,
    text: string,
    compactType?: CompactType,
    childProviderSessionId?: string,
    role: SessionRole = 'primary',
  ): void {
    this.emitTranscript({
      id: `status-${Date.now().toString(36)}-${(this.statusSeq++).toString(36)}`,
      appSessionId: appSessionId,
      sourceSessionId: childProviderSessionId ?? appSessionId,
      role,
      ts: Date.now(),
      kind: 'status',
      text,
      compactType,
    });
  }

  // Subscribe the primary session to raw daemon notifications so the
  // daemon's in-place auto-compaction surfaces in the transcript. Everything
  // else the primary session needs already arrives through the streaming turn, so
  // only compaction notifications are handled here.
  private subscribeSessionCompaction(liveSession: LiveSession): void {
    const session = liveSession.session;
    liveSession.unsubscribe?.();
    liveSession.unsubscribe = session.onNotification((note: Record<string, unknown>) => {
      // The daemon emits the same compacting/compacted notifications during a
      // manual compactSession RPC; runCompaction owns that path's statuses and
      // refresh, so reacting here too would duplicate them.
      if (liveSession.compacting) return;
      const appSessionId = liveSession.summary.appSessionId;
      this.handleCompactionNotification(appSessionId, appSessionId, 'primary', session, note);
    });
  }

  // Surface a daemon auto-compaction (in place, same session id): a start
  // status drives the compacting shimmer and the completion status clears it,
  // then the context meter is refreshed against the compacted window. Returns
  // whether the notification was a compaction event.
  private handleCompactionNotification(
    appSessionId: string,
    childProviderSessionId: string,
    role: SessionRole,
    session: FactorySession,
    note: Record<string, unknown>,
  ): boolean {
    return runCompactionNotification(
      this.compactionHost(),
      { appSessionId, providerSessionId: childProviderSessionId, role, session },
      note,
    );
  }

  private onAutoCompactionWatchdogExpired(sessionKey: string): void {
    settleExpiredAutoCompaction(this.compactionHost(), sessionKey);
  }

  private compactionHost(): AutoCompactionHost<LiveChildSession, LiveSession, FactorySession> {
    return {
      watchdogs: this.autoCompactionWatchdogs,
      sessions: () => this.registry.liveSessionsSnapshot(),
      findSession: (appSessionId) => this.registry.getLive(appSessionId),
      childSessionCompactions: this.childSessionCompactions,
      emitCompactionStatus: (appSessionId, text, providerSessionId, role) => {
        this.emitStatus(appSessionId, text, 'auto', providerSessionId, role);
      },
      patchSummary: (appSessionId, patch) => this.registry.updateSummary(appSessionId, patch),
      refreshContext: (providerSessionId, session) =>
        this.refreshContext(providerSessionId, session),
      settlePrimary: (appSessionId) => {
        void this.lifecycle.settleAfterCompaction(appSessionId);
      },
      driveChildSession: (childSession, text) => this.driveChildSession(childSession, text),
      closeChildSession: (appSessionId, providerSessionId) =>
        this.closeChildSession(appSessionId, providerSessionId),
      emitChildSessionPaused: (childSession) => {
        this.emit({
          type: 'child.updated',
          appSessionId: childSession.appSessionId,
          providerSessionId: childSession.session.sessionId,
          role: childSession.role,
          status: 'paused',
        });
      },
    };
  }

  private async compactSession(
    appSessionId: string,
    customInstructions?: string,
    compactType: CompactType = 'manual',
  ): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    if (liveSession) {
      await this.compactLiveSession(liveSession, customInstructions, compactType);
      return;
    }
    await this.compactHistoricalSession(appSessionId, customInstructions);
  }

  // Primary live-session compaction. Runs the shared in-place path; if the
  // daemon returns a new backing id the `reload` hook swaps the session while
  // keeping the stable app id (summary.appSessionId) so the visible chat is unchanged.
  private async compactLiveSession(
    liveSession: LiveSession,
    customInstructions: string | undefined,
    compactType: CompactType,
  ): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    const preCompactSessionId = liveSession.summary.providerSessionId;
    const carryover: UsageOffset = {
      tokensIn: liveSession.summary.tokensIn,
      tokensOut: liveSession.summary.tokensOut,
    };
    liveSession.compacting = true;
    // Remembers the daemon's new backing id so a reload failure can be recovered
    // after runCompaction returns 'stale' (the hook sets it before adopting).
    let swapTarget: string | undefined;
    try {
      const outcome = await runCompaction(
        liveSession.session,
        {
          status: (text, ct) => {
            this.emitStatus(appSessionId, text, ct);
          },
          error: (message) => {
            this.emitError({
              providerSessionId: liveSession.summary.providerSessionId,
              appSessionId,
              message: `Could not compact session: ${message}`,
              recoverable: true,
            });
          },
          refresh: () => {
            // The pre-compaction exact reading would otherwise override the
            // refreshed estimate; and when the daemon compacted in place (no
            // swap, so no compactedFromProviderSessionIds bump) the meter's ratchet
            // needs the generation counter to move to accept the lower value.
            const live = this.registry.getLive(appSessionId);
            if (live) {
              this.registry.updateSummary(appSessionId, {
                contextTokens: 0,
                contextAccuracy: undefined,
                ...(live.summary.providerSessionId === preCompactSessionId
                  ? { autoCompactions: (live.summary.autoCompactions ?? 0) + 1 }
                  : {}),
              });
            }
            return this.refreshContext(appSessionId, liveSession.session);
          },
          reload: async (newSessionId) => {
            swapTarget = newSessionId;
            await this.swapSessionProvider(liveSession, newSessionId, carryover);
          },
        },
        { customInstructions, compactType },
      );
      // The daemon swapped to a new backing id but adopting it threw, so
      // liveSession.session still points at the swapped-away (now-dead) old id.
      // Recover before later sends stream into that stale session.
      if (outcome === 'stale' && swapTarget) {
        await this.recoverStaleSessionSwap(liveSession, swapTarget, carryover);
      }
    } finally {
      liveSession.compacting = false;
    }
  }

  // Adopt the daemon's compacted backing session behind the stable app id:
  // load the new id, swap it in, retire the old session, and persist the new id
  // with carried-over usage. Throws if the new session cannot be loaded.
  private async swapSessionProvider(
    liveSession: LiveSession,
    newSessionId: string,
    carryover: UsageOffset,
  ): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    const ref = { id: appSessionId };
    const oldSession = liveSession.session;
    liveSession.session = await this.runtime.loadSession(newSessionId, {
      permissionHandler: this.makePermissionHandler(ref),
      askUserHandler: this.makeAskUserHandler(ref),
      // Re-attach the same local MCP servers (still running) so the swapped
      // session keeps browser tools on subsequent turns.
      mcpServers: liveSession.mcpConfigs,
    });
    this.subscribeSessionCompaction(liveSession);
    // Settings live on the daemon session, not the persisted file, so the
    // replacement session starts without the auto-compaction threshold check.
    // Re-push it; a failure must not turn a successful swap into a stale one.
    await this.recomputeSessionCompactionLimit(liveSession).catch(ignoreError);
    // The replacement session starts with default tool settings, so the cached
    // design-tool policy no longer reflects reality. Clear it so the next turn
    // re-synchronizes disabledToolIds.
    liveSession.todoDisabledForDesign = undefined;
    await oldSession.close().catch(ignoreError);
    this.usageOffsets.set(appSessionId, carryover);
    this.registry.replaceProvider(appSessionId, newSessionId, {
      tokensIn: carryover.tokensIn,
      tokensOut: carryover.tokensOut,
      contextTokens: 0,
    });
  }

  // Recovery for a primary-session compaction that swapped provider sessions but
  // failed to adopt the new one (liveSession.session is now a dead id). Retry the
  // adoption once for a transient failure; if it still fails, persist the new
  // id and drop the live session so the next send re-resumes against the live
  // (compacted) session instead of streaming into the dead one.
  private async recoverStaleSessionSwap(
    liveSession: LiveSession,
    newSessionId: string,
    carryover: UsageOffset,
  ): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    try {
      await this.swapSessionProvider(liveSession, newSessionId, carryover);
      return;
    } catch {
      /* adoption still failing; persist the new id and drop the live session below */
    }
    this.registry.replaceProvider(appSessionId, newSessionId, {
      tokensIn: carryover.tokensIn,
      tokensOut: carryover.tokensOut,
      contextTokens: 0,
    });
    await this.lifecycle.close(appSessionId, 'preserve-pending');
    // SessionLifecycle.close() clears the usage offset for this app id, so seed it AFTER the
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
    appSessionId: string,
    customInstructions?: string,
  ): Promise<void> {
    const historical = this.registry.resolveSummary(appSessionId);
    const oldProviderSessionId = historical?.providerSessionId ?? appSessionId;
    try {
      const result = await this.withSession(appSessionId, (session) =>
        session.compactSession(customInstructions ? { customInstructions } : {}),
      );
      if (!result) return;
      const newSessionId = result.newSessionId || oldProviderSessionId;
      if (newSessionId !== oldProviderSessionId && historical) {
        this.registry.replaceProvider(historical.appSessionId, newSessionId);
      }
    } catch (err) {
      this.emitError({
        providerSessionId: oldProviderSessionId,
        appSessionId: historical?.appSessionId ?? appSessionId,
        message: `Could not compact session: ${errMsg(err)}`,
      });
    }
  }

  private async setAutonomy(appSessionId: string, autonomy: Autonomy): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    if (!liveSession) {
      this.emitError({
        appSessionId: appSessionId,
        message: 'Autonomy can only be changed on a live session.',
      });
      return;
    }
    const nextAutonomy = normalizeAutonomy(autonomy);
    if (!nextAutonomy) {
      this.emitError({
        appSessionId,
        message: `Unsupported autonomy level: ${autonomy}`,
      });
      return;
    }
    try {
      await liveSession.session.updateSettings({ autonomyLevel: nextAutonomy } as never);
      this.registry.updateSummary(appSessionId, { autonomy: nextAutonomy });
    } catch (err) {
      this.emitError({
        appSessionId,
        message: `Could not change autonomy: ${errMsg(err)}`,
      });
    }
  }

  private async setInteractionMode(
    appSessionId: string,
    mode: SessionInteractionMode,
  ): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    if (!liveSession) {
      this.emitError({
        appSessionId,
        message: 'Interaction mode can only be changed on a live session.',
      });
      return;
    }
    const stableAppSessionId = liveSession.summary.appSessionId;
    try {
      if (mode === 'spec') {
        await liveSession.session.enterSpecMode();
        await this.alignSpecModeModel(liveSession);
      } else {
        await liveSession.session.updateSettings({
          interactionMode: mode === 'agi' ? DroidInteractionMode.AGI : DroidInteractionMode.Auto,
        });
      }
      this.registry.updateSummary(stableAppSessionId, { interactionMode: mode });
    } catch (err) {
      this.emitError({
        appSessionId: stableAppSessionId,
        message: `Could not switch interaction mode: ${errMsg(err)}`,
      });
    }
  }

  // Spec-mode turns run on specModeModelId. Align it with the session's visible
  // model so toggling into spec never switches models silently.
  private async alignSpecModeModel(liveSession: LiveSession): Promise<void> {
    const { modelId, reasoningEffort } = liveSession.summary;
    if (!modelId) return;
    const specSettings: Record<string, unknown> = { specModeModelId: modelId };
    if (reasoningEffort) specSettings.specModeReasoningEffort = reasoningEffort;
    await liveSession.session.updateSettings(specSettings);
  }

  // eslint-disable-next-line complexity -- Session-setting policy is preserved as-is in this extraction.
  private async updateSessionSettings(
    requestedAppSessionId: string,
    settings: {
      modelId?: string | null;
      reasoningEffort?: ReasoningEffort;
    },
  ): Promise<void> {
    const liveSession = this.registry.getLive(requestedAppSessionId);
    const historical = this.registry.resolveSummary(requestedAppSessionId);
    const appSessionId =
      liveSession?.summary.appSessionId ?? historical?.appSessionId ?? requestedAppSessionId;
    const patch: Partial<SessionSummary> = {};
    const next: Record<string, unknown> = {};
    if (settings.modelId !== undefined) {
      // A null model means "reset to Default". The daemon has no such notion,
      // so resolve the actual default and push it; silently dropping the update
      // would leave the daemon generating with the previously selected model.
      // specModeModelId mirrors it because spec-mode turns run on that setting.
      const summaryForMode = liveSession?.summary ?? historical;
      const effectiveModelId =
        settings.modelId ??
        defaultModelForAgent(
          'primary',
          summaryForMode ? defaultsModeForSummary(summaryForMode) : 'auto',
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
      await activeSession.updateSettings(next);
      return activeSession;
    });
    if (liveSession) this.registry.updateSummary(appSessionId, patch);
    if (liveSession && settings.modelId !== undefined) {
      // The model drives the auto-compaction threshold; recompute it so the
      // daemon doesn't keep compacting against the old model's limit.
      await this.recomputeSessionCompactionLimit(liveSession);
    }
    if (liveSession && session) await this.refreshContext(appSessionId, session);
  }

  private async openChildSession(
    appSessionId: string,
    childProviderSessionId: string,
    role: SessionRole,
  ): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    if (!liveSession) {
      // No live session to open against (e.g. a not-yet-resumed/historical
      // session). Settle the worker's loading state with an honest empty open
      // instead of leaving its card spinning forever.
      this.emit({
        type: 'child.updated',
        appSessionId: appSessionId,
        providerSessionId: childProviderSessionId,
        role,
        status: 'opened',
      });
      return;
    }
    if (!this.childBelongsToSession(liveSession, childProviderSessionId)) {
      this.emit({
        type: 'child.updated',
        appSessionId,
        providerSessionId: childProviderSessionId,
        role,
        status: 'opened',
      });
      return;
    }
    if (liveSession.childSessions.has(childProviderSessionId)) {
      const childSession = liveSession.childSessions.get(childProviderSessionId);
      if (childSession) childSession.lastUsedAt = Date.now();
      this.emit({
        type: 'child.updated',
        appSessionId,
        providerSessionId: childProviderSessionId,
        role,
        status: 'opened',
      });
      return;
    }
    try {
      if (!(await this.ensureChildSessionCapacity(liveSession, childProviderSessionId))) return;
      const ref = { id: appSessionId };
      const session = await this.runtime.loadSession(childProviderSessionId, {
        permissionHandler: this.makePermissionHandler(ref),
        askUserHandler: this.makeAskUserHandler(ref),
      });
      const actualSettings = childSessionSettingsFromInit(session.initResult);
      // A chat/spec child inherits the parent session model when the
      // droid inherits it. Mission Control workers/validators keep their own
      // configured model selection untouched.
      const inheritsSessionModel = liveSession.summary.sessionPurpose !== 'mission-control';
      const resolvedSettings: ChildSessionSettings = inheritsSessionModel
        ? {
            modelId: actualSettings.modelId ?? liveSession.summary.modelId,
            reasoningEffort: actualSettings.reasoningEffort ?? liveSession.summary.reasoningEffort,
          }
        : actualSettings;
      if (resolvedSettings.modelId || resolvedSettings.reasoningEffort) {
        liveSession.childSessionSettings.set(childProviderSessionId, resolvedSettings);
        this.emit({
          type: 'session.child',
          appSessionId,
          event: 'updated',
          providerSessionId: childProviderSessionId,
          ...resolvedSettings,
        });
      }
      // When the loaded child session doesn't report its own model, use
      // the role's configured model (not the primary's), so per-model limits
      // and context-window clamps stay correct for differing worker/validator models.
      const workerModelId =
        resolvedSettings.modelId ??
        this.childSessionModelId(liveSession, childProviderSessionId, role);
      // Workers auto-compact in place via the daemon's own threshold check,
      // using the worker model's effective limit (so differing worker/validator
      // models keep their own thresholds).
      await this.enableDaemonAutoCompaction(session, await this.compactionLimit(workerModelId));
      const childSession: LiveChildSession = {
        session,
        providerSessionId: childProviderSessionId,
        appSessionId,
        role,
        streaming: false,
        autoCompacting: false,
        pendingSends: [],
        lastUsedAt: Date.now(),
      };
      childSession.unsubscribe = session.onNotification((note: Record<string, unknown>) => {
        // The daemon's auto-compaction notifications are handled by
        // handleCompactionNotification, which owns the child session's status and
        // refresh; any other notification is normalized and applied here.
        if (
          this.handleCompactionNotification(
            appSessionId,
            childProviderSessionId,
            role,
            session,
            note,
          )
        )
          return;
        for (const n of normalizeNotification(appSessionId, childProviderSessionId, role, note))
          this.applyNormalizedForSource(appSessionId, childProviderSessionId, n);
      });
      liveSession.childSessions.set(childProviderSessionId, childSession);
      this.emitChildSessionHistory(appSessionId, childProviderSessionId);
      this.emit({
        type: 'child.updated',
        appSessionId,
        providerSessionId: childProviderSessionId,
        role,
        status: 'opened',
      });
    } catch (err) {
      this.emit({
        type: 'error',
        code: 'child.open_failed',
        appSessionId,
        providerSessionId: childProviderSessionId,
        message: errMsg(err),
      });
    }
  }

  private emitChildSessionHistory(appSessionId: string, childProviderSessionId: string): void {
    try {
      const page = loadSessionPage(childProviderSessionId, appSessionId, undefined, 200);
      for (const event of page.events) this.emitTranscript(event);
    } catch {
      /* Some live child sessions have not flushed history yet. Notifications still stream after open. */
    }
  }

  private async sendChildSession(
    appSessionId: string,
    childProviderSessionId: string,
    text: string,
  ): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    if (!liveSession) return;
    if (!this.childBelongsToSession(liveSession, childProviderSessionId)) return;
    if (!liveSession.childSessions.has(childProviderSessionId))
      await this.openChildSession(appSessionId, childProviderSessionId, 'worker');
    const childSession = liveSession.childSessions.get(childProviderSessionId);
    if (!childSession) return;
    childSession.lastUsedAt = Date.now();
    if (childSession.streaming || childSession.autoCompacting) {
      childSession.pendingSends.push(text);
      return;
    }
    await this.driveChildSession(childSession, text);
  }

  private async driveChildSession(childSession: LiveChildSession, text: string): Promise<void> {
    childSession.streaming = true;
    childSession.lastUsedAt = Date.now();
    this.registry
      .getLive(childSession.appSessionId)
      ?.terminalSources.delete(childSession.session.sessionId);
    this.emit({
      type: 'child.updated',
      appSessionId: childSession.appSessionId,
      providerSessionId: childSession.session.sessionId,
      role: childSession.role,
      status: 'running',
    });
    this.startContextPolling(childSession.session.sessionId, childSession.session);
    try {
      const stream = childSession.session.stream(text, { includePartialMessages: true });
      for await (const ev of stream)
        this.applyEvent(
          childSession.appSessionId,
          childSession.session.sessionId,
          childSession.role,
          ev,
        );
    } catch (err) {
      if (childSession.interruptingForSteer)
        this.emitStatus(childSession.appSessionId, 'Child-session turn interrupted for steering.');
      else if (!(childSession.interrupting && isUserCancellation(err))) {
        const message = errMsg(err);
        this.emit({
          type: 'child.not_steerable',
          appSessionId: childSession.appSessionId,
          providerSessionId: childSession.session.sessionId,
          message,
        });
        this.emit({
          type: 'error',
          code: 'child.not_steerable',
          appSessionId: childSession.appSessionId,
          providerSessionId: childSession.session.sessionId,
          message,
        });
      }
    } finally {
      this.stopContextPolling(childSession.session.sessionId);
      childSession.interruptingForSteer = false;
      childSession.interrupting = false;
      if (
        childSession.pendingSends.length === 0 &&
        childSession.closeWhenIdle &&
        !childSession.autoCompacting
      ) {
        childSession.streaming = false;
        // closeChildSession resolves the worker by the child-map id, which is not
        // guaranteed to match the live session id.
        await this.closeChildSession(childSession.appSessionId, childSession.providerSessionId);
      } else {
        // Refresh while streaming stays true so concurrent sends queue instead
        // of racing a second driveChildSession(). The daemon auto-compacts the worker
        // in place (same session id), so no swap handling is needed here.
        await this.refreshContext(childSession.session.sessionId, childSession.session);
        childSession.streaming = false;
        if (childSession.autoCompacting) {
          // Key by the child-map id: every other watchdog op (initial arm,
          // interrupt, close, expiry lookup) uses it, so the tightened timer
          // actually replaces the 5-minute one.
          this.autoCompactionWatchdogs.arm(
            childSession.providerSessionId,
            POST_TURN_AUTO_COMPACTION_WATCHDOG_MS,
          );
        } else {
          const next = childSession.pendingSends.shift();
          if (next !== undefined) void this.driveChildSession(childSession, next);
          else
            this.emit({
              type: 'child.updated',
              appSessionId: childSession.appSessionId,
              providerSessionId: childSession.session.sessionId,
              role: childSession.role,
              status: 'paused',
            });
        }
      }
    }
  }

  private async sendChildSessionNow(
    appSessionId: string,
    childProviderSessionId: string,
    text: string,
  ): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    if (!liveSession) return;
    if (!this.childBelongsToSession(liveSession, childProviderSessionId)) return;
    if (!liveSession.childSessions.has(childProviderSessionId))
      await this.openChildSession(appSessionId, childProviderSessionId, 'worker');
    const childSession = liveSession.childSessions.get(childProviderSessionId);
    if (!childSession) return;
    childSession.lastUsedAt = Date.now();
    if (!childSession.streaming && !childSession.autoCompacting) {
      await this.driveChildSession(childSession, text);
      return;
    }
    childSession.pendingSends.unshift(text);
    if (childSession.autoCompacting) return;
    childSession.interruptingForSteer = true;
    this.emitStatus(appSessionId, 'Steering child session now...');
    try {
      await childSession.session.interrupt();
    } catch (err) {
      childSession.interruptingForSteer = false;
      this.emit({
        type: 'error',
        code: 'child.send_now_failed',
        appSessionId,
        providerSessionId: childProviderSessionId,
        message: `Could not interrupt child session for steering: ${errMsg(err)}`,
      });
    }
  }

  private async interruptChildSession(
    appSessionId: string,
    childProviderSessionId: string,
  ): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    if (!liveSession) return;
    if (!this.childBelongsToSession(liveSession, childProviderSessionId)) return;
    if (!liveSession.childSessions.has(childProviderSessionId))
      await this.openChildSession(appSessionId, childProviderSessionId, 'worker');
    const childSession = liveSession.childSessions.get(childProviderSessionId);
    if (!childSession) return;
    childSession.pendingSends = [];
    childSession.lastUsedAt = Date.now();
    // Same escape hatch as the primary session: interrupt first, and settle the
    // wedged auto-compaction flag only once the interrupt landed.
    const wasAutoCompacting = childSession.autoCompacting;
    childSession.interrupting = true;
    await childSession.session.interrupt();
    if (wasAutoCompacting) {
      childSession.autoCompacting = false;
      this.autoCompactionWatchdogs.clear(childProviderSessionId);
    }
    // If no driveChildSession() is active to clear the flag in its finally, clear it
    // here so it can't leak into a later turn and misclassify its cancellation.
    if (!childSession.streaming) childSession.interrupting = false;
    childSession.streaming = false;
    this.emit({
      type: 'child.updated',
      appSessionId,
      providerSessionId: childProviderSessionId,
      role: childSession.role,
      status: 'paused',
    });
  }

  private childBelongsToSession(liveSession: LiveSession, childProviderSessionId: string): boolean {
    if (liveSession.summary.sessionPurpose === 'mission-control') return true;
    if (liveSession.knownChildSessions.has(childProviderSessionId)) return true;
    if (liveSession.linkedChildSessions.has(childProviderSessionId)) return true;
    const appSessionId = liveSession.summary.appSessionId;
    this.emit({
      type: 'error',
      code: 'child.not_in_session',
      appSessionId,
      providerSessionId: childProviderSessionId,
      message: `Child session ${childProviderSessionId} is not tied to session ${appSessionId}.`,
    });
    return false;
  }

  private async ensureChildSessionCapacity(
    liveSession: LiveSession,
    requestedProviderSessionId: string,
  ): Promise<boolean> {
    if (liveSession.childSessions.size < MAX_OPEN_CHILD_SESSIONS) return true;
    const idle = [...liveSession.childSessions.entries()]
      .filter(
        ([providerSessionId, childSession]) =>
          providerSessionId !== requestedProviderSessionId &&
          !childSession.streaming &&
          !childSession.autoCompacting &&
          childSession.pendingSends.length === 0,
      )
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
      .at(0);
    if (idle) {
      await this.closeChildSession(liveSession.summary.appSessionId, idle[0]);
      return true;
    }
    this.emitError({
      appSessionId: liveSession.summary.appSessionId,
      // Scope to the requested child session so its loading state settles, not just the
      // session-level toast.
      providerSessionId: requestedProviderSessionId,
      message: `Open child-session limit reached (${String(MAX_OPEN_CHILD_SESSIONS)}). Wait for one running child view to finish before opening another.`,
    });
    return false;
  }

  private async closeChildSession(
    appSessionId: string,
    childProviderSessionId: string,
  ): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    const childSession = liveSession?.childSessions.get(childProviderSessionId);
    if (!liveSession || !childSession) return;
    liveSession.childSessions.delete(childProviderSessionId);
    this.childSessionCompactions.delete(childProviderSessionId);
    this.contextSnapshots.delete(childProviderSessionId);
    this.autoCompactionWatchdogs.clear(childProviderSessionId);
    this.stopContextPolling(childSession.session.sessionId);
    childSession.unsubscribe?.();
    try {
      await childSession.session.close();
    } catch {
      /* ignore */
    }
  }

  private async closeChildSessionWhenIdle(
    appSessionId: string,
    childProviderSessionId: string,
  ): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    const childSession = liveSession?.childSessions.get(childProviderSessionId);
    if (!liveSession || !childSession) return;
    childSession.closeWhenIdle = true;
    if (
      !childSession.streaming &&
      !childSession.autoCompacting &&
      childSession.pendingSends.length === 0
    )
      await this.closeChildSession(appSessionId, childProviderSessionId);
  }

  private async renameSession(requestedAppSessionId: string, title: string): Promise<void> {
    await this.withSession(requestedAppSessionId, (session) => session.renameSession({ title }));
    const appSessionId =
      this.registry.getLive(requestedAppSessionId)?.summary.appSessionId ??
      this.registry.resolveSummary(requestedAppSessionId)?.appSessionId;
    if (appSessionId) this.registry.updateSummary(appSessionId, { title });
  }

  private async withSession<T>(
    appSessionId: string,
    fn: (session: FactorySession) => Promise<T>,
  ): Promise<T | undefined> {
    const liveSession = this.registry.getLive(appSessionId);
    const live = liveSession?.session;
    if (live) return fn(live);
    const providerSessionId =
      this.registry.resolveSummary(appSessionId)?.providerSessionId ?? appSessionId;
    const session = await this.runtime.loadSession(providerSessionId);
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  private async catalogSession(
    providerSessionId?: string,
  ): Promise<{ session: FactorySession; close: () => Promise<void> }> {
    const first = this.registry.liveSessionsSnapshot().at(0);
    const live = providerSessionId
      ? this.registry.getLive(providerSessionId)?.session
      : first?.session;
    if (live) return { session: live, close: () => Promise.resolve() };
    const session = await this.runtime.createSession({
      cwd: tmpdir(),
      interactionMode: 'auto',
      autonomyLevel: 'low',
    });
    return { session, close: () => session.close() };
  }

  private async emitToolCatalog(providerSessionId?: string): Promise<void> {
    const { session, close } = await this.catalogSession(providerSessionId);
    try {
      const result = await session.listTools();
      this.emit({ type: 'catalog.updated', catalog: 'tools', items: arrayItems(result, 'tools') });
    } finally {
      await close();
    }
  }

  private async emitSkillCatalog(providerSessionId?: string): Promise<void> {
    const { session, close } = await this.catalogSession(providerSessionId);
    try {
      const result = await session.listSkills();
      this.emit({
        type: 'catalog.updated',
        catalog: 'skills',
        items: arrayItems(result, 'skills'),
        providerSessionId: providerSessionId ?? null,
      });
    } finally {
      await close();
    }
  }

  private async emitMcpCatalog(providerSessionId?: string): Promise<void> {
    const { session, close } = await this.catalogSession(providerSessionId);
    try {
      const servers = await session.listMcpServers();
      const tools = await session.listMcpTools();
      this.emit({ type: 'catalog.updated', catalog: 'mcp', items: [{ servers, tools }] });
    } finally {
      await close();
    }
  }

  private startContextPolling(sourceSessionId: string, session: FactorySession): void {
    if (this.contextPollers.has(sourceSessionId)) return;
    const poll = () => void this.refreshContext(sourceSessionId, session, { persist: false });
    const timer = setInterval(poll, 2_500);
    this.contextPollers.set(sourceSessionId, timer);
    poll();
  }

  private stopContextPolling(sourceSessionId: string): void {
    const timer = this.contextPollers.get(sourceSessionId);
    if (!timer) return;
    clearInterval(timer);
    this.contextPollers.delete(sourceSessionId);
  }

  private emitContextEstimate(sourceSessionId: string, summary: SessionSummary): void {
    if (summary.contextTokens <= 0) return;
    const previous = this.contextSnapshots.get(sourceSessionId);
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
    this.contextSnapshots.set(sourceSessionId, snapshot);
    this.emit({
      type: 'context.updated',
      appSessionId: summary.appSessionId,
      sourceSessionId,
      stats: snapshot,
    });
  }

  // eslint-disable-next-line complexity -- Context accounting remains with its PR 5 owner.
  private async refreshContext(
    sourceSessionId: string,
    session: FactorySession,
    options: { persist?: boolean } = {},
  ): Promise<void> {
    try {
      const stats = await session.getContextStats();
      const breakdown = await this.readContextBreakdown(session);
      let snapshot = contextStatsSnapshot(stats, breakdown);
      const liveSession =
        this.registry.getLive(sourceSessionId) ??
        this.registry
          .liveSessionsSnapshot()
          .find((candidate) => candidate.childSessions.has(sourceSessionId));
      const appSessionId = liveSession?.summary.appSessionId ?? sourceSessionId;
      const isPrimarySession =
        liveSession !== undefined &&
        (sourceSessionId === liveSession.summary.appSessionId ||
          sourceSessionId === liveSession.summary.providerSessionId);
      // The daemon's get_context_stats is a chars/4 estimate that over-counts;
      // when a provider-reported reading exists it matches the compaction
      // threshold count exactly, so it wins over the estimate. The stats call
      // still supplies the limit and breakdown.
      const exact =
        liveSession?.summary.contextAccuracy === 'exact' && liveSession.summary.contextTokens > 0
          ? liveSession.summary.contextTokens
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
      // Child sessions have no top-level session summary to carry a compaction
      // generation, so the snapshot carries it for the meter's ratchet reset.
      if (!isPrimarySession)
        snapshot = {
          ...snapshot,
          compactions: this.childSessionCompactions.get(sourceSessionId) ?? 0,
        };
      this.contextSnapshots.set(sourceSessionId, snapshot);
      this.emit({
        type: 'context.updated',
        appSessionId,
        sourceSessionId,
        stats: snapshot,
      });
      if (liveSession && isPrimarySession) {
        const contextPatch = {
          contextTokens: snapshot.used,
          contextRemainingTokens: snapshot.remaining,
          // summary.maxContextTokens means "model window". The catalog wins;
          // the daemon's stats limit only fills in for unknown models, so the
          // meter's window row stops flip-flopping between the two sources.
          maxContextTokens: this.maxContextTokensForSummary(liveSession.summary) ?? snapshot.limit,
          contextAccuracy: snapshot.accuracy,
          contextUpdatedAt: snapshot.updatedAt,
        };
        if (options.persist === false)
          liveSession.summary = { ...liveSession.summary, ...contextPatch };
        else this.registry.updateSummary(appSessionId, contextPatch);
      }
    } catch {
      /* context stats are informational; keep the active turn path clean */
    }
  }

  private async readContextBreakdown(
    session: FactorySession,
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

  private clearSessionRuntimeCaches(liveSession: LiveSession): void {
    const appSessionId = liveSession.summary.appSessionId;
    for (const [childProviderSessionId, childSession] of liveSession.childSessions) {
      this.contextSnapshots.delete(childSession.session.sessionId);
      this.contextSnapshots.delete(childProviderSessionId);
      this.childSessionCompactions.delete(childProviderSessionId);
    }
    this.usageOffsets.delete(appSessionId);
    this.contextSnapshots.delete(appSessionId);
    if (liveSession.summary.providerSessionId)
      this.contextSnapshots.delete(liveSession.summary.providerSessionId);
  }

  private emitError(error: {
    code?: string;
    providerSessionId?: string;
    appSessionId?: string;
    message: string;
    recoverable?: boolean;
  }): void {
    this.emit({ type: 'error', ...error });
  }

  private async handleBrowser(
    appSessionId: string | undefined,
    action: () => unknown,
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
            `Droid Control browser did not respond to ${request.action} within ${String(BROWSER_NATIVE_TIMEOUT_MS)}ms.`,
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
    await this.lifecycle.closeAll();
    await this.browsers.closeAll();
    this.history.close();
  }
}

function hasSessionCloseStarted(liveSession: LiveSession): boolean {
  return liveSession.closeMode !== undefined;
}

function childSessionSettingsFromInit(init: SessionInitResult): ChildSessionSettings {
  return {
    modelId: init.settings?.modelId,
    reasoningEffort: reasoningValue(init.settings?.reasoningEffort),
  };
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
    accuracy: stats.accuracy,
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
  const firstModel = models.at(0);
  if (!firstModel) return runtimeFactoryDefaultsWithoutCatalog(defaults);
  const cliDefault =
    models.find((model) => model.isDefault && !model.isCustom) ??
    models.find((model) => !model.isCustom) ??
    firstModel;
  return {
    ...defaults,
    modelId: validModelId(defaults.modelId, models) ?? cliDefault.id,
    reasoningEffort:
      validReasoning(defaults.modelId, defaults.reasoningEffort, models) ??
      cliDefault.defaultReasoningEffort,
    compactionModel: validCompactionModel(defaults.compactionModel, models),
    compactionTokenLimit: normalizeCompactionTokenLimit(defaults.compactionTokenLimit),
    compactionTokenLimitPerModel: validCompactionTokenLimitPerModel(
      defaults.compactionTokenLimitPerModel,
      models,
    ),
    specModelId:
      validModelId(defaults.specModelId, models) ??
      validModelId(defaults.modelId, models) ??
      cliDefault.id,
    specReasoningEffort: validReasoning(defaults.specModelId, defaults.specReasoningEffort, models),
    workerModelId: validModelId(defaults.workerModelId, models) ?? cliDefault.id,
    workerReasoningEffort: validReasoning(
      defaults.workerModelId,
      defaults.workerReasoningEffort,
      models,
    ),
    validatorModelId: validModelId(defaults.validatorModelId, models) ?? cliDefault.id,
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

function defaultModelForAgent(
  agent: ConfigurableSessionRole,
  mode: SessionInteractionMode,
  defaults: FactoryDefaultSettings,
): string | undefined {
  if (agent === 'worker') return defaults.workerModelId;
  if (agent === 'validator') return defaults.validatorModelId;
  return modelDefaultForMode(mode, defaults);
}

function defaultsModeForSummary(summary: SessionSummary): SessionInteractionMode {
  if (summary.sessionPurpose === 'mission-control') return 'agi';
  if (summary.interactionMode === 'spec') return 'spec';
  return 'auto';
}

// Model-generated transcript kinds that, once a turn is terminal, would form a
// second/buried final response if appended. A failed result (isError) and
// non-transcript signals (tokens, state, worker, child session) are never quarantined.
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
  n: NonNullable<ReturnType<typeof normalizeStreamEvent>>,
): boolean {
  return Boolean(
    n.features ?? n.progress ?? n.missionState ?? n.missionChild ?? n.childSession ?? n.tokens,
  );
}
