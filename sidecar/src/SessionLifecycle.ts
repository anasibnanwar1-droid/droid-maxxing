import {
  type AskUserHandler,
  type McpServerConfig,
  type PermissionHandler,
} from '@factory/droid-sdk';
import type { FactoryRuntime, FactorySession } from './DroidRuntime.js';
import type {
  ClientCommand,
  FactoryDefaultSettings,
  ServerEvent,
  SessionSummary,
} from './protocol.js';
import type { SessionRegistry } from './SessionRegistry.js';
import type { PrimaryAutomaticCompactionTarget, SessionCompaction } from './SessionCompaction.js';
import type { LiveOperationTarget, SessionContext } from './SessionContext.js';
import type { ChildSessions } from './ChildSessions.js';
import { PrimaryPromptQueue, type PrimaryQueuedPrompt } from './PrimaryPromptQueue.js';
import { PrimaryPromptDelivery, type PrimaryTurnSettlement } from './PrimaryPromptDelivery.js';
import {
  buildCreatedSessionSummary,
  buildCreateRuntimeOptions,
  buildResumedSession,
  createAutonomyForCommand,
  createDefaultsModeForCommand,
  createInteractionModeForCommand,
  createMissionAgentDefaultsForMode,
  createModelDefaultsForMode,
  errMsg,
} from './sessionHelpers.js';

const AUTO_COMPACTION_UNAVAILABLE_MESSAGE =
  'Automatic compaction could not be enabled for this session. Start a new conversation before the context limit is reached.';

export type SessionCreateCommand = Extract<ClientCommand, { type: 'session.create' }>;
interface LocalMcpResource {
  close(): Promise<void>;
}
interface DeferredClose {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  started: boolean;
}
interface CloseOperation {
  deferred: DeferredClose;
  created: boolean;
}
export interface StartedLocalMcpResources {
  servers: LocalMcpResource[];
  configs: McpServerConfig[];
}
interface LiveTurnState {
  streaming: boolean;
  autoCompacting: boolean;
  promptQueue: PrimaryPromptQueue;
  turnAbortController?: AbortController;
  turnSettlement?: PrimaryTurnSettlement;
  interrupting?: boolean; // Marks user Stop so the resulting stream abort settles quietly.
}
type SessionCloseMode = 'discard-pending' | 'preserve-pending';
export interface LiveSession extends LiveTurnState {
  summary: SessionSummary;
  session: FactorySession;
  closeMode?: SessionCloseMode;
  closePromise?: Promise<void>;
  mcpServers: LocalMcpResource[];
  // Running MCP handles reused when compaction swaps the provider session.
  mcpConfigs: McpServerConfig[];
  todoDisabledForDesign?: boolean;
  compacting?: boolean; // Manual-compaction overlap guard; auto-compaction is separate.
  unsubscribe?: () => void; // Primary provider notification subscription, replaced on swap.
}
type LifecycleError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface SessionLifecycleDependencies {
  runtime: FactoryRuntime;
  registry: SessionRegistry<LiveSession>;
  ensureConnected: () => void;
  getFactoryDefaults: () => Promise<FactoryDefaultSettings>;
  maxContextTokensForModel: (modelId?: string) => number | undefined;
  startLocalMcpServers: (ref: { id: string }) => Promise<StartedLocalMcpResources>;
  makePermissionHandler: (ref: { id: string }) => PermissionHandler;
  makeAskUserHandler: (ref: { id: string }) => AskUserHandler;
  compaction: Pick<
    SessionCompaction,
    'resolveLimit' | 'arm' | 'subscribePrimary' | 'afterTurn' | 'cancel'
  >;
  isShutdownStarted: () => boolean;
  childSessions: Pick<ChildSessions, 'attachParent' | 'closeParent'>;
  applyPendingSettingsToSummary: (summary: SessionSummary) => SessionSummary;
  applyPendingSessionSettings: (appSessionId: string) => Promise<boolean>;
  runPrimaryTurn: (
    liveSession: LiveSession,
    prompt: string,
    abortSignal: AbortSignal,
  ) => Promise<void>;
  context: Pick<SessionContext, 'refresh' | 'stopPolling' | 'stopSession' | 'forgetSession'>;
  forgetInteractions: (appSessionId: string) => void;
  forgetEventFlow: (appSessionId: string) => void;
  forgetMissionControl: (appSessionId: string) => void;
  closeDesignSession: (appSessionId: string) => Promise<void>;
  closeBrowserSession: (appSessionId: string) => Promise<void>;
  emit: (event: ServerEvent) => void;
  emitError: (error: LifecycleError) => void;
  emitStatus: (appSessionId: string, text: string) => void;
  emitSessionList: () => void;
}
export class SessionLifecycle {
  private readonly deferredCloses = new WeakMap<LiveSession, DeferredClose>();
  private readonly inFlightResumes = new Map<string, Promise<boolean>>();
  private readonly promptDelivery: PrimaryPromptDelivery;

