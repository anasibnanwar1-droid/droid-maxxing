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
export interface PendingPermission {
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
export interface LocalMcpResource {
  close(): Promise<void>;
}
export interface StartedLocalMcpResources {
  servers: LocalMcpResource[];
  configs: McpServerConfig[];
}
export interface LiveTurnState {
  streaming: boolean;
  autoCompacting: boolean;
  pendingSends: string[];
  interruptingForSteer?: boolean;
  interrupting?: boolean; // Marks user Stop so the resulting stream abort settles quietly.
}
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
export type LifecycleError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;
export type CompactionLimitRequest =
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
      await d.enableDaemonAutoCompaction(session, compactionTokenLimit);

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
        compactionTokenLimit,
        now: Date.now(),
      });
      ref.id = appSessionId;
      const liveSession = createLiveSession(summary, session, mcp);
      d.subscribeSessionCompaction(liveSession);
      d.registry.register(liveSession);
      d.emit({ type: 'session.created', clientRef: command.clientRef, session: summary });
      void this.drive(appSessionId, command.goal);
    } catch (error) {
      await Promise.all(
        pendingMcpServers.map((server) => runBestEffortAsync(() => server.close())),
      );
      d.emitError({ message: errMsg(error) });
    }
  }

  async resume(requestedAppSessionId: string): Promise<void> {
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
      return;
    }

    const ref = { id: appSessionId };
    let pendingMcpServers: LocalMcpResource[] = [];
    try {
      const mcp = await d.startLocalMcpServers(ref);
      pendingMcpServers = mcp.servers;
      const session = await d.runtime.loadSession(providerSessionId, {
        permissionHandler: d.makePermissionHandler(ref),
        askUserHandler: d.makeAskUserHandler(ref),
        mcpServers: mcp.configs,
      });
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
    } catch (error) {
      await Promise.all(
        pendingMcpServers.map((server) => runBestEffortAsync(() => server.close())),
      );
      d.emitError({ appSessionId, providerSessionId, message: errMsg(error) });
    }
  }

  async send(appSessionId: string, text: string): Promise<void> {
    const liveSession = await this.resumeIfNeeded(appSessionId);
    if (!liveSession || !(await this.dependencies.applyPendingSessionSettings(appSessionId)))
      return;
    if (liveSession.streaming || liveSession.compacting || liveSession.autoCompacting) {
      liveSession.pendingSends.push(text);
      this.updateQueuedSends(liveSession);
      return;
    }
    await this.drive(appSessionId, text);
  }

  async sendNow(appSessionId: string, text: string): Promise<void> {
    const liveSession = await this.resumeIfNeeded(appSessionId);
    if (!liveSession || !(await this.dependencies.applyPendingSessionSettings(appSessionId)))
      return;
    if (!liveSession.streaming && !liveSession.compacting && !liveSession.autoCompacting) {
      await this.drive(appSessionId, text);
      return;
    }
    liveSession.pendingSends.unshift(text);
    this.updateQueuedSends(liveSession);
    if (liveSession.compacting || liveSession.autoCompacting) return;
    liveSession.interruptingForSteer = true;
    this.dependencies.emitStatus(appSessionId, 'Steering now...');
    try {
      await liveSession.session.interrupt();
    } catch (error) {
      liveSession.interruptingForSteer = false;
      this.dependencies.emitError({
        code: 'session.send_now_failed',
        appSessionId,
        message: `Could not interrupt session for steering: ${errMsg(error)}`,
      });
    }
  }

  async interrupt(appSessionId: string): Promise<void> {
    const liveSession = this.dependencies.registry.getLive(appSessionId);
    if (!liveSession) return;
    liveSession.pendingSends = [];
    if (liveSession.compacting) {
      this.dependencies.registry.updateSummary(appSessionId, { queuedSends: 0 });
      return;
    }
    const wasAutoCompacting = liveSession.autoCompacting;
    liveSession.interrupting = true;
    await liveSession.session.interrupt();
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
      if (previousLiveSession) {
        const queued = previousLiveSession.pendingSends.splice(0);
        await this.redeliverQueuedSends(appSessionId, queued);
      }
      return;
    }
    if (liveSession.streaming || liveSession.compacting || liveSession.autoCompacting) return;
    const next = liveSession.pendingSends.shift();
    if (next === undefined && previousLiveSession) return;
    this.updateQueuedSends(liveSession);
    if (next !== undefined) await this.drive(liveSession.summary.appSessionId, next);
  }

  async close(appSessionId: string): Promise<void> {
    const d = this.dependencies;
    const liveSession = d.registry.getLive(appSessionId);
    if (!liveSession) return;
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

  private async resumeIfNeeded(appSessionId: string): Promise<LiveSession | undefined> {
    let liveSession = this.dependencies.registry.getLive(appSessionId);
    if (!liveSession) {
      await this.resume(appSessionId);
      liveSession = this.dependencies.registry.getLive(appSessionId);
    }
    if (!liveSession) {
      this.dependencies.emitError({
        appSessionId,
        message: `Session ${appSessionId} is not resumable`,
      });
    }
    return liveSession;
  }

  private async drive(appSessionId: string, prompt: string): Promise<void> {
    const d = this.dependencies;
    const liveSession = d.registry.getLive(appSessionId);
    if (!liveSession) return;
    liveSession.streaming = true;
    liveSession.terminalSources.delete(appSessionId);
    d.registry.updateSummary(appSessionId, {
      phase: liveSession.summary.sessionPurpose === 'mission-control' ? 'planning' : 'running',
      streaming: true,
      queuedSends: liveSession.pendingSends.length,
    });
    try {
      await d.runPrimaryTurn(liveSession, prompt);
    } finally {
      liveSession.interruptingForSteer = false;
      liveSession.interrupting = false;
      liveSession.streaming = false;
      if (!d.registry.getLive(appSessionId)) {
        const queued = liveSession.pendingSends.splice(0);
        if (queued.length > 0) void this.redeliverQueuedSends(appSessionId, queued);
      } else if (liveSession.autoCompacting) {
        d.onTurnSettledWhileAutoCompacting(appSessionId);
        this.updateQueuedSends(liveSession);
      } else {
        const next = liveSession.pendingSends.shift();
        this.updateQueuedSends(liveSession);
        if (next !== undefined) void this.drive(appSessionId, next);
      }
    }
  }

  private updateQueuedSends(liveSession: LiveSession): void {
    this.dependencies.registry.updateSummary(liveSession.summary.appSessionId, {
      streaming: liveSession.streaming,
      queuedSends: liveSession.pendingSends.length,
    });
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
