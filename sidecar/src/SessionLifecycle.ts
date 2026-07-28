import {
  type AskUserHandler,
  type McpServerConfig,
  type PermissionHandler,
} from '@factory/droid-sdk';
import type { FactoryRuntime, FactorySession } from './DroidRuntime.js';
import type {
  ClientCommand,
  FactoryDefaultSettings,
  ReasoningEffort,
  ServerEvent,
  SessionSummary,
} from './protocol.js';
import type { SessionRegistry } from './SessionRegistry.js';
import type { CompactionTokenLimitPatch } from './compaction.js';
import type { LiveOperationTarget, SessionContext } from './SessionContext.js';
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

export type SessionCreateCommand = Extract<ClientCommand, { type: 'session.create' }>;
export interface PendingChildSession {
  toolUseId?: string;
  label?: string;
  prompt?: string;
}
export interface ChildSessionSettings {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
}
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
  pendingSends: string[];
  interruptingForSteer?: boolean;
  interrupting?: boolean; // Marks user Stop so the resulting stream abort settles quietly.
}
type SessionCloseMode = 'discard-pending' | 'preserve-pending';
export interface LiveChildSession extends LiveTurnState {
  session: FactorySession;
  childSessionId: string; // Stable parent-map identity; it may differ from session.sessionId.
  appSessionId: string;
  role: 'worker' | 'validator';
  lastUsedAt: number;
  closeWhenIdle?: boolean;
  unsubscribe?: () => void;
}
export interface LiveSession extends LiveTurnState {
  summary: SessionSummary;
  session: FactorySession;
  closeMode?: SessionCloseMode;
  closePromise?: Promise<void>;
  childSessions: Map<string, LiveChildSession>;
  knownChildSessions: Set<string>;
  completedChildSessions: Set<string>;
  // Persisted spawn links seeded on resume, separate from children seen live.
  linkedChildSessions: Set<string>;
  childSessionToolUseIds: Map<string, string>;
  childSessionSettings: Map<string, ChildSessionSettings>;
  pendingChildSessions: PendingChildSession[];
  mcpServers: LocalMcpResource[];
  // Running MCP handles reused when compaction swaps the provider session.
  mcpConfigs: McpServerConfig[];
  todoDisabledForDesign?: boolean;
  compacting?: boolean; // Manual-compaction overlap guard; auto-compaction is separate.
  unsubscribe?: () => void; // Primary provider notification subscription, replaced on swap.
}
type LifecycleError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;
type CompactionLimitRequest =
  | { kind: 'create'; command: CompactionTokenLimitPatch; defaults: FactoryDefaultSettings }
  | { kind: 'resume'; exposed: CompactionTokenLimitPatch };

export interface SessionLifecycleDependencies {
  runtime: FactoryRuntime;
  registry: SessionRegistry<LiveSession>;
  ensureConnected: () => void;
  getFactoryDefaults: () => Promise<FactoryDefaultSettings>;
  maxContextTokensForModel: (modelId?: string) => number | undefined;
  startLocalMcpServers: (ref: { id: string }) => Promise<StartedLocalMcpResources>;
  makePermissionHandler: (ref: { id: string }) => PermissionHandler;
  makeAskUserHandler: (ref: { id: string }) => AskUserHandler;
  compactionLimit(modelId: string | undefined, request: CompactionLimitRequest): Promise<number>;
  enableDaemonAutoCompaction(session: FactorySession, limit: number | undefined): Promise<boolean>;
  isShutdownStarted: () => boolean;
  subscribeSessionCompaction: (liveSession: LiveSession) => void;
  childSessionLinks: (appSessionId: string) => { providerSessionId: string; toolUseId?: string }[];
  applyPendingSettingsToSummary: (summary: SessionSummary) => SessionSummary;
  applyPendingSessionSettings: (appSessionId: string) => Promise<boolean>;
  runPrimaryTurn: (liveSession: LiveSession, prompt: string) => Promise<void>;
  context: Pick<SessionContext, 'refresh' | 'stopPolling' | 'stopSession' | 'forgetSession'>;
  onTurnSettledWhileAutoCompacting: (appSessionId: string) => void;
  clearAutoCompactionWatchdog: (sessionId: string) => void;
  forgetInteractions: (appSessionId: string) => void;
  forgetEventFlow: (appSessionId: string) => void;
  closeBrowserSession: (appSessionId: string) => Promise<void>;
  emit: (event: ServerEvent) => void;
  emitError: (error: LifecycleError) => void;
  emitStatus: (appSessionId: string, text: string) => void;
  emitSessionList: () => void;
}
export class SessionLifecycle {
  private readonly deferredCloses = new WeakMap<LiveSession, DeferredClose>();