  constructor(private readonly dependencies: SessionLifecycleDependencies) {
    this.promptDelivery = new PrimaryPromptDelivery({
      registry: dependencies.registry,
      runPrimaryTurn: dependencies.runPrimaryTurn,
      afterAutomaticCompactionTurn: (liveSession) => {
        dependencies.compaction.afterTurn(this.primaryAutomaticCompactionTarget(liveSession));
      },
      redeliverQueuedPrompts: (appSessionId, prompts) =>
        this.redeliverQueuedSends(appSessionId, prompts),
      isShutdownStarted: dependencies.isShutdownStarted,
      emitStatus: dependencies.emitStatus,
      emitError: dependencies.emitError,
    });
  }
  async create(command: SessionCreateCommand): Promise<void> {
    const d = this.dependencies;
    const appCwd = command.cwd ?? '';
    const ref = { id: '' };
    let pendingMcpServers: LocalMcpResource[] = [];
    let pendingSession: FactorySession | undefined;
    let pendingLiveSession: LiveSession | undefined;

    try {
      d.ensureConnected();
      const defaults = await d.getFactoryDefaults();
      const interactionMode = createInteractionModeForCommand(command, defaults);
      const defaultsMode = createDefaultsModeForCommand(command, interactionMode);
      const autonomy = createAutonomyForCommand(command, defaults);
      const primary = createModelDefaultsForMode(defaultsMode, command, defaults);
      const agents = createMissionAgentDefaultsForMode(defaultsMode, command, defaults);
      const compactionModel =
        command.compactionModel ?? defaults.compactionModel ?? 'current-model';
      const compactionTokenLimit = await d.compaction.resolveLimit({
        modelId: primary.modelId,
        uiOverride: {
          ...(command.compactionTokenLimit !== undefined
            ? { compactionTokenLimit: command.compactionTokenLimit }
            : {}),
          ...(command.compactionTokenLimitPerModel !== undefined
            ? { compactionTokenLimitPerModel: command.compactionTokenLimitPerModel }
            : {}),
        },
        defaults,
      });
      this.requireOpenAdmission();
      const mcp = await d.startLocalMcpServers(ref);
      pendingMcpServers = mcp.servers;
      const runtimeOptions = buildCreateRuntimeOptions({
        command,
        appCwd,
        interactionMode,
        primary,
        agents,
        defaults,
        autonomy,
        compactionModel,
        compactionTokenLimit,
        mcpServers: mcp.configs,
        permissionHandler: d.makePermissionHandler(ref),
        askUserHandler: d.makeAskUserHandler(ref),
      });
      const session = await d.runtime.createSession(runtimeOptions);
      pendingSession = session;
      this.requireOpenAdmission();
      const autoCompactionArmed = await d.compaction.arm(
        {
          session,
          isCurrent: () => !d.isShutdownStarted() && pendingSession === session,
        },
        compactionTokenLimit,
      );
      this.requireOpenAdmission();

      const appSessionId = session.sessionId;
      const maxContextTokens = d.maxContextTokensForModel(primary.modelId);
      const summary = buildCreatedSessionSummary({
        command,
        appSessionId,
        interactionMode,
        primary,
        compactionModel,
        agents,
        autonomy,
        ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
        ...(autoCompactionArmed ? { compactionTokenLimit } : {}),
        now: Date.now(),
      });
      ref.id = appSessionId;
      const liveSession = createLiveSession(summary, session, mcp);
      pendingLiveSession = liveSession;
      d.compaction.subscribePrimary(this.primaryAutomaticCompactionTarget(liveSession));
      d.registry.register(liveSession);
      d.childSessions.attachParent(appSessionId);
      d.emit({ type: 'session.created', clientRef: command.clientRef, session: summary });
      if (!autoCompactionArmed) {
        d.emitStatus(appSessionId, AUTO_COMPACTION_UNAVAILABLE_MESSAGE);
      }
      this.promptDelivery.startInBackground(liveSession, command.goal);
    } catch (error) {
      await this.cleanupFailedOpen(pendingMcpServers, pendingSession, pendingLiveSession);
      if (!isOpenAdmissionClosed(error)) {
        d.emitError({
          code: 'session.create_failed',
          clientRef: command.clientRef,
          message: errMsg(error),
        });
      }
    }
  }

