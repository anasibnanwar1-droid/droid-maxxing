import { DroidInteractionMode, type McpServerConfig } from '@factory/droid-sdk';
import { tmpdir } from 'node:os';
import type {
  SessionRole,
  Autonomy,
  BrowserNativeRequest,
  BrowserNativeResult,
  ClientCommand,
  ConfigurableSessionRole,
  ChildSessionHistoryLink,
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
  isUserCancellation,
  modelDefaultForMode,
  normalizeAutonomy,
  phaseFromState,
  reasoningValue,
  type SessionInitResult,
} from './sessionHelpers.js';
import { boundedInt } from './values.js';
import {
  DroidRuntime,
  factoryReasoningEffort,
  type FactoryRuntime,
  type FactorySession,
} from './DroidRuntime.js';
import { detectEnvironment } from './Environment.js';
import { buildInstallCommand, buildUpdateCommand, runStreaming } from './CliInstaller.js';
import {
  HistoryIndex,
  loadHistoricalSessions,
  loadMissionControlSessions,
  readFactoryDefaults,
  type PersistedChildSession,
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
import {
  SessionContext,
  type ChildOperationTarget,
  type LiveOperationTarget,
} from './SessionContext.js';
import {
  childCompactionModelId,
  SessionCompaction,
  type AutoCompactionSettlement,
  type AutomaticCompactionTarget,
  type ChildAutomaticCompactionTarget,
  type ChildCompactionTarget,
  type CompactionResourceKey,
  type CompactionRetuneTarget,
  type PrimaryAutomaticCompactionTarget,
  type PrimaryCompactionTarget,
} from './SessionCompaction.js';
import {
  SessionLifecycle,
  type ChildSessionSettings,
  type LiveChildSession,
  type LiveSession,
  type PendingChildSession,
  type StartedLocalMcpResources,
} from './SessionLifecycle.js';
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

interface PendingNativeBrowserRequest {
  resolve: (result: BrowserNativeResult) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ChildOpenAttempt {
  settled: Promise<void>;
  settle(): void;
}

interface ChildPersistencePatch {
  status: PersistedChildSession['status'];
  providerSessionId?: string;
  role?: PersistedChildSession['role'];
  label?: string;
  prompt?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  spawnLink?: PersistedChildSession['spawnLink'];
  transcriptAvailable?: boolean;
  startedAt?: number;
}

export class SessionManager {
  private ready = false;
  private cachedModels: ModelInfo[] | null = null;
  private modelRefresh: Promise<ModelInfo[] | null> | null = null;
  private readonly runtime: FactoryRuntime;
  private readonly history: SessionHistory;
  private readonly registry: SessionRegistry<LiveSession>;
  private readonly timeline: SessionTimeline;
  private readonly interactions: SessionInteractions;
  private readonly eventFlow: SessionEventFlow;
  private readonly context: SessionContext;
  private readonly compaction: SessionCompaction;
  private readonly lifecycle: SessionLifecycle;
  private readonly pendingAgentSettings = new Map<
    string,
    Partial<Record<ConfigurableSessionRole, AgentSettingPatch>>
  >();
  private shutdownPromise?: Promise<void>;
  private readonly childOpenAttempts = new WeakMap<LiveSession, Map<string, ChildOpenAttempt>>();
  private readonly pendingNativeBrowserRequests = new Map<string, PendingNativeBrowserRequest>();
  private readonly browsers: SessionBrowsers;
  private readonly createLocalMcpResource: SessionManagerDependencies['createLocalMcpResource'];
  private readonly factoryDefaultsOverride: SessionManagerDependencies['getFactoryDefaults'];

  constructor(
    private readonly emit: Emit,
    options: SessionManagerOptions = {},
  ) {
    if (options.dependencies) {
      this.runtime = options.dependencies.runtime;
      this.history = options.dependencies.history;
      this.browsers = options.dependencies.browsers;
      this.createLocalMcpResource = options.dependencies.createLocalMcpResource;
      this.factoryDefaultsOverride = options.dependencies.getFactoryDefaults;
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
    });
    this.timeline = new SessionTimeline({
      registry: this.registry,
      history: this.history,
      getChildSessionLinks: (appSessionId) =>
        this.withLiveChildSessionStatus(appSessionId, this.childHistoryLinks(appSessionId)),
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
      isShutdownStarted: () => this.shutdownPromise !== undefined,
      childSessionRecords: (appSessionId) => this.history.childSessions(appSessionId),
      applyPendingSettingsToSummary: (summary) => this.applyPendingSettingsToSummary(summary),
      applyPendingSessionSettings: (appSessionId) => this.applyPendingSessionSettings(appSessionId),
      runPrimaryTurn: (liveSession, prompt) => this.runPrimaryTurn(liveSession, prompt),
      context: this.context,
      forgetInteractions: (appSessionId) => {
        this.interactions.forgetSession(appSessionId);
      },
      forgetEventFlow: (appSessionId) => {
        this.eventFlow.forgetSession(appSessionId);
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
      case 'child.updateSettings':
        await this.updateChildSettings(cmd);
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

  private async updateChildSettings(
    cmd: Extract<ClientCommand, { type: 'child.updateSettings' }>,
  ): Promise<void> {
    const parent = this.registry.getLive(cmd.parentAppSessionId);
    if (!parent) {
      this.emitChildSettingsTargetInvalid(cmd);
      return;
    }
    if (
      parent.summary.appSessionId !== cmd.parentAppSessionId ||
      parent.summary.sessionPurpose !== 'mission-control'
    ) {
      this.emitChildSettingsTargetInvalid(cmd);
      return;
    }
    const child = parent.childSessions.get(cmd.childSessionId);
    if (
      !child ||
      !Object.hasOwn(cmd, 'modelId') ||
      !this.isCurrentChildSettingsTarget(parent, cmd.childSessionId, child)
    ) {
      this.emitChildSettingsTargetInvalid(cmd);
      return;
    }
    const update = (child.settingsUpdateTail ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.performChildSettingsUpdate(cmd, parent, child));
    child.settingsUpdateTail = update;
    try {
      await update;
    } finally {
      if (child.settingsUpdateTail === update) delete child.settingsUpdateTail;
    }
  }

  private async performChildSettingsUpdate(
    cmd: Extract<ClientCommand, { type: 'child.updateSettings' }>,
    parent: LiveSession,
    child: LiveChildSession,
  ): Promise<void> {
    if (!this.isCurrentChildSettingsTarget(parent, cmd.childSessionId, child)) return;
    let effectiveModelId = cmd.modelId ?? undefined;
    try {
      if (cmd.modelId === null) {
        const roleModelId =
          child.role === 'worker' ? parent.summary.workerModelId : parent.summary.validatorModelId;
        effectiveModelId =
          roleModelId ??
          defaultModelForAgent(
            child.role,
            defaultsModeForSummary(parent.summary),
            await this.getFactoryDefaults(),
          );
      }
      if (!effectiveModelId) throw new Error(`No Factory default is available for ${child.role}.`);
      if (!this.isCurrentChildSettingsTarget(parent, cmd.childSessionId, child)) return;
      await child.session.updateSettings({
        modelId: effectiveModelId,
        ...(cmd.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: factoryReasoningEffort(cmd.reasoningEffort) }),
      });
    } catch (error) {
      if (!this.isCurrentChildSettingsTarget(parent, cmd.childSessionId, child)) return;
      this.emit({
        type: 'error',
        code: 'child.settings_update_failed',
        parentAppSessionId: parent.summary.appSessionId,
        childSessionId: cmd.childSessionId,
        message: `Could not update child settings: ${errMsg(error)}`,
      });
      return;
    }

    if (!this.isCurrentChildSettingsTarget(parent, cmd.childSessionId, child)) return;
    const currentSettings = parent.childSessionSettings.get(cmd.childSessionId) ?? {};
    const nextSettings: ChildSessionSettings & { modelId: string } = {
      ...currentSettings,
      modelId: effectiveModelId,
      ...(cmd.reasoningEffort === undefined ? {} : { reasoningEffort: cmd.reasoningEffort }),
    };
    this.persistChildSession(parent, cmd.childSessionId, {
      providerSessionId: child.session.sessionId,
      role: child.role,
      status: parent.completedChildSessions.has(cmd.childSessionId)
        ? 'completed'
        : child.streaming
          ? 'running'
          : 'paused',
      modelId: effectiveModelId,
      transcriptAvailable: true,
      ...(nextSettings.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: nextSettings.reasoningEffort }),
    });
    parent.childSessionSettings.set(cmd.childSessionId, nextSettings);
    this.emitCanonicalChildSettings(parent.summary.appSessionId, cmd.childSessionId, nextSettings);

    try {
      await this.compaction.rearmModelChangedChild(
        this.childCompactionTarget(parent, cmd.childSessionId, child, effectiveModelId),
        effectiveModelId,
      );
    } catch (error) {
      console.error(
        `[compaction] could not resolve exact-child limit for ${child.session.sessionId}: ${errMsg(error)}`,
      );
    }
  }

  private isCurrentChildSettingsTarget(
    parent: LiveSession,
    childSessionId: string,
    child: LiveChildSession,
  ): boolean {
    return (
      this.isCurrentChildSession(parent, childSessionId, child) &&
      !parent.completedChildSessions.has(childSessionId) &&
      !child.closeWhenIdle
    );
  }

  private isCurrentChildSession(
    parent: LiveSession,
    childSessionId: string,
    child: LiveChildSession,
  ): boolean {
    return (
      !this.shutdownPromise &&
      this.registry.getLive(parent.summary.appSessionId) === parent &&
      !hasSessionCloseStarted(parent) &&
      parent.childSessions.get(childSessionId) === child
    );
  }

  private emitChildSettingsTargetInvalid(
    cmd: Extract<ClientCommand, { type: 'child.updateSettings' }>,
  ): void {
    this.emit({
      type: 'error',
      code: 'child.settings_target_invalid',
      parentAppSessionId: cmd.parentAppSessionId,
      childSessionId: cmd.childSessionId,
      message: `Child session ${cmd.childSessionId || '(missing)'} is not an active settings target for ${cmd.parentAppSessionId || '(missing)'}.`,
    });
  }

  private emitCanonicalChildSettings(
    parentAppSessionId: string,
    childSessionId: string,
    settings: ChildSessionSettings & { modelId: string },
  ): void {
    this.emit({
      type: 'session.child',
      parentAppSessionId,
      event: 'updated',
      childSessionId,
      modelId: settings.modelId,
      ...(settings.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: settings.reasoningEffort }),
    });
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
    const targets: CompactionRetuneTarget[] = [];
    for (const liveSession of this.registry.liveSessionsSnapshot()) {
      targets.push(this.primaryCompactionTarget(liveSession));
      for (const [childProviderSessionId, childSession] of liveSession.childSessions) {
        const modelId = childCompactionModelId(
          liveSession.summary,
          liveSession.childSessionSettings.get(childProviderSessionId),
          childSession.role,
        );
        targets.push(
          this.childCompactionTarget(liveSession, childProviderSessionId, childSession, modelId),
        );
      }
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

  private childHistoryLinks(appSessionId: string): ChildSessionHistoryLink[] {
    return this.history.childSessions(appSessionId).flatMap((child) =>
      child.providerSessionId
        ? [
            {
              providerSessionId: child.providerSessionId,
              ...(child.spawnLink?.kind === 'tool-use' ? { toolUseId: child.spawnLink.id } : {}),
              ...(child.label === undefined ? {} : { label: child.label }),
              status: child.status === 'pending' ? 'paused' : child.status,
            },
          ]
        : [],
    );
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

  private async runPrimaryTurn(liveSession: LiveSession, prompt: string): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    if (!this.isCurrentPrimarySession(liveSession)) return;
    this.eventFlow.beginTurn(appSessionId, appSessionId);
    this.context.startPolling(this.primaryContextTarget(liveSession));
    try {
      await this.applyDesignToolPolicy(liveSession, isDesignPrompt(prompt));
      if (!this.isCurrentPrimarySession(liveSession)) return;
      const stream = liveSession.session.stream(prompt, { includePartialMessages: true });
      for await (const ev of stream) {
        if (!this.isCurrentPrimarySession(liveSession)) break;
        this.eventFlow.applyStreamEvent(appSessionId, appSessionId, 'primary', ev);
      }
    } catch (err) {
      if (!this.isCurrentPrimarySession(liveSession)) {
        return;
      } else if (liveSession.interruptingForSteer) {
        this.timeline.appendStatus(appSessionId, 'Current turn interrupted for steering.');
      } else if (liveSession.interrupting && isUserCancellation(err)) {
        // The user pressed Stop; interrupt() already set the paused phase, so
        // settle quietly without surfacing an error.
        this.registry.updateSummary(appSessionId, { phase: 'paused' });
      } else {
        this.emitError({ appSessionId, message: errMsg(err) });
        this.registry.updateSummary(appSessionId, { phase: 'failed' });
      }
    } finally {
      this.context.stopPolling(appSessionId);
      // Keep streaming=true while the context refresh is in flight so concurrent
      // sends queue instead of racing a second lifecycle turn.
      if (this.isCurrentPrimarySession(liveSession)) {
        await this.context.refresh(this.primaryContextTarget(liveSession));
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

  private childContextTarget(
    parent: LiveSession,
    childSessionId: string,
    child: LiveChildSession,
  ): ChildOperationTarget {
    const session = child.session;
    return {
      appSessionId: parent.summary.appSessionId,
      parentAppSessionId: parent.summary.appSessionId,
      childSessionId,
      providerSessionId: session.sessionId,
      sourceSessionId: session.sessionId,
      session,
      role: child.role,
      child,
      isCurrent: () =>
        this.isCurrentChildSession(parent, childSessionId, child) && child.session === session,
    };
  }

  private childCompactionTarget(
    parent: LiveSession,
    childSessionId: string,
    child: LiveChildSession,
    effectiveModelId: string | undefined,
  ): ChildCompactionTarget {
    const target = this.childAutomaticCompactionTarget(parent, childSessionId, child);
    return {
      ...target,
      effectiveModelId,
      isCurrent: () =>
        this.isCurrentChildSettingsTarget(parent, childSessionId, child) &&
        child.session === target.session &&
        childCompactionModelId(
          parent.summary,
          parent.childSessionSettings.get(childSessionId),
          child.role,
        ) === effectiveModelId,
    };
  }

  private childAutomaticCompactionTarget(
    parent: LiveSession,
    childSessionId: string,
    child: LiveChildSession,
  ): ChildAutomaticCompactionTarget {
    return {
      ...this.childContextTarget(parent, childSessionId, child),
      kind: 'child',
    };
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

  private persistChildSession(
    parent: LiveSession,
    childSessionId: string,
    patch: ChildPersistencePatch,
  ): void {
    const parentAppSessionId = parent.summary.appSessionId;
    const existing = this.history.childSession(parentAppSessionId, childSessionId);
    const cachedSettings = parent.childSessionSettings.get(childSessionId);
    const role = patch.role ?? existing?.role ?? 'worker';
    const startedAt = existing?.startedAt ?? patch.startedAt;
    const defaults = this.resolveChildDefaultSettings(parent, role);
    const modelId =
      patch.modelId ?? cachedSettings?.modelId ?? existing?.modelId ?? defaults.modelId;
    if (!modelId)
      throw new Error(`Cannot persist child ${childSessionId}: accepted model is unavailable.`);
    this.history.upsertChildSession({
      ...(existing ?? {
        parentAppSessionId,
        childSessionId,
        role,
        status: patch.status,
        modelId,
        transcriptAvailable: false,
        updatedAt: Date.now(),
      }),
      parentAppSessionId,
      childSessionId,
      role,
      status: patch.status,
      modelId,
      transcriptAvailable: patch.transcriptAvailable ?? existing?.transcriptAvailable ?? false,
      updatedAt: Date.now(),
      ...(patch.providerSessionId === undefined
        ? {}
        : { providerSessionId: patch.providerSessionId }),
      ...(patch.label === undefined ? {} : { label: patch.label }),
      ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
      ...(patch.reasoningEffort === undefined ? {} : { reasoningEffort: patch.reasoningEffort }),
      ...(patch.spawnLink === undefined ? {} : { spawnLink: patch.spawnLink }),
      ...(startedAt === undefined ? {} : { startedAt }),
    });
  }

  private resolveChildDefaultSettings(
    parent: LiveSession,
    role: PersistedChildSession['role'],
  ): ChildSessionSettings {
    const parentSettings = childSessionSettingsFromInit(parent.session.initResult);
    const roleModelId =
      role === 'validator' ? parent.summary.validatorModelId : parent.summary.workerModelId;
    const roleReasoningEffort =
      role === 'validator'
        ? parent.summary.validatorReasoningEffort
        : parent.summary.workerReasoningEffort;
    const catalogDefault =
      this.cachedModels?.find((model) => model.isDefault && !model.isCustom) ??
      this.cachedModels?.find((model) => !model.isCustom) ??
      this.cachedModels?.at(0);
    const missionControl = parent.summary.sessionPurpose === 'mission-control';
    return {
      modelId:
        (missionControl ? roleModelId : parent.summary.modelId) ??
        parentSettings.modelId ??
        roleModelId ??
        catalogDefault?.id,
      reasoningEffort:
        (missionControl ? roleReasoningEffort : parent.summary.reasoningEffort) ??
        parentSettings.reasoningEffort ??
        roleReasoningEffort ??
        catalogDefault?.defaultReasoningEffort,
    };
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
    }
    const settings = liveSession.childSessionSettings.get(providerSessionId);
    this.persistChildSession(liveSession, providerSessionId, {
      providerSessionId,
      role: 'worker',
      status: 'running',
      transcriptAvailable: true,
      startedAt: Date.now(),
      ...(label === undefined ? {} : { label }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(toolUseId === undefined ? {} : { spawnLink: { kind: 'tool-use', id: toolUseId } }),
      ...(settings?.modelId === undefined ? {} : { modelId: settings.modelId }),
      ...(settings?.reasoningEffort === undefined
        ? liveSession.summary.workerReasoningEffort === undefined
          ? {}
          : { reasoningEffort: liveSession.summary.workerReasoningEffort }
        : { reasoningEffort: settings.reasoningEffort }),
    });
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
      this.timeline.append({
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
    this.persistChildSession(liveSession, providerSessionId, {
      providerSessionId,
      status: 'completed',
      transcriptAvailable: true,
      ...(settings.modelId === undefined ? {} : { modelId: settings.modelId }),
      ...(settings.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: settings.reasoningEffort }),
    });
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

  private applyEventSideEffects(appSessionId: string, n: NormalizedSideEffects): void {
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
  }

  private resolveAutomaticCompactionTarget(
    key: CompactionResourceKey,
  ): AutomaticCompactionTarget | undefined {
    const parent = this.registry.getLive(
      key.kind === 'primary' ? key.appSessionId : key.parentAppSessionId,
    );
    if (!parent || hasSessionCloseStarted(parent)) return undefined;
    if (key.kind === 'primary') return this.primaryAutomaticCompactionTarget(parent);
    const child = parent.childSessions.get(key.childSessionId);
    return child
      ? this.childAutomaticCompactionTarget(parent, key.childSessionId, child)
      : undefined;
  }

  private settleAutomaticCompaction(settlement: AutoCompactionSettlement): void {
    if (settlement.kind === 'primary') {
      void this.lifecycle.settleAfterCompaction(settlement.appSessionId);
      return;
    }
    const parent = this.registry.getLive(settlement.parentAppSessionId);
    if (!parent || !this.isCurrentChildSession(parent, settlement.childSessionId, settlement.child))
      return;
    const child = settlement.child;
    if (child.pendingSends.length === 0 && child.closeWhenIdle) {
      void this.closeChildSession(settlement.parentAppSessionId, settlement.childSessionId);
      return;
    }
    const next = child.pendingSends.shift();
    if (next !== undefined) {
      void this.driveChildSession(parent, child, next);
      return;
    }
    this.emit({
      type: 'child.updated',
      appSessionId: settlement.parentAppSessionId,
      providerSessionId: child.session.sessionId,
      role: child.role,
      status: 'paused',
    });
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

  private async openChildSession(
    appSessionId: string,
    childProviderSessionId: string,
    role: SessionRole,
  ): Promise<void> {
    if (role === 'primary') {
      this.emit({
        type: 'error',
        code: 'child.open_failed',
        appSessionId,
        parentAppSessionId: appSessionId,
        childSessionId: childProviderSessionId,
        message: 'Primary sessions cannot be opened as parent-owned child sessions.',
      });
      return;
    }
    if (this.shutdownPromise) return;
    const liveSession = this.registry.getLive(appSessionId);
    if (!liveSession) {
      this.emitChildOpened(appSessionId, childProviderSessionId, role, false);
      return;
    }
    if (!this.childBelongsToSession(liveSession, childProviderSessionId)) {
      this.emitChildOpened(appSessionId, childProviderSessionId, role, false);
      return;
    }
    if (liveSession.childSessions.has(childProviderSessionId)) {
      const childSession = liveSession.childSessions.get(childProviderSessionId);
      if (childSession) childSession.lastUsedAt = Date.now();
      this.emitChildOpened(
        appSessionId,
        childProviderSessionId,
        childSession?.role ?? role,
        childSession !== undefined &&
          this.registry.getLive(appSessionId) === liveSession &&
          !hasSessionCloseStarted(liveSession) &&
          !liveSession.completedChildSessions.has(childProviderSessionId) &&
          !childSession.closeWhenIdle,
      );
      return;
    }
    const existingAttempt = this.childOpenAttempts.get(liveSession)?.get(childProviderSessionId);
    if (existingAttempt) return existingAttempt.settled;
    const attempt = this.beginChildOpenAttempt(liveSession, childProviderSessionId);
    let loadedSession: FactorySession | undefined;
    let inserted = false;
    try {
      if (!(await this.ensureChildSessionCapacity(liveSession, childProviderSessionId))) return;
      if (!this.isCurrentChildOpenAttempt(liveSession, childProviderSessionId, attempt)) return;
      const ref = { id: appSessionId };
      const session = await this.runtime.loadSession(childProviderSessionId, {
        permissionHandler: this.interactions.makePermissionHandler(ref),
        askUserHandler: this.interactions.makeAskUserHandler(ref),
      });
      loadedSession = session;
      if (!this.isCurrentChildOpenAttempt(liveSession, childProviderSessionId, attempt)) return;
      const actualSettings = childSessionSettingsFromInit(session.initResult);
      // Chat/spec children inherit the parent model; Mission Control roles keep their own.
      const inheritsSessionModel = liveSession.summary.sessionPurpose !== 'mission-control';
      const resolvedSettings: ChildSessionSettings = inheritsSessionModel
        ? {
            modelId: actualSettings.modelId ?? liveSession.summary.modelId,
            reasoningEffort: actualSettings.reasoningEffort ?? liveSession.summary.reasoningEffort,
          }
        : actualSettings;
      // Missing child models use role configuration so limits remain role-specific.
      const workerModelId =
        resolvedSettings.modelId ??
        childCompactionModelId(
          liveSession.summary,
          liveSession.childSessionSettings.get(childProviderSessionId),
          role,
        );
      const limit = await this.compaction.resolveLimit({ modelId: workerModelId });
      if (!this.isCurrentChildOpenAttempt(liveSession, childProviderSessionId, attempt)) return;
      await this.compaction.arm(
        {
          session,
          isCurrent: () =>
            loadedSession === session &&
            this.isCurrentChildOpenAttempt(liveSession, childProviderSessionId, attempt),
        },
        limit,
      );
      if (!this.isCurrentChildOpenAttempt(liveSession, childProviderSessionId, attempt)) return;
      const childSession: LiveChildSession = {
        session,
        childSessionId: childProviderSessionId,
        appSessionId,
        role,
        streaming: false,
        autoCompacting: false,
        pendingSends: [],
        lastUsedAt: Date.now(),
      };
      const automaticCompactionTarget = this.childAutomaticCompactionTarget(
        liveSession,
        childProviderSessionId,
        childSession,
      );
      childSession.unsubscribe = session.onNotification((note: Record<string, unknown>) => {
        if (!automaticCompactionTarget.isCurrent()) return;
        if (this.compaction.handleChildNotification(automaticCompactionTarget, note)) return;
        if (!automaticCompactionTarget.isCurrent()) return;
        this.eventFlow.applyNotification(
          appSessionId,
          automaticCompactionTarget.sourceSessionId,
          role,
          note,
        );
      });
      liveSession.childSessions.set(childProviderSessionId, childSession);
      inserted = true;
      if (resolvedSettings.modelId || resolvedSettings.reasoningEffort) {
        liveSession.childSessionSettings.set(childProviderSessionId, resolvedSettings);
        if (liveSession.summary.sessionPurpose === 'mission-control' && resolvedSettings.modelId)
          this.emitCanonicalChildSettings(appSessionId, childProviderSessionId, {
            ...resolvedSettings,
            modelId: resolvedSettings.modelId,
          });
        else
          this.emit({
            type: 'session.child',
            appSessionId,
            event: 'updated',
            providerSessionId: childProviderSessionId,
            ...resolvedSettings,
          });
      }
      this.timeline.replayChild(appSessionId, childProviderSessionId);
      this.emitChildOpened(appSessionId, childProviderSessionId, role, true);
    } catch (err) {
      if (this.isCurrentChildOpenAttempt(liveSession, childProviderSessionId, attempt))
        this.emit({
          type: 'error',
          code: 'child.open_failed',
          appSessionId,
          parentAppSessionId: appSessionId,
          childSessionId: childProviderSessionId,
          message: errMsg(err),
        });
    } finally {
      this.finishChildOpenAttempt(liveSession, childProviderSessionId, attempt);
      if (loadedSession && !inserted) await loadedSession.close().catch(ignoreError);
    }
  }

  private beginChildOpenAttempt(parent: LiveSession, childSessionId: string): ChildOpenAttempt {
    let attempts = this.childOpenAttempts.get(parent);
    if (!attempts) {
      attempts = new Map();
      this.childOpenAttempts.set(parent, attempts);
    }
    let settle: () => void = ignoreError;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const attempt = { settled, settle };
    attempts.set(childSessionId, attempt);
    return attempt;
  }

  private isCurrentChildOpenAttempt(
    parent: LiveSession,
    childSessionId: string,
    attempt: ChildOpenAttempt,
  ): boolean {
    return (
      !this.shutdownPromise &&
      this.registry.getLive(parent.summary.appSessionId) === parent &&
      !hasSessionCloseStarted(parent) &&
      !parent.childSessions.has(childSessionId) &&
      this.childOpenAttempts.get(parent)?.get(childSessionId) === attempt
    );
  }

  private finishChildOpenAttempt(
    parent: LiveSession,
    childSessionId: string,
    attempt: ChildOpenAttempt,
  ): void {
    const attempts = this.childOpenAttempts.get(parent);
    if (attempts?.get(childSessionId) !== attempt) return;
    attempts.delete(childSessionId);
    if (attempts.size === 0) this.childOpenAttempts.delete(parent);
    attempt.settle();
  }

  private emitChildOpened(
    parentAppSessionId: string,
    childSessionId: string,
    role: SessionRole,
    settingsReady: boolean,
  ): void {
    if (settingsReady && (role === 'worker' || role === 'validator')) {
      this.emit({
        type: 'child.updated',
        parentAppSessionId,
        childSessionId,
        role,
        status: 'opened',
        settingsReady: true,
      });
      return;
    }
    this.emit({
      type: 'child.updated',
      appSessionId: parentAppSessionId,
      providerSessionId: childSessionId,
      role,
      status: 'opened',
    });
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
    if (
      this.registry.getLive(liveSession.summary.appSessionId) !== liveSession ||
      hasSessionCloseStarted(liveSession)
    )
      return;
    const childSession = liveSession.childSessions.get(childProviderSessionId);
    if (
      !childSession ||
      !this.isCurrentChildSession(liveSession, childProviderSessionId, childSession)
    )
      return;
    childSession.lastUsedAt = Date.now();
    if (childSession.streaming || childSession.autoCompacting) {
      childSession.pendingSends.push(text);
      return;
    }
    await this.driveChildSession(liveSession, childSession, text);
  }

  private async driveChildSession(
    parent: LiveSession,
    childSession: LiveChildSession,
    text: string,
  ): Promise<void> {
    if (!this.isCurrentChildSession(parent, childSession.childSessionId, childSession)) return;
    childSession.streaming = true;
    childSession.lastUsedAt = Date.now();
    this.eventFlow.beginTurn(childSession.appSessionId, childSession.session.sessionId);
    this.emit({
      type: 'child.updated',
      appSessionId: childSession.appSessionId,
      providerSessionId: childSession.session.sessionId,
      role: childSession.role,
      status: 'running',
    });
    this.context.startPolling(
      this.childContextTarget(parent, childSession.childSessionId, childSession),
    );
    try {
      const stream = childSession.session.stream(text, { includePartialMessages: true });
      for await (const ev of stream) {
        if (!this.isCurrentChildSession(parent, childSession.childSessionId, childSession)) break;
        this.eventFlow.applyStreamEvent(
          childSession.appSessionId,
          childSession.session.sessionId,
          childSession.role,
          ev,
        );
      }
    } catch (err) {
      if (!this.isCurrentChildSession(parent, childSession.childSessionId, childSession)) {
        // Closing a provider commonly rejects its active stream. The detached
        // child must settle quietly without publishing post-close errors.
      } else if (childSession.interruptingForSteer)
        this.timeline.appendStatus(
          childSession.appSessionId,
          'Child-session turn interrupted for steering.',
        );
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
      await this.settleChildTurn(parent, childSession);
    }
  }

  private async settleChildTurn(
    parent: LiveSession,
    childSession: LiveChildSession,
  ): Promise<void> {
    this.context.stopPolling(childSession.session.sessionId);
    childSession.interruptingForSteer = false;
    childSession.interrupting = false;
    if (!this.isCurrentChildSession(parent, childSession.childSessionId, childSession)) {
      childSession.streaming = false;
      return;
    }
    if (
      childSession.pendingSends.length === 0 &&
      childSession.closeWhenIdle &&
      !childSession.autoCompacting
    ) {
      childSession.streaming = false;
      // closeChildSession resolves the worker by the child-map id, which is not
      // guaranteed to match the live session id.
      await this.closeChildSession(childSession.appSessionId, childSession.childSessionId);
      return;
    }

    // Refresh while streaming stays true so concurrent sends queue instead
    // of racing a second driveChildSession(). The daemon auto-compacts the worker
    // in place (same session id), so no swap handling is needed here.
    await this.context.refresh(
      this.childContextTarget(parent, childSession.childSessionId, childSession),
    );
    if (!this.isCurrentChildSession(parent, childSession.childSessionId, childSession)) {
      childSession.streaming = false;
      return;
    }
    childSession.streaming = false;
    if (childSession.autoCompacting) {
      this.compaction.afterTurn(
        this.childAutomaticCompactionTarget(parent, childSession.childSessionId, childSession),
      );
      return;
    }
    const next = childSession.pendingSends.shift();
    if (next !== undefined) {
      void this.driveChildSession(parent, childSession, next);
      return;
    }
    this.emit({
      type: 'child.updated',
      appSessionId: childSession.appSessionId,
      providerSessionId: childSession.session.sessionId,
      role: childSession.role,
      status: 'paused',
    });
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
    if (
      this.registry.getLive(liveSession.summary.appSessionId) !== liveSession ||
      hasSessionCloseStarted(liveSession)
    )
      return;
    const childSession = liveSession.childSessions.get(childProviderSessionId);
    if (
      !childSession ||
      !this.isCurrentChildSession(liveSession, childProviderSessionId, childSession)
    )
      return;
    childSession.lastUsedAt = Date.now();
    if (!childSession.streaming && !childSession.autoCompacting) {
      await this.driveChildSession(liveSession, childSession, text);
      return;
    }
    childSession.pendingSends.unshift(text);
    if (childSession.autoCompacting) return;
    childSession.interruptingForSteer = true;
    this.timeline.appendStatus(appSessionId, 'Steering child session now...');
    try {
      await childSession.session.interrupt();
    } catch (err) {
      childSession.interruptingForSteer = false;
      if (!this.isCurrentChildSession(liveSession, childProviderSessionId, childSession)) return;
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
    if (
      this.registry.getLive(liveSession.summary.appSessionId) !== liveSession ||
      hasSessionCloseStarted(liveSession)
    )
      return;
    const childSession = liveSession.childSessions.get(childProviderSessionId);
    if (
      !childSession ||
      !this.isCurrentChildSession(liveSession, childProviderSessionId, childSession)
    )
      return;
    childSession.pendingSends = [];
    childSession.lastUsedAt = Date.now();
    // Same escape hatch as the primary session: interrupt first, and settle the
    // wedged auto-compaction flag only once the interrupt landed.
    const wasAutoCompacting = childSession.autoCompacting;
    childSession.interrupting = true;
    await childSession.session.interrupt();
    if (!this.isCurrentChildSession(liveSession, childProviderSessionId, childSession)) {
      childSession.interrupting = false;
      childSession.streaming = false;
      return;
    }
    if (wasAutoCompacting) {
      this.compaction.cancel(
        this.childAutomaticCompactionTarget(liveSession, childProviderSessionId, childSession),
      );
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
      code: 'child.open_failed',
      appSessionId: liveSession.summary.appSessionId,
      // Scope to the requested child session so its loading state settles, not just the
      // session-level toast.
      parentAppSessionId: liveSession.summary.appSessionId,
      childSessionId: requestedProviderSessionId,
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
    this.compaction.cancel(
      this.childAutomaticCompactionTarget(liveSession, childProviderSessionId, childSession),
    );
    liveSession.childSessions.delete(childProviderSessionId);
    this.context.forgetChild(
      {
        parentAppSessionId: liveSession.summary.appSessionId,
        childSessionId: childProviderSessionId,
      },
      childSession.session.sessionId,
    );
    this.context.stopPolling(childSession.session.sessionId);
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

  private emitError(error: {
    code?: string;
    providerSessionId?: string;
    appSessionId?: string;
    parentAppSessionId?: string;
    childSessionId?: string;
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
