import { DroidInteractionMode, type McpServerConfig } from '@factory/droid-sdk';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type {
  Autonomy,
  BrowserNativeRequest,
  BrowserNativeResult,
  ClientCommand,
  ConfigurableSessionRole,
  FactoryDefaultSettings,
  InstallChannel,
  SessionSummary,
  ModelInfo,
  ReasoningEffort,
  ServerEvent,
  SessionInteractionMode,
} from './protocol.js';
import {
  defaultsModeForSummary,
  errMsg,
  isDesignStudioSession,
  isUserCancellation,
  modelDefaultForMode,
  normalizeAutonomy,
  reasoningValue,
  type SessionInitResult,
} from './sessionHelpers.js';
import { boundedInt } from './values.js';
import { DroidRuntime, type FactoryRuntime, type FactorySession } from './DroidRuntime.js';
import { detectEnvironment } from './Environment.js';
import { buildInstallCommand, buildUpdateCommand, runStreaming } from './CliInstaller.js';
import {
  HistoryIndex,
  loadHistoricalSessions,
  loadMissionControlSessions,
  readFactoryDefaults,
} from './history.js';
import { mergeModelCatalog } from './modelCatalog.js';
import { readDroidCliModelCatalog, readDroidCliModelCatalogCache } from './DroidCliCatalog.js';
import { BrowserSessionManager } from './browser/BrowserSessionManager.js';
import { createBrowserMcpServer } from './browser/browserMcpServer.js';
import { isDesignPrompt } from './browser/designPromptPacks.js';
import { NativeBrowserRuntime } from './browser/NativeBrowserRuntime.js';
import { SessionRegistry } from './SessionRegistry.js';
import { SessionEventFlow, type NormalizedSideEffects } from './SessionEventFlow.js';
import { SessionInteractions } from './SessionInteractions.js';
import { SessionTimeline } from './SessionTimeline.js';
import { SessionContext, type LiveOperationTarget } from './SessionContext.js';
import {
  SessionCompaction,
  type AutoCompactionSettlement,
  type AutomaticCompactionTarget,
  type CompactionResourceKey,
  type CompactionRetuneTarget,
  type PrimaryAutomaticCompactionTarget,
  type PrimaryCompactionTarget,
} from './SessionCompaction.js';
import {
  SessionLifecycle,
  type LiveSession,
  type StartedLocalMcpResources,
} from './SessionLifecycle.js';
import {
  guardProviderStream,
  ProviderStreamInactivityError,
  type ProviderStreamInactivityConfig,
} from './providerStreamInactivity.js';
import { ChildSessions } from './ChildSessions.js';
import type { ChildSettings } from './ChildSessionState.js';
import { MissionControlPolicy } from './MissionControlPolicy.js';
import type { SessionListFilterOptions } from './sessionListFilter.js';
import { normalizeCompactionTokenLimit } from './compaction.js';

type Emit = (event: ServerEvent) => void;

type SessionHistory = Pick<
  HistoryIndex,
  | 'syncSummaries'
  | 'summaryPatches'
  | 'hiddenProviderSessionIds'
  | 'childSessions'
  | 'childSession'
  | 'upsertChildSession'
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
  getFactoryDefaults?: () => Promise<FactoryDefaultSettings>;
  nextChildSessionId?: () => string;
}

export interface SessionManagerOptions {
  assetUrlFor?: (path: string) => string;
  dependencies?: SessionManagerDependencies;
  initialModels?: ModelInfo[];
  providerStreamInactivity?: ProviderStreamInactivityConfig;
}