  constructor(private readonly dependencies: SessionLifecycleDependencies) {}
  async create(command: SessionCreateCommand): Promise<void> {
    const d = this.dependencies;
    d.ensureConnected();
    const appCwd = command.cwd ?? '';
    const ref = { id: '' };
    let pendingMcpServers: LocalMcpResource[] = [];
    let pendingSession: FactorySession | undefined;
    let pendingLiveSession: LiveSession | undefined;

    try {
      const defaults = await d.getFactoryDefaults();
      const interactionMode = createInteractionModeForCommand(command, defaults);
      const defaultsMode = createDefaultsModeForCommand(command, interactionMode);
      const autonomy = createAutonomyForCommand(command, defaults);
      const primary = createModelDefaultsForMode(defaultsMode, command, defaults);
      const agents = createMissionAgentDefaultsForMode(defaultsMode, command, defaults);
      const compactionModel =
        command.compactionModel ?? defaults.compactionModel ?? 'current-model';
      const compactionTokenLimit = await d.compactionLimit(primary.modelId, {
        kind: 'create',
        command: {
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
      const autoCompactionArmed = await d.enableDaemonAutoCompaction(session, compactionTokenLimit);
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
      d.subscribeSessionCompaction(liveSession);
      d.registry.register(liveSession);
      d.emit({ type: 'session.created', clientRef: command.clientRef, session: summary });
      this.driveInBackground(appSessionId, command.goal);
    } catch (error) {
      await this.cleanupFailedOpen(pendingMcpServers, pendingSession, pendingLiveSession);
      if (!isOpenAdmissionClosed(error)) d.emitError({ message: errMsg(error) });
    }
  }

  async resume(requestedAppSessionId: string): Promise<boolean> {
    const d = this.dependencies;
    d.ensureConnected();
    const historical = d.registry.getCanonicalSummary(requestedAppSessionId);
    const appSessionId = historical?.appSessionId ?? requestedAppSessionId;
    const providerSessionId = historical?.providerSessionId ?? requestedAppSessionId;
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
      const limit = await d.compactionLimit(projectedModel, {
        kind: 'resume',
        exposed: resumed.exposedCompaction,
      });
      this.requireOpenAdmission();
      if (await d.enableDaemonAutoCompaction(session, limit)) {
        summary.compactionTokenLimit = limit;
      }
      this.requireOpenAdmission();
      const projectedSummary = d.applyPendingSettingsToSummary({ ...summary });
      const liveSession = createLiveSession(summary, session, mcp);
      pendingLiveSession = liveSession;
      d.subscribeSessionCompaction(liveSession);
      for (const link of d.childSessionLinks(appSessionId)) {
        liveSession.linkedChildSessions.add(link.providerSessionId);
        if (link.toolUseId) {
          liveSession.childSessionToolUseIds.set(link.toolUseId, link.providerSessionId);
        }
      }
      d.registry.register(liveSession);
      d.emit({
        type: 'session.created',
        clientRef: `resume:${appSessionId}`,
        session: projectedSummary,
      });
      d.emit({ type: 'session.updated', session: projectedSummary });
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
    if (liveSession.streaming || liveSession.compacting || liveSession.autoCompacting) {
      liveSession.pendingSends.push(text);
      this.updateQueuedSends(liveSession);
      return;
    }
    await this.drive(liveSession.summary.appSessionId, text);
  }
  async sendNow(requestedAppSessionId: string, text: string): Promise<void> {
    const liveSession = await this.prepareToSend(requestedAppSessionId);
    if (!liveSession) return;
    if (!liveSession.streaming && !liveSession.compacting && !liveSession.autoCompacting) {
      await this.drive(liveSession.summary.appSessionId, text);
      return;
    }
    liveSession.pendingSends.unshift(text);
    this.updateQueuedSends(liveSession);
    if (liveSession.compacting || liveSession.autoCompacting) return;
    liveSession.interruptingForSteer = true;
    this.dependencies.emitStatus(liveSession.summary.appSessionId, 'Steering now...');
    try {
      await liveSession.session.interrupt();
    } catch (error) {
      liveSession.interruptingForSteer = false;
      this.dependencies.emitError({
        code: 'session.send_now_failed',
        appSessionId: liveSession.summary.appSessionId,
        message: `Could not interrupt session for steering: ${errMsg(error)}`,
      });
    }
  }

  async interrupt(requestedAppSessionId: string): Promise<void> {
    const liveSession = this.dependencies.registry.getLive(requestedAppSessionId);
    if (!liveSession) return;
    const appSessionId = liveSession.summary.appSessionId;
    liveSession.pendingSends = [];
    if (liveSession.compacting) {
      this.dependencies.registry.updateSummary(appSessionId, { queuedSends: 0 });
      return;
    }
    const wasAutoCompacting = liveSession.autoCompacting;
    liveSession.interrupting = true;
    try {
      await liveSession.session.interrupt();
    } catch (error) {
      liveSession.interrupting = false;
      throw error;
    }
    if (wasAutoCompacting) {
      liveSession.autoCompacting = false;
      this.dependencies.clearAutoCompactionWatchdog(appSessionId);
    }
    if (!liveSession.streaming) liveSession.interrupting = false;
    this.dependencies.registry.updateSummary(appSessionId, {
      phase: 'paused',
      streaming: false,
      queuedSends: 0,
    });
  }

  async settleAfterCompaction(
    appSessionId: string,
    previousLiveSession?: LiveSession,
  ): Promise<void> {
    if (this.dependencies.isShutdownStarted()) return;
    const liveSession = this.dependencies.registry.getLive(appSessionId);
    if (!liveSession) {
      if (previousLiveSession && previousLiveSession.closeMode !== 'discard-pending') {
        const queued = previousLiveSession.pendingSends.splice(0);
        await this.redeliverQueuedSends(appSessionId, queued);
      }
      return;
    }
    if (liveSession.closeMode) return;
    if (liveSession.streaming || liveSession.compacting || liveSession.autoCompacting) return;
    const next = liveSession.pendingSends.shift();
    if (next === undefined && previousLiveSession) return;
    this.updateQueuedSends(liveSession);
    if (next !== undefined) await this.drive(liveSession.summary.appSessionId, next);
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
      liveSession.pendingSends = [];
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
    let firstError: unknown;
    const run = async (action: () => void | Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        firstError ??= error;
      }
    };

    await run(() => {
      d.context.stopSession(liveSession);
    });
    await run(() => {
      d.clearAutoCompactionWatchdog(liveSession.summary.appSessionId);
    });
    await run(() => {
      liveSession.unsubscribe?.();
    });
    for (const [providerSessionId, childSession] of liveSession.childSessions) {
      await run(() => {
        d.context.stopPolling(childSession.session.sessionId);
      });
      await run(() => {
        d.clearAutoCompactionWatchdog(providerSessionId);
      });
      await run(() => {
        childSession.unsubscribe?.();
      });
      await run(() => childSession.session.close());
    }
    for (const server of liveSession.mcpServers) {
      await run(() => server.close());
    }
    await run(() => liveSession.session.close());
    await run(() => d.closeBrowserSession(liveSession.summary.appSessionId));
    await run(() => {
      d.context.forgetSession(liveSession);
    });
    let unregistered: LiveSession | undefined;
    try {
      unregistered = d.registry.unregister(liveSession.summary.appSessionId);
    } catch (error) {
      firstError ??= error;
    }
    if (unregistered) {
      await run(() => {
        d.forgetInteractions(liveSession.summary.appSessionId);
      });
      await run(() => {
        d.forgetEventFlow(liveSession.summary.appSessionId);
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
      }
    }
  }

  private async drive(appSessionId: string, prompt: string): Promise<void> {
    const d = this.dependencies;
    const liveSession = d.registry.getLive(appSessionId);
    if (!liveSession || liveSession.closeMode || d.isShutdownStarted()) return;
    const stableAppSessionId = liveSession.summary.appSessionId;
    try {
      liveSession.streaming = true;
      d.registry.updateSummary(stableAppSessionId, {
        phase: liveSession.summary.sessionPurpose === 'mission-control' ? 'planning' : 'running',
        streaming: true,
        queuedSends: liveSession.pendingSends.length,
      });
      await d.runPrimaryTurn(liveSession, prompt);
    } finally {
      liveSession.interruptingForSteer = false;
      liveSession.interrupting = false;
      liveSession.streaming = false;
      if (d.isShutdownStarted() || this.shouldDiscardPendingSends(liveSession)) {
        liveSession.pendingSends = [];
      } else if (!d.registry.getLive(stableAppSessionId)) {
        const queued = liveSession.pendingSends.splice(0);
        if (queued.length > 0) void this.redeliverQueuedSends(stableAppSessionId, queued);
      } else if (liveSession.autoCompacting) {
        d.onTurnSettledWhileAutoCompacting(stableAppSessionId);
        this.updateQueuedSends(liveSession);
      } else {
        const next = liveSession.pendingSends.shift();
        this.updateQueuedSends(liveSession);
        if (next !== undefined) this.driveInBackground(stableAppSessionId, next);
      }
    }
  }

  private driveInBackground(appSessionId: string, prompt: string): void {
    void this.drive(appSessionId, prompt).catch((error: unknown) => {
      if (!this.dependencies.isShutdownStarted())
        this.dependencies.emitError({ appSessionId, message: errMsg(error) });
    });
  }

  private updateQueuedSends(liveSession: LiveSession): void {
    this.dependencies.registry.updateSummary(liveSession.summary.appSessionId, {
      streaming: liveSession.streaming,
      queuedSends: liveSession.pendingSends.length,
    });
  }

  private shouldDiscardPendingSends(liveSession: LiveSession): boolean {
    return liveSession.closeMode === 'discard-pending';
  }

  private async redeliverQueuedSends(appSessionId: string, queued: string[]): Promise<void> {
    for (const text of queued) {
      if (this.dependencies.isShutdownStarted()) return;
      try {
        await this.send(appSessionId, text);
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
    pendingSends: [],
    childSessions: new Map(),
    knownChildSessions: new Set(),
    completedChildSessions: new Set(),
    linkedChildSessions: new Set(),
    childSessionToolUseIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
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