  async resume(requestedAppSessionId: string): Promise<boolean> {
    const d = this.dependencies;
    d.ensureConnected();
    const historical = d.registry.getCanonicalSummary(requestedAppSessionId);
    const appSessionId = historical?.appSessionId ?? requestedAppSessionId;
    const providerSessionId = historical?.providerSessionId ?? requestedAppSessionId;

    const inFlight = this.inFlightResumes.get(appSessionId);
    if (inFlight) return await inFlight;

    const existing = d.registry.getLive(appSessionId);
    if (existing) {
      const projectedSummary =
        d.registry.resolveSummary(appSessionId) ??
        d.applyPendingSettingsToSummary({ ...existing.summary });
      d.emit({
        type: 'session.created',
        clientRef: `resume:${appSessionId}`,
        session: projectedSummary,
      });
      void d.context.refresh(this.primaryContextTarget(existing));
      return true;
    }

    const resume = this.resumeHistorical(historical, appSessionId, providerSessionId);
    this.inFlightResumes.set(appSessionId, resume);
    try {
      return await resume;
    } finally {
      if (this.inFlightResumes.get(appSessionId) === resume) {
        this.inFlightResumes.delete(appSessionId);
      }
    }
  }

  private async resumeHistorical(
    historical: SessionSummary | undefined,
    appSessionId: string,
    providerSessionId: string,
  ): Promise<boolean> {
    const d = this.dependencies;
    const ref = { id: appSessionId };
    let pendingMcpServers: LocalMcpResource[] = [];
    let pendingSession: FactorySession | undefined;
    let pendingLiveSession: LiveSession | undefined;
    try {
      const mcp = await d.startLocalMcpServers(ref);
      pendingMcpServers = mcp.servers;
      const session = await d.runtime.loadSession(providerSessionId, {
        permissionHandler: d.makePermissionHandler(ref),
        askUserHandler: d.makeAskUserHandler(ref),
        mcpServers: mcp.configs,
      });
      pendingSession = session;
      const defaults = await d.getFactoryDefaults();
      const resumed = buildResumedSession({
        init: session.initResult,
        historical,
        appSessionId,
        providerSessionId,
        defaults,
        maxContextTokensForModel: d.maxContextTokensForModel,
        now: Date.now(),
      });
      const summary = resumed.summary;
      const projectedModel = d.applyPendingSettingsToSummary({ ...summary }).modelId;
      const limit = await d.compaction.resolveLimit({
        modelId: projectedModel,
        exposed: resumed.exposedCompaction,
      });
      this.requireOpenAdmission();
      const autoCompactionArmed = await d.compaction.arm(
        {
          appSessionId,
          session,
          isCurrent: () => !d.isShutdownStarted() && pendingSession === session,
        },
        limit,
      );
      if (autoCompactionArmed) {
        summary.compactionTokenLimit = limit;
      }
      this.requireOpenAdmission();
      const projectedSummary = d.applyPendingSettingsToSummary({ ...summary });
      const liveSession = createLiveSession(summary, session, mcp);
      pendingLiveSession = liveSession;
      d.compaction.subscribePrimary(this.primaryAutomaticCompactionTarget(liveSession));
      d.registry.register(liveSession);
      d.childSessions.attachParent(appSessionId);
      d.emit({
        type: 'session.created',
        clientRef: `resume:${appSessionId}`,
        session: projectedSummary,
      });
      d.emit({ type: 'session.updated', session: projectedSummary });
      if (!autoCompactionArmed) {
        d.emitStatus(appSessionId, AUTO_COMPACTION_UNAVAILABLE_MESSAGE);
      }
      if (
        projectedSummary.sessionPurpose === 'mission-control' &&
        projectedSummary.features.length > 0
      ) {
        d.emit({
          type: 'mission.features',
          appSessionId,
          ...(projectedSummary.missionId !== undefined
            ? { missionId: projectedSummary.missionId }
            : {}),
          features: projectedSummary.features,
        });
      }
      void d.context.refresh(this.primaryContextTarget(liveSession));
      return true;
    } catch (error) {
      await this.cleanupFailedOpen(pendingMcpServers, pendingSession, pendingLiveSession);
      if (!isOpenAdmissionClosed(error))
        d.emitError({ appSessionId, providerSessionId, message: errMsg(error) });
      return false;
    }
  }

