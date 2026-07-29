import type { AskUserHandler, PermissionHandler } from '@factory/droid-sdk';

import { runCompaction } from './compaction.js';
import type { FactoryRuntime, FactorySession } from './DroidRuntime.js';
import type { ServerEvent } from './protocol.js';
import type { LiveOperationTarget, SessionContext, UsageOffset } from './SessionContext.js';
import type { LiveSession } from './SessionLifecycle.js';
import type { SessionRegistry } from './SessionRegistry.js';
import { errMsg } from './sessionHelpers.js';
import type { SessionTimeline } from './SessionTimeline.js';

export type CompactionExecutionResult =
  | { kind: 'ready-to-settle' }
  | {
      kind: 'close-and-resume';
      appSessionId: string;
      providerSessionId: string;
      carryover: UsageOffset;
      reloadError: string;
    };

export interface SessionCompactionExecutionDependencies {
  registry: Pick<
    SessionRegistry<LiveSession>,
    'getLive' | 'resolveSummary' | 'replaceProvider' | 'updateSummary'
  >;
  context: Pick<SessionContext, 'refresh' | 'preserveUsage'>;
  timeline: Pick<SessionTimeline, 'appendStatus'>;
  runtime: Pick<FactoryRuntime, 'loadSession'>;
  makePermissionHandler(ref: { id: string }): PermissionHandler;
  makeAskUserHandler(ref: { id: string }): AskUserHandler;
  emitError(error: Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>): void;
}

interface SessionCompactionExecutionEffects {
  subscribePrimary(liveSession: LiveSession): void;
  rearmPrimary(liveSession: LiveSession): Promise<void>;
  primaryTarget(liveSession: LiveSession): LiveOperationTarget;
}

export class SessionCompactionExecution {
  constructor(
    private readonly dependencies: SessionCompactionExecutionDependencies,
    private readonly effects: SessionCompactionExecutionEffects,
  ) {}

  async compact(
    appSessionId: string,
    customInstructions?: string,
  ): Promise<CompactionExecutionResult> {
    const liveSession = this.dependencies.registry.getLive(appSessionId);
    if (liveSession) return this.compactLiveSession(liveSession, customInstructions);
    await this.compactHistoricalSession(appSessionId, customInstructions);
    return { kind: 'ready-to-settle' };
  }

  private async compactLiveSession(
    liveSession: LiveSession,
    customInstructions: string | undefined,
  ): Promise<CompactionExecutionResult> {
    const appSessionId = liveSession.summary.appSessionId;
    const preCompactSessionId = liveSession.summary.providerSessionId;
    const carryover: UsageOffset = {
      tokensIn: liveSession.summary.tokensIn,
      tokensOut: liveSession.summary.tokensOut,
    };
    let swapTarget: string | undefined;
    liveSession.compacting = true;
    try {
      const outcome = await runCompaction(
        liveSession.session,
        {
          status: (text, compactType) => {
            this.dependencies.timeline.appendStatus(appSessionId, text, compactType);
          },
          error: (message) => {
            this.dependencies.emitError({
              providerSessionId: liveSession.summary.providerSessionId,
              appSessionId,
              message: `Could not compact session: ${message}`,
              recoverable: true,
            });
          },
          refresh: () => {
            const current = this.dependencies.registry.getLive(appSessionId);
            if (current) {
              this.dependencies.registry.updateSummary(appSessionId, {
                contextTokens: 0,
                contextAccuracy: undefined,
                ...(current.summary.providerSessionId === preCompactSessionId
                  ? { autoCompactions: (current.summary.autoCompactions ?? 0) + 1 }
                  : {}),
              });
            }
            return this.dependencies.context.refresh(this.effects.primaryTarget(liveSession));
          },
          reload: async (newSessionId) => {
            swapTarget = newSessionId;
            await this.adoptProvider(liveSession, newSessionId, carryover);
          },
        },
        { customInstructions, compactType: 'manual' },
      );
      if (outcome === 'stale' && swapTarget)
        return await this.recoverStaleProvider(liveSession, swapTarget, carryover);
      return { kind: 'ready-to-settle' };
    } finally {
      liveSession.compacting = false;
    }
  }

