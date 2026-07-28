import {
  type AskUserHandler,
  type AskUserResult,
  type McpServerConfig,
  type PermissionHandler,
  type RequestPermissionHandlerResult,
} from '@factory/droid-sdk';
import type { FactoryRuntime, FactorySession } from './DroidRuntime.js';
import type {
  ClientCommand,
  FactoryDefaultSettings,
  PermissionKind,
  ReasoningEffort,
  ServerEvent,
  SessionRole,
  SessionSummary,
} from './protocol.js';
import type { SessionRegistry } from './SessionRegistry.js';
import type { CompactionTokenLimitPatch } from './compaction.js';
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
interface PendingPermission {
  resolve: (result: RequestPermissionHandlerResult) => void;
  kind: PermissionKind;
  signature?: string;
}
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
  providerSessionId: string; // Parent map/watchdog key; it may differ from session.sessionId.
  appSessionId: string;
  role: SessionRole;
  lastUsedAt: number;
  closeWhenIdle?: boolean;
  unsubscribe?: () => void;
}
export interface LiveSession extends LiveTurnState {
  summary: SessionSummary;
  session: FactorySession;
  closeMode?: SessionCloseMode;
  closePromise?: Promise<void>;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, (result: AskUserResult) => void>;
  childSessions: Map<string, LiveChildSession>;
  knownChildSessions: Set<string>;
  completedChildSessions: Set<string>;
  // Provider IDs whose current turn already produced its terminal result.
  terminalSources: Set<string>;
  // Persisted spawn links seeded on resume, separate from children seen live.
  linkedChildSessions: Set<string>;
  childSessionToolUseIds: Map<string, string>;
  childSessionSettings: Map<string, ChildSessionSettings>;
  pendingChildSessions: PendingChildSession[];
  mcpServers: LocalMcpResource[];
  // Running MCP handles reused when compaction swaps the provider session.
  mcpConfigs: McpServerConfig[];
  permissionGrants: Set<string>;
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
  subscribeSessionCompaction: (liveSession: LiveSession) => void;
  childSessionLinks: (appSessionId: string) => { providerSessionId: string; toolUseId?: string }[];
  applyPendingSettingsToSummary: (summary: SessionSummary) => SessionSummary;
  applyPendingSessionSettings: (appSessionId: string) => Promise<boolean>;
  runPrimaryTurn: (liveSession: LiveSession, prompt: string) => Promise<void>;
  refreshContext: (sourceSessionId: string, session: FactorySession) => Promise<void>;
  onTurnSettledWhileAutoCompacting: (appSessionId: string) => void;
  stopContextPolling: (sourceSessionId: string) => void;
  clearAutoCompactionWatchdog: (sessionId: string) => void;
  clearSessionRuntimeCaches: (liveSession: LiveSession) => void;
  closeBrowserSession: (appSessionId: string) => Promise<void>;
  emit: (event: ServerEvent) => void;
  emitError: (error: LifecycleError) => void;
  emitStatus: (appSessionId: string, text: string) => void;
  emitSessionList: () => void;
}
export class SessionLifecycle {
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
      const autoCompactionArmed = await d.enableDaemonAutoCompaction(session, compactionTokenLimit);

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
      d.emitError({ message: errMsg(error) });
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
      void d.refreshContext(existing.summary.appSessionId, existing.session);
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
      if (await d.enableDaemonAutoCompaction(session, limit)) {
        summary.compactionTokenLimit = limit;
      }
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
      void d.refreshContext(appSessionId, session);
      return true;
    } catch (error) {
      await this.cleanupFailedOpen(pendingMcpServers, pendingSession, pendingLiveSession);
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
    if (mode === 'discard-pending') {
      liveSession.closeMode = mode;
      liveSession.pendingSends = [];
    } else {
      liveSession.closeMode ??= mode;
    }
    liveSession.closePromise ??= this.closeSessionResources(liveSession);
    await liveSession.closePromise;
  }

  private async closeSessionResources(liveSession: LiveSession): Promise<void> {
    const d = this.dependencies;
    d.stopContextPolling(liveSession.summary.appSessionId);
    if (liveSession.summary.providerSessionId) {
      d.stopContextPolling(liveSession.summary.providerSessionId);
    }
    d.clearAutoCompactionWatchdog(liveSession.summary.appSessionId);
    liveSession.unsubscribe?.();
    for (const [providerSessionId, childSession] of liveSession.childSessions) {
      d.stopContextPolling(childSession.session.sessionId);
      d.clearAutoCompactionWatchdog(providerSessionId);
      childSession.unsubscribe?.();
      await runBestEffortAsync(() => childSession.session.close());
    }
    for (const server of liveSession.mcpServers) {
      await runBestEffortAsync(() => server.close());
    }
    await runBestEffortAsync(() => liveSession.session.close());
    await runBestEffortAsync(() => d.closeBrowserSession(liveSession.summary.appSessionId));
    d.clearSessionRuntimeCaches(liveSession);
    d.registry.unregister(liveSession.summary.appSessionId);
    d.emitSessionList();
  }

  async closeAll(): Promise<void> {
    for (const liveSession of this.dependencies.registry.liveSessionsSnapshot()) {
      await this.close(liveSession.summary.appSessionId);
    }
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
      this.dependencies.clearSessionRuntimeCaches(liveSession);
      this.dependencies.registry.unregister(liveSession.summary.appSessionId);
    }
  }

  private async drive(appSessionId: string, prompt: string): Promise<void> {
    const d = this.dependencies;
    const liveSession = d.registry.getLive(appSessionId);
    if (!liveSession || liveSession.closeMode) return;
    const stableAppSessionId = liveSession.summary.appSessionId;
    try {
      liveSession.streaming = true;
      liveSession.terminalSources.delete(stableAppSessionId);
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
      if (this.shouldDiscardPendingSends(liveSession)) {
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
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    childSessions: new Map(),
    knownChildSessions: new Set(),
    completedChildSessions: new Set(),
    terminalSources: new Set(),
    linkedChildSessions: new Set(),
    childSessionToolUseIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
    mcpServers: mcp.servers,
    mcpConfigs: mcp.configs,
    permissionGrants: new Set(),
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