  async send(requestedAppSessionId: string, text: string): Promise<void> {
    const liveSession = await this.prepareToSend(requestedAppSessionId);
    if (!liveSession) return;
    await this.promptDelivery.send(liveSession, text);
  }

  async sendNow(requestedAppSessionId: string, text: string): Promise<void> {
    const liveSession = await this.prepareToSend(requestedAppSessionId);
    if (!liveSession) return;
    await this.promptDelivery.sendNow(liveSession, text);
  }

  async interrupt(requestedAppSessionId: string): Promise<void> {
    const liveSession = this.dependencies.registry.getLive(requestedAppSessionId);
    if (!liveSession) return;
    const appSessionId = liveSession.summary.appSessionId;
    this.promptDelivery.discard(liveSession);
    if (liveSession.compacting) {
      this.dependencies.registry.updateSummary(appSessionId, { queuedSends: 0 });
      return;
    }
    const compactionTarget = this.primaryAutomaticCompactionTarget(liveSession);
    const turnAbortController = liveSession.turnAbortController;
    const turnSettlement = liveSession.turnSettlement?.promise ?? Promise.resolve();
    const providerSession = liveSession.session;
    liveSession.interrupting = true;
    const interrupting = providerSession.interrupt();
    turnAbortController?.abort();
    try {
      await Promise.all([interrupting, turnSettlement]);
    } catch (error) {
      await turnSettlement;
      liveSession.interrupting = false;
      this.settlePendingPromptsInBackground(appSessionId);
      throw error;
    }
    if (!compactionTarget.isCurrent()) {
      liveSession.interrupting = false;
      return;
    }
    if (liveSession.autoCompacting) {
      this.dependencies.compaction.cancel(compactionTarget);
    }
    liveSession.interrupting = false;
    this.dependencies.registry.updateSummary(appSessionId, {
      phase: 'paused',
      streaming: false,
      queuedSends: 0,
    });
    this.settlePendingPromptsInBackground(appSessionId);
  }