export interface AgentSettingPatch {
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
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

let nativeBrowserSeq = 0;
const nextNativeBrowserRequestId = () =>
  `browser-native-${Date.now().toString(36)}-${(nativeBrowserSeq++).toString(36)}`;
const nextChildSessionId = () => `child-${randomUUID()}`;

interface PendingNativeBrowserRequest {
  resolve: (result: BrowserNativeResult) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class SessionManager {
  private ready = false;
  private cachedModels: ModelInfo[] | null = null;
  private modelRefresh: Promise<ModelInfo[] | null> | null = null;
  // Context windows observed from provider stats for catalog-missing models.
  private readonly learnedModelContextWindows = new Map<string, number>();
  private readonly runtime: FactoryRuntime;
  private readonly history: SessionHistory;
  private readonly registry: SessionRegistry<LiveSession>;
  private readonly timeline: SessionTimeline;
  private readonly interactions: SessionInteractions;
  private readonly eventFlow: SessionEventFlow;
  private readonly context: SessionContext;
  private readonly compaction: SessionCompaction;
  private readonly childSessions: ChildSessions;
  private readonly missionControlPolicy: MissionControlPolicy;
  private readonly lifecycle: SessionLifecycle;
  private readonly pendingAgentSettings = new Map<
    string,
    Partial<Record<ConfigurableSessionRole, AgentSettingPatch>>
  >();
  private shutdownPromise?: Promise<void>;
  private readonly pendingNativeBrowserRequests = new Map<string, PendingNativeBrowserRequest>();
  private readonly browsers: SessionBrowsers;
  private readonly createLocalMcpResource: SessionManagerDependencies['createLocalMcpResource'];
  private readonly factoryDefaultsOverride: SessionManagerDependencies['getFactoryDefaults'];
  private readonly nextChildSessionId: () => string;
  private readonly providerStreamInactivity?: ProviderStreamInactivityConfig;

  constructor(
    private readonly emit: Emit,
    options: SessionManagerOptions = {},
  ) {
    this.providerStreamInactivity = options.providerStreamInactivity;
    if (options.dependencies) {
      this.runtime = options.dependencies.runtime;
      this.history = options.dependencies.history;
      this.browsers = options.dependencies.browsers;
      this.createLocalMcpResource = options.dependencies.createLocalMcpResource;
      this.factoryDefaultsOverride = options.dependencies.getFactoryDefaults;
      this.nextChildSessionId = options.dependencies.nextChildSessionId ?? nextChildSessionId;
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
      this.factoryDefaultsOverride = undefined;
      this.nextChildSessionId = nextChildSessionId;
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
    this.context = new SessionContext({
      registry: this.registry,
      runtime: this.runtime,
      emit: (event) => {
        this.emit(event);
      },
      maxContextTokensForSummary: (summary) => this.maxContextTokensForSummary(summary),
      noteContextWindow: (modelId, contextWindowTokens) => {
        this.noteModelContextWindow(modelId, contextWindowTokens);
      },
    });
    this.timeline = new SessionTimeline({
      registry: this.registry,
      history: this.history,
      getChildSessions: (appSessionId) => this.childSessions.list(appSessionId),
      emit: (event) => {
        this.emit(event);
      },
      emitError: (error) => {
        this.emitError(error);
      },
      now: Date.now,
    });
    this.interactions = new SessionInteractions({
      getLiveSession: (id) => this.registry.getLive(id),
      updateSummary: (id, patch) => {
        this.registry.updateSummary(id, patch);
      },
      emit: (event) => {
        this.emit(event);
      },
      emitError: (error) => {
        this.emitError(error);
      },
    });
    this.compaction = new SessionCompaction({
      registry: this.registry,
      context: this.context,
      timeline: this.timeline,
      runtime: this.runtime,
      makePermissionHandler: (ref) => this.interactions.makePermissionHandler(ref),
      makeAskUserHandler: (ref) => this.interactions.makeAskUserHandler(ref),
      emitError: (error) => {
        this.emitError(error);
      },
      isShutdownStarted: () => this.shutdownPromise !== undefined,
      getFactoryDefaults: () => this.getFactoryDefaults(),
      maxContextTokensForModel: (modelId) => this.maxContextTokensForModel(modelId),
      resolveAutomaticTarget: (key) => this.resolveAutomaticCompactionTarget(key),
      settleAutomatic: (settlement) => {
        this.settleAutomaticCompaction(settlement);
      },
    });
    this.eventFlow = new SessionEventFlow({
      appendTranscript: (event) => {
        this.timeline.append(event);
      },
      applySideEffects: (appSessionId, sideEffects) => {
        this.applyEventSideEffects(appSessionId, sideEffects);
      },
      recordUsage: (appSessionId, sourceProviderSessionId, usage) => {
        this.context.recordUsage(appSessionId, sourceProviderSessionId, usage);
      },
    });
    this.childSessions = new ChildSessions({
      runtime: this.runtime,
      registry: this.registry,
      history: this.history,
      timeline: this.timeline,
      eventFlow: this.eventFlow,
      interactions: this.interactions,
      context: this.context,
      compaction: this.compaction,
      resolveDefaultSettings: (summary, initResult, role) =>
        this.resolveChildDefaultSettings(summary, initResult, role),
      isShutdownStarted: () => this.shutdownPromise !== undefined,
      emit: (event) => {
        this.emit(event);
      },
      nextChildSessionId: this.nextChildSessionId,
      maxOpenSessions: MAX_OPEN_CHILD_SESSIONS,
      now: Date.now,
    });
    this.missionControlPolicy = new MissionControlPolicy({
      registry: this.registry,
      childSessions: this.childSessions,
      resolveCatalogDefaultSettings: () => this.resolveCatalogDefaultSettings(),
      emit: (event) => {
        this.emit(event);
      },
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
      makePermissionHandler: (ref) => this.interactions.makePermissionHandler(ref),
      makeAskUserHandler: (ref) => this.interactions.makeAskUserHandler(ref),
      compaction: this.compaction,
      compactBeforeSend: (appSessionId) => this.compactSession(appSessionId),
      isShutdownStarted: () => this.shutdownPromise !== undefined,
      childSessions: this.childSessions,
      applyPendingSettingsToSummary: (summary) => this.applyPendingSettingsToSummary(summary),
      applyPendingSessionSettings: (appSessionId) => this.applyPendingSessionSettings(appSessionId),
      runPrimaryTurn: (liveSession, prompt, abortSignal) =>
        this.runPrimaryTurn(liveSession, prompt, abortSignal),
      context: this.context,
      forgetInteractions: (appSessionId) => {
        this.interactions.forgetSession(appSessionId);
      },
      forgetEventFlow: (appSessionId) => {
        this.eventFlow.forgetSession(appSessionId);
      },
      forgetMissionControl: (appSessionId) => {
        this.missionControlPolicy.forget(appSessionId);
      },
      closeBrowserSession: (appSessionId) => this.browsers.close(appSessionId),
      emit: (event) => {
        this.emit(event);
      },
      emitError: (error) => {
        this.emitError(error);
      },
      emitStatus: (appSessionId, text) => {
        this.timeline.appendStatus(appSessionId, text);
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
    if (this.shutdownPromise) throw new Error('Session manager is shutting down.');
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
        await this.interactions.respondToApproval(cmd.appSessionId, cmd.requestId, cmd.outcome);
        return;
      case 'question.respond':
        this.interactions.respondToQuestion(
          cmd.appSessionId,
          cmd.requestId,
          cmd.cancelled,
          cmd.answers,
        );
        return;
      case 'session.interrupt':
        await this.lifecycle.interrupt(cmd.appSessionId);
        return;
      case 'child.open':
        await this.childSessions.open(cmd);
        return;
      case 'child.send':
        await this.childSessions.send(cmd, cmd.text);
        return;
      case 'child.sendNow':
        await this.childSessions.sendNow(cmd, cmd.text);
        return;
      case 'child.interrupt':
        await this.childSessions.interrupt(cmd);
        return;
      case 'child.updateSettings':
        await this.childSessions.updateSettings(cmd);
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
        await this.compactSession(cmd.appSessionId, cmd.customInstructions);
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
        this.timeline.list();
        return;
      case 'history.page':
        this.timeline.loadProviderPage(cmd.providerSessionId, cmd.cursor, cmd.limit);
        return;
      case 'session.loadHistory':
        this.timeline.load(cmd.appSessionId, cmd.cursor);
        return;
      case 'settings.agent.update':
        await this.updateAgentSettings(cmd);
        return;
      case 'settings.compaction.update':
        await this.compaction.updateLimits(cmd, this.compactionRetuneTargets());
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
    if (this.factoryDefaultsOverride) return this.factoryDefaultsOverride();
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
    return (
      this.cachedModels?.find((model) => model.id === modelId)?.maxContextTokens ??
      this.learnedModelContextWindows.get(modelId)
    );
  }

  // Custom and BYOK models are often missing from the catalog, so their
  // compaction limits initially arm without a window ceiling. The provider's
  // own context stats reveal the window; remember it and retune thresholds.
  private noteModelContextWindow(modelId: string, contextWindowTokens: number): void {
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return;
    const window = Math.floor(contextWindowTokens);
    if (this.cachedModels?.some((model) => model.id === modelId && model.maxContextTokens)) return;
    if (this.learnedModelContextWindows.get(modelId) === window) return;
    this.learnedModelContextWindows.set(modelId, window);
    void this.compaction.retuneAll(this.compactionRetuneTargets());
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
      if (cmd.appSessionId && !session) this.rememberPendingAgentSettings(cmd);
      const appSessionId = session?.summary.appSessionId ?? cmd.appSessionId;
      if (session) {
        const settings = await this.runtimeAgentSettings(session, cmd.agent, {
          modelId: cmd.modelId,
          reasoningEffort: cmd.reasoningEffort,
        });
        await this.applyAgentSessionSettings(session, cmd.agent, settings);
        if (
          this.shutdownPromise ||
          this.registry.getLive(session.summary.appSessionId) !== session ||
          hasSessionCloseStarted(session)
        )
          return;
        if (cmd.appSessionId) this.rememberPendingAgentSettings(cmd);
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
          const stillCurrent = () =>
            !this.shutdownPromise &&
            this.registry.getLive(appSessionId) === session &&
            !hasSessionCloseStarted(session);
          if (cmd.modelId !== undefined)
            await this.compaction.rearmPrimary(this.primaryCompactionTarget(session));
          if (stillCurrent()) await this.context.refresh(this.primaryContextTarget(session));
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

  private compactionRetuneTargets(): CompactionRetuneTarget[] {
    const targets: CompactionRetuneTarget[] = [...this.childSessions.compactionRetuneTargets()];
    for (const liveSession of this.registry.liveSessionsSnapshot()) {
      targets.push(this.primaryCompactionTarget(liveSession));
    }
    return targets;
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
    const stillCurrent = () =>
      !this.shutdownPromise &&
      this.registry.getLive(appSessionId) === liveSession &&
      !hasSessionCloseStarted(liveSession);
    try {
      let patch: Partial<SessionSummary> = {};
      for (const [agent, settings] of Object.entries(pending) as [
        ConfigurableSessionRole,
        AgentSettingPatch,
      ][]) {
        const runtimeSettings = await this.runtimeAgentSettings(liveSession, agent, settings);
        if (!stillCurrent()) return false;
        await this.applyAgentSessionSettings(liveSession, agent, runtimeSettings);
        if (!stillCurrent()) return false;
        patch = { ...patch, ...this.summaryPatchForAgent(agent, settings) };
      }
      if (!stillCurrent()) return false;
      this.registry.updateSummary(appSessionId, patch);
      if (pending.primary?.modelId !== undefined) {
        // A pending primary model applied before send changes the
        // auto-compaction threshold; recompute it to match the new model.
        await this.compaction.rearmPrimary(this.primaryCompactionTarget(liveSession));
      }
      return stillCurrent();
    } catch (err) {
      if (!stillCurrent()) return false;
      this.emitError({
        appSessionId,
        message: `Could not apply selected model before send: ${errMsg(err)}`,
      });
      return false;
    }
  }

  private emitSessionList(options?: SessionListFilterOptions): void {
    this.emit({ type: 'sessions.list', sessions: this.registry.listSummaries(options) });
  }

  private async runPrimaryTurn(
    liveSession: LiveSession,
    prompt: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    const contextTarget = this.primaryContextTarget(liveSession);
    if (!this.isCurrentPrimarySession(liveSession)) return;
    this.eventFlow.beginTurn(appSessionId, appSessionId);
    this.context.beginTurn(appSessionId);
    this.context.startPolling(contextTarget);
    try {
      await this.applyDesignToolPolicy(
        liveSession,
        isDesignStudioSession(liveSession.summary) || isDesignPrompt(prompt),
      );
      if (!this.isCurrentPrimarySession(liveSession)) return;
      const stream = guardProviderStream(
        (streamAbortSignal) =>
          liveSession.session.stream(prompt, {
            includePartialMessages: true,
            abortSignal: streamAbortSignal,
          }),
        abortSignal,
        {
          ...this.providerStreamInactivity,
          settleInactivity: async () => {
            liveSession.interrupting = true;
            await liveSession.session.interrupt();
            liveSession.interrupting = false;
          },
        },
      );
      for await (const ev of stream) {
        if (!this.isCurrentPrimarySession(liveSession)) break;
        this.eventFlow.applyStreamEvent(appSessionId, appSessionId, 'primary', ev);
      }
    } catch (err) {
      if (!this.isCurrentPrimarySession(liveSession)) {
        return;
      } else if (liveSession.interrupting && isUserCancellation(err)) {
        // The user pressed Stop; interrupt() already set the paused phase, so
        // settle quietly without surfacing an error.
        this.registry.updateSummary(appSessionId, { phase: 'paused' });
      } else {
        this.emitError({
          appSessionId,
          message: errMsg(err),
          ...(err instanceof ProviderStreamInactivityError
            ? { code: 'session.stream_inactive', recoverable: true }
            : {}),
        });
        this.registry.updateSummary(appSessionId, { phase: 'failed' });
      }
    } finally {
      this.context.stopPolling(contextTarget);
      // Context telemetry is informational. Turn settlement and queued sends
      // must not wait on a slow or unavailable provider stats endpoint.
      if (this.isCurrentPrimarySession(liveSession)) {
        void this.context.refresh(contextTarget);
      }
    }
  }

  private isCurrentPrimarySession(liveSession: LiveSession): boolean {
    return (
      !this.shutdownPromise &&
      this.registry.getLive(liveSession.summary.appSessionId) === liveSession &&
      !hasSessionCloseStarted(liveSession)
    );
  }

  private primaryContextTarget(liveSession: LiveSession): LiveOperationTarget {
    const session = liveSession.session;
    return {
      appSessionId: liveSession.summary.appSessionId,
      providerSessionId: session.sessionId,
      sourceSessionId: liveSession.summary.appSessionId,
      session,
      isCurrent: () => this.isCurrentPrimarySession(liveSession) && liveSession.session === session,
    };
  }

  private primaryAutomaticCompactionTarget(
    liveSession: LiveSession,
  ): PrimaryAutomaticCompactionTarget {
    return {
      ...this.primaryContextTarget(liveSession),
      kind: 'primary',
      liveSession,
    };
  }

  private primaryCompactionTarget(liveSession: LiveSession): PrimaryCompactionTarget {
    const target = this.primaryAutomaticCompactionTarget(liveSession);
    const configuredModelId = liveSession.summary.modelId;
    const defaultsMode = defaultsModeForSummary(liveSession.summary);
    return {
      ...target,
      configuredModelId,
      defaultsMode,
      isCurrent: () =>
        target.isCurrent() &&
        liveSession.summary.modelId === configuredModelId &&
        defaultsModeForSummary(liveSession.summary) === defaultsMode,
    };
  }

  // Studio sessions and explicit browser Design Mode turns are focused design
  // tasks, so the model does not need TodoWrite — it otherwise loops updating
  // the list after it has already answered. Restore it for ordinary chat turns,
  // calling updateSettings only when the policy changes.
  private async applyDesignToolPolicy(liveSession: LiveSession, design: boolean): Promise<void> {
    // When the in-memory flag is unset (cold start / page reload) we don't
    // know the session's current disabledToolIds, so always call updateSettings
    // to synchronize. Once the flag is set we skip redundant calls.
    if (
      liveSession.todoDisabledForDesign !== undefined &&
      liveSession.todoDisabledForDesign === design
    )
      return;
    if (!this.isCurrentPrimarySession(liveSession)) return;
    try {
      await liveSession.session.updateSettings({ disabledToolIds: design ? ['TodoWrite'] : [] });
      if (!this.isCurrentPrimarySession(liveSession)) return;
      liveSession.todoDisabledForDesign = design;
    } catch (err) {
      if (!this.isCurrentPrimarySession(liveSession)) return;
      this.emitError({
        appSessionId: liveSession.summary.appSessionId,
        message: `Could not update design tool policy: ${errMsg(err)}`,
      });
    }
  }

  private resolveChildDefaultSettings(
    summary: SessionSummary,
    initResult: SessionInitResult,
    role: 'worker' | 'validator',
  ): ChildSettings {
    if (summary.sessionPurpose === 'mission-control')
      return this.missionControlPolicy.resolveDefaultSettings(summary.appSessionId, role);
    const parentSettings = childSessionSettingsFromInit(initResult);
    const roleModelId = role === 'validator' ? summary.validatorModelId : summary.workerModelId;
    const roleReasoningEffort =
      role === 'validator' ? summary.validatorReasoningEffort : summary.workerReasoningEffort;
    const catalogDefault = this.resolveCatalogDefaultSettings();
    return {
      modelId: summary.modelId ?? parentSettings.modelId ?? roleModelId ?? catalogDefault.modelId,
      reasoningEffort:
        summary.reasoningEffort ??
        parentSettings.reasoningEffort ??
        roleReasoningEffort ??
        catalogDefault.reasoningEffort,
    };
  }

  private resolveCatalogDefaultSettings(): ChildSettings {
    const model =
      this.cachedModels?.find((candidate) => candidate.isDefault && !candidate.isCustom) ??
      this.cachedModels?.find((candidate) => !candidate.isCustom) ??
      this.cachedModels?.at(0);
    return {
      modelId: model?.id,
      reasoningEffort: model?.defaultReasoningEffort,
    };
  }

  private applyEventSideEffects(appSessionId: string, n: NormalizedSideEffects): void {
    this.missionControlPolicy.apply(appSessionId, n);
    if (n.childSession) {
      const { toolUseId, ...childSession } = n.childSession;
      this.childSessions.admitChildObservation({
        parentAppSessionId: appSessionId,
        role: 'worker',
        ...childSession,
        ...(toolUseId ? { spawnLink: { kind: 'tool-use', id: toolUseId } } : {}),
      });
    }
  }

  private resolveAutomaticCompactionTarget(
    key: CompactionResourceKey,
  ): AutomaticCompactionTarget | undefined {
    if (key.kind === 'child') return this.childSessions.resolveAutomaticTarget(key);
    const parent = this.registry.getLive(key.appSessionId);
    if (!parent || hasSessionCloseStarted(parent)) return undefined;
    return this.primaryAutomaticCompactionTarget(parent);
  }

  private settleAutomaticCompaction(settlement: AutoCompactionSettlement): void {
    if (settlement.kind === 'primary') {
      void this.lifecycle.settleAfterCompaction(settlement.appSessionId);
      return;
    }
    this.childSessions.settleAutomatic(settlement);
  }

  private async compactSession(
    requestedAppSessionId: string,
    customInstructions?: string,
  ): Promise<void> {
    const previousLiveSession = this.registry.getLive(requestedAppSessionId);
    const appSessionId =
      previousLiveSession?.summary.appSessionId ??
      this.registry.resolveSummary(requestedAppSessionId)?.appSessionId ??
      requestedAppSessionId;
    if (
      previousLiveSession?.streaming ||
      previousLiveSession?.compacting ||
      previousLiveSession?.autoCompacting
    ) {
      this.timeline.appendStatus(
        appSessionId,
        'Cannot compact while a turn is active. Try again when the model is idle.',
      );
      return;
    }
    let readyToSettle = false;
    try {
      const result = await this.compaction.compact(appSessionId, customInstructions);
      if (result.kind === 'close-and-resume') {
        const closeFailure = await this.closeForPermanentCompactionRecovery(result.appSessionId);
        this.context.preserveUsage(result.appSessionId, result.carryover);
        readyToSettle = true;
        if (closeFailure) {
          this.emitError({
            appSessionId: result.appSessionId,
            providerSessionId: previousLiveSession?.session.sessionId,
            message: `Could not fully close the compacted session: ${errMsg(closeFailure.error)}`,
            recoverable: true,
          });
        }
        this.emitError({
          appSessionId: result.appSessionId,
          providerSessionId: result.providerSessionId,
          message: `Compaction moved this conversation to a new session but reloading it failed: ${result.reloadError}. It will reload on your next message.`,
          recoverable: true,
        });
      }
      readyToSettle = true;
    } finally {
      if (readyToSettle) {
        await this.lifecycle.settleAfterCompaction(appSessionId, previousLiveSession);
      }
    }
  }

  private async closeForPermanentCompactionRecovery(
    appSessionId: string,
  ): Promise<{ error: unknown } | undefined> {
    try {
      await this.lifecycle.close(appSessionId, 'preserve-pending');
    } catch (error) {
      return { error };
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
      // The mode determines the default model when none is pinned, so the
      // auto-compaction threshold must be recomputed for the new mode.
      await this.compaction.rearmPrimary(this.primaryCompactionTarget(liveSession));
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
    const stillCurrent = () =>
      liveSession !== undefined &&
      !this.shutdownPromise &&
      this.registry.getLive(appSessionId) === liveSession &&
      !hasSessionCloseStarted(liveSession);
    if (liveSession && !stillCurrent()) return;
    if (liveSession) this.registry.updateSummary(appSessionId, patch);
    if (liveSession && settings.modelId !== undefined) {
      // The model drives the auto-compaction threshold; recompute it so the
      // daemon doesn't keep compacting against the old model's limit.
      await this.compaction.rearmPrimary(this.primaryCompactionTarget(liveSession));
    }
    if (liveSession && session && stillCurrent())
      await this.context.refresh(this.primaryContextTarget(liveSession));
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

  private emitError(error: {
    code?: string;
    clientRef?: string;
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

  shutdown(): Promise<void> {
    this.shutdownPromise ??= Promise.resolve().then(() => this.performShutdown());
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    let firstError: unknown;
    const run = async (action: () => void | Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        firstError ??= error;
      }
    };

    await run(() => this.lifecycle.closeAll());
    await run(() => this.childSessions.shutdown());
    await run(() => {
      this.missionControlPolicy.clear();
    });
    await run(() => {
      this.context.clearAll();
    });
    await run(() => {
      this.compaction.clearAll();
    });
    await run(() => this.browsers.closeAll());
    await run(() => {
      this.history.close();
    });
    if (firstError !== undefined)
      throw firstError instanceof Error ? firstError : new Error(errMsg(firstError));
  }
}

function hasSessionCloseStarted(liveSession: LiveSession): boolean {
  return liveSession.closeMode !== undefined;
}

function childSessionSettingsFromInit(init: SessionInitResult): ChildSettings {
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