  private async adoptProvider(
    liveSession: LiveSession,
    providerSessionId: string,
    carryover: UsageOffset,
  ): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    const ref = { id: appSessionId };
    const oldSession = liveSession.session;
    const replacement = await this.dependencies.runtime.loadSession(providerSessionId, {
      permissionHandler: this.dependencies.makePermissionHandler(ref),
      askUserHandler: this.dependencies.makeAskUserHandler(ref),
      mcpServers: liveSession.mcpConfigs,
    });
    liveSession.session = replacement;
    let oldSessionRetired = false;
    const retireOldSession = async (): Promise<void> => {
      if (oldSessionRetired) return;
      oldSessionRetired = true;
      await oldSession.close().catch(ignoreError);
    };
    try {
      this.effects.subscribePrimary(liveSession);
      await this.effects.rearmPrimary(liveSession).catch(ignoreError);
      liveSession.todoDisabledForDesign = undefined;
      await retireOldSession();
      this.dependencies.context.preserveUsage(appSessionId, carryover);
      this.replaceProvider(appSessionId, providerSessionId, carryover);
    } catch (error) {
      await retireOldSession();
      throw error;
    }
  }

  private async recoverStaleProvider(
    liveSession: LiveSession,
    providerSessionId: string,
    carryover: UsageOffset,
  ): Promise<CompactionExecutionResult> {
    let reloadError: string;
    try {
      await this.adoptProvider(liveSession, providerSessionId, carryover);
      return { kind: 'ready-to-settle' };
    } catch (error) {
      // Persist the daemon-authoritative id; Manager performs close-and-resume.
      reloadError = errMsg(error);
    }
    const appSessionId = liveSession.summary.appSessionId;
    try {
      this.replaceProvider(appSessionId, providerSessionId, carryover);
    } catch (error) {
      this.dependencies.emitError({
        providerSessionId,
        appSessionId,
        message: `Could not persist compacted session identity: ${errMsg(error)}`,
        recoverable: true,
      });
      throw error;
    }
    return {
      kind: 'close-and-resume',
      appSessionId,
      providerSessionId,
      carryover,
      reloadError,
    };
  }

  private async compactHistoricalSession(
    requestedAppSessionId: string,
    customInstructions: string | undefined,
  ): Promise<void> {
    const historical = this.dependencies.registry.resolveSummary(requestedAppSessionId);
    const appSessionId = historical?.appSessionId ?? requestedAppSessionId;
    const oldProviderSessionId = historical?.providerSessionId ?? requestedAppSessionId;
    let session: FactorySession | undefined;
    try {
      session = await this.dependencies.runtime.loadSession(oldProviderSessionId);
      const result: unknown = await session.compactSession(
        customInstructions ? { customInstructions } : {},
      );
      const providerSessionId =
        result !== null &&
        typeof result === 'object' &&
        'newSessionId' in result &&
        typeof result.newSessionId === 'string' &&
        result.newSessionId
          ? result.newSessionId
          : oldProviderSessionId;
      if (providerSessionId !== oldProviderSessionId && historical)
        this.dependencies.registry.replaceProvider(appSessionId, providerSessionId);
    } catch (error) {
      this.dependencies.emitError({
        providerSessionId: oldProviderSessionId,
        appSessionId,
        message: `Could not compact session: ${errMsg(error)}`,
        recoverable: true,
      });
    } finally {
      if (session) await session.close().catch(ignoreError);
    }
  }

  private replaceProvider(
    appSessionId: string,
    providerSessionId: string,
    carryover: UsageOffset,
  ): void {
    const updated = this.dependencies.registry.replaceProvider(appSessionId, providerSessionId, {
      tokensIn: carryover.tokensIn,
      tokensOut: carryover.tokensOut,
      contextTokens: 0,
    });
    if (!updated) {
      throw new Error(`Session ${appSessionId} disappeared before its provider could be replaced.`);
    }
  }
}

const ignoreError = (): void => undefined;