  async settleAfterCompaction(
    appSessionId: string,
    previousLiveSession?: LiveSession,
  ): Promise<void> {
    if (this.dependencies.isShutdownStarted()) return;
    const liveSession = this.dependencies.registry.getLive(appSessionId);
    if (!liveSession) {
      if (previousLiveSession && previousLiveSession.closeMode !== 'discard-pending') {
        const queued = this.promptDelivery.drain(previousLiveSession);
        await this.redeliverQueuedSends(appSessionId, queued);
      }
      return;
    }
    if (previousLiveSession && liveSession.promptQueue.size === 0) return;
    await this.promptDelivery.settle(liveSession);
  }

  async close(appSessionId: string, mode: SessionCloseMode = 'discard-pending'): Promise<void> {
    const liveSession = this.dependencies.registry.getLive(appSessionId);
    if (!liveSession) return;
    const operation = this.beginClose(liveSession, mode);
    if (operation.created) await this.finishClose(liveSession);
    await operation.deferred.promise;
  }

  private beginClose(liveSession: LiveSession, mode: SessionCloseMode): CloseOperation {
    if (mode === 'discard-pending') {
      liveSession.closeMode = mode;
      this.promptDelivery.discard(liveSession);
    } else {
      liveSession.closeMode ??= mode;
    }
    const existing = this.deferredCloses.get(liveSession);
    if (existing) return { deferred: existing, created: false };

    let resolve = (): void => undefined;
    let reject = (error: unknown): void => {
      void error;
    };
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const deferred = { promise, resolve, reject, started: false };
    this.deferredCloses.set(liveSession, deferred);
    liveSession.closePromise = promise;
    return { deferred, created: true };
  }

  private async finishClose(liveSession: LiveSession): Promise<void> {
    const deferred = this.deferredCloses.get(liveSession);
    if (!deferred || deferred.started) return;
    deferred.started = true;
    try {
      await this.closeSessionResources(liveSession);
      deferred.resolve();
    } catch (error) {
      deferred.reject(error);
    } finally {
      this.deferredCloses.delete(liveSession);
    }
  }

  private async closeSessionResources(liveSession: LiveSession): Promise<void> {
    const d = this.dependencies;
    const appSessionId = liveSession.summary.appSessionId;
    let firstError: unknown;
    const run = async (action: () => void | Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        firstError ??= error;
      }
    };

    await run(() => d.closeDesignSession(appSessionId));
    await run(() => d.childSessions.closeParent(appSessionId));
    await run(() => {
      d.context.stopSession(liveSession);
    });
    await run(() => {
      d.compaction.cancel(this.primaryAutomaticCompactionTarget(liveSession));
    });
    await run(() => {
      liveSession.unsubscribe?.();
    });
    liveSession.turnAbortController?.abort();
    for (const server of liveSession.mcpServers) {
      await run(() => server.close());
    }
    await run(() => liveSession.session.close());
    await run(() => d.closeBrowserSession(appSessionId));
    await run(() => {
      d.context.forgetSession(liveSession);
    });
    let unregistered: LiveSession | undefined;
    try {
      unregistered = d.registry.unregister(appSessionId);
    } catch (error) {
      firstError ??= error;
    }
    if (unregistered) {
      await run(() => {
        d.forgetMissionControl(appSessionId);
      });
      d.emit({ type: 'session.closed', appSessionId });
      await run(() => {
        d.forgetInteractions(appSessionId);
      });
      await run(() => {
        d.forgetEventFlow(appSessionId);
      });
    }
    await run(() => {
      d.emitSessionList();
    });
    if (firstError !== undefined) throw errorFromUnknown(firstError);
  }

  async closeAll(): Promise<void> {
    const scheduled = this.dependencies.registry.liveSessionsSnapshot().map((liveSession) => ({
      liveSession,
      close: this.beginClose(liveSession, 'discard-pending'),
    }));
    let firstError: unknown;
    for (const { liveSession, close } of scheduled) {
      if (close.created) await this.finishClose(liveSession);
      try {
        await close.deferred.promise;
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw errorFromUnknown(firstError);
  }

  private requireOpenAdmission(): void {
    if (this.dependencies.isShutdownStarted()) throw new OpenAdmissionClosedError();
  }

  private primaryContextTarget(liveSession: LiveSession): LiveOperationTarget {
    const d = this.dependencies;
    const appSessionId = liveSession.summary.appSessionId;
    const session = liveSession.session;
    return {
      appSessionId,
      providerSessionId: session.sessionId,
      sourceSessionId: appSessionId,
      session,
      isCurrent: () =>
        !d.isShutdownStarted() &&
        d.registry.getLive(appSessionId) === liveSession &&
        !liveSession.closeMode &&
        liveSession.session === session,
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

  private async prepareToSend(appSessionId: string): Promise<LiveSession | undefined> {
    let liveSession = this.dependencies.registry.getLive(appSessionId);
    if (!liveSession) {
      const resumed = await this.resume(appSessionId);
      if (!resumed) return undefined;
      liveSession = this.dependencies.registry.getLive(appSessionId);
    }
    if (liveSession?.closeMode) return undefined;
    if (!liveSession) {
      const message = `Session ${appSessionId} is not resumable`;
      this.dependencies.emitError({ appSessionId, message });
      return undefined;
    }
    const settingsApplied = await this.dependencies.applyPendingSessionSettings(
      liveSession.summary.appSessionId,
    );
    return settingsApplied && !liveSession.closeMode ? liveSession : undefined;
  }

  private async cleanupFailedOpen(
    mcpServers: LocalMcpResource[],
    session: FactorySession | undefined,
    liveSession: LiveSession | undefined,
  ): Promise<void> {
    liveSession?.unsubscribe?.();
    if (liveSession)
      await runBestEffortAsync(() =>
        this.dependencies.childSessions.closeParent(liveSession.summary.appSessionId),
      );
    await Promise.all(mcpServers.map((server) => runBestEffortAsync(() => server.close())));
    if (session) await runBestEffortAsync(() => session.close());
    if (
      liveSession &&
      this.dependencies.registry.getLive(liveSession.summary.appSessionId) === liveSession
    ) {
      this.dependencies.context.forgetSession(liveSession);
      if (this.dependencies.registry.unregister(liveSession.summary.appSessionId)) {
        this.dependencies.forgetInteractions(liveSession.summary.appSessionId);
        this.dependencies.forgetEventFlow(liveSession.summary.appSessionId);
        this.dependencies.forgetMissionControl(liveSession.summary.appSessionId);
      }
    }
  }

  private settlePendingPromptsInBackground(appSessionId: string): void {
    void this.settleAfterCompaction(appSessionId).catch((error: unknown) => {
      if (!this.dependencies.isShutdownStarted())
        this.dependencies.emitError({ appSessionId, message: errMsg(error) });
    });
  }

  private async redeliverQueuedSends(
    appSessionId: string,
    queued: PrimaryQueuedPrompt[],
  ): Promise<void> {
    for (const prompt of queued) {
      if (this.dependencies.isShutdownStarted()) return;
      try {
        if (prompt.priority === 'steer') await this.sendNow(appSessionId, prompt.text);
        else await this.send(appSessionId, prompt.text);
      } catch (error) {
        this.dependencies.emitError({
          appSessionId,
          message: `Could not deliver a queued message after compaction recovery: ${errMsg(error)}`,
        });
      }
    }
  }
}

function createLiveSession(
  summary: SessionSummary,
  session: FactorySession,
  mcp: StartedLocalMcpResources,
): LiveSession {
  return {
    summary,
    session,
    streaming: false,
    promptQueue: new PrimaryPromptQueue(),
    mcpServers: mcp.servers,
    mcpConfigs: mcp.configs,
    autoCompacting: false,
  };
}

async function runBestEffortAsync(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // Cleanup continues through the remaining resources.
  }
}

class OpenAdmissionClosedError extends Error {}

function isOpenAdmissionClosed(error: unknown): boolean {
  return error instanceof OpenAdmissionClosedError;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
