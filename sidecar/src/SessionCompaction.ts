import {
  daemonCompactionSettings,
  effectiveCompactionTriggerLimit,
  type CompactionTokenLimitPatch,
} from './compaction.js';
import {
  AUTO_COMPACTION_WATCHDOG_MS,
  AutoCompactionWatchdogs,
  POST_TURN_AUTO_COMPACTION_WATCHDOG_MS,
} from './autoCompactionWatchdog.js';
import { extractCompactionNotification, extractDroidWorkingState } from './normalize.js';
import type {
  FactoryDefaultSettings,
  SessionInteractionMode,
  SessionRole,
  SessionSummary,
} from './protocol.js';
import type {
  ChildOperationTarget,
  LiveOperationTarget,
  ProviderOperationTarget,
  SessionContext,
} from './SessionContext.js';
import type { LiveChildSession, LiveSession } from './SessionLifecycle.js';
import { defaultsModeForSummary, errMsg, modelDefaultForMode } from './sessionHelpers.js';
import {
  SessionCompactionExecution,
  type CompactionExecutionResult,
  type SessionCompactionExecutionDependencies,
} from './sessionCompactionExecution.js';

export type { CompactionExecutionResult } from './sessionCompactionExecution.js';

export interface CompactionLimitRequest {
  modelId?: string;
  exposed?: CompactionTokenLimitPatch;
  uiOverride?: CompactionTokenLimitPatch;
  defaults?: FactoryDefaultSettings;
}

export interface PrimaryAutomaticCompactionTarget extends LiveOperationTarget {
  kind: 'primary';
  liveSession: LiveSession;
}

export interface ChildAutomaticCompactionTarget extends ChildOperationTarget {
  kind: 'child';
}

export type AutomaticCompactionTarget =
  | PrimaryAutomaticCompactionTarget
  | ChildAutomaticCompactionTarget;

export interface PrimaryCompactionTarget extends PrimaryAutomaticCompactionTarget {
  configuredModelId?: string;
  defaultsMode: SessionInteractionMode;
}

export interface ChildCompactionTarget extends ChildAutomaticCompactionTarget {
  effectiveModelId?: string;
}

export type CompactionRetuneTarget = PrimaryCompactionTarget | ChildCompactionTarget;

export type CompactionResourceKey =
  | { kind: 'primary'; appSessionId: string }
  | { kind: 'child'; parentAppSessionId: string; childSessionId: string };

export type AutoCompactionSettlement =
  | { kind: 'primary'; appSessionId: string }
  | {
      kind: 'child';
      parentAppSessionId: string;
      childSessionId: string;
      child: LiveChildSession;
    };

export interface SessionCompactionDependencies extends Omit<
  SessionCompactionExecutionDependencies,
  'context'
> {
  context: SessionCompactionExecutionDependencies['context'] &
    Pick<SessionContext, 'recordCompaction'>;
  isShutdownStarted(): boolean;
  getFactoryDefaults(): Promise<FactoryDefaultSettings>;
  maxContextTokensForModel(modelId?: string): number | undefined;
  resolveAutomaticTarget(key: CompactionResourceKey): AutomaticCompactionTarget | undefined;
  settleAutomatic(settlement: AutoCompactionSettlement): void;
}

export function childCompactionModelId(
  summary: Pick<SessionSummary, 'modelId' | 'workerModelId' | 'validatorModelId'>,
  settings: { modelId?: string } | undefined,
  role: SessionRole,
): string | undefined {
  let roleModelId: string | undefined;
  if (role === 'worker') roleModelId = summary.workerModelId;
  else if (role === 'validator') roleModelId = summary.validatorModelId;
  return settings?.modelId ?? roleModelId ?? summary.modelId;
}

export class SessionCompaction {
  private uiSettings: CompactionTokenLimitPatch = {};
  private retuneRevision = 0;
  private epoch = 0;
  private readonly watchdogs: AutoCompactionWatchdogs<CompactionResourceKey>;
  private readonly execution: SessionCompactionExecution;

  constructor(private readonly dependencies: SessionCompactionDependencies) {
    this.watchdogs = new AutoCompactionWatchdogs(compactionResourceId, (key) => {
      this.onWatchdogExpired(key);
    });
    this.execution = new SessionCompactionExecution(dependencies, {
      subscribePrimary: (liveSession) => {
        this.subscribePrimary(this.primaryAutomaticTarget(liveSession));
      },
      rearmPrimary: (liveSession) => this.rearmPrimary(this.primaryRetuneTarget(liveSession)),
      primaryTarget: (liveSession) => this.primaryAutomaticTarget(liveSession),
    });
  }

  async resolveLimit(request: CompactionLimitRequest): Promise<number> {
    const defaults = request.defaults ?? (await this.dependencies.getFactoryDefaults());
    return effectiveCompactionTriggerLimit({
      modelId: request.modelId,
      ui: mergeLimitPatch(this.uiSettings, request.uiOverride),
      exposed: request.exposed,
      defaults,
      maxContextTokens: this.dependencies.maxContextTokensForModel(request.modelId),
    });
  }

  async arm(target: ProviderOperationTarget, limit: number): Promise<boolean> {
    const epoch = this.epoch;
    if (!this.isCurrent(target, epoch)) return false;
    try {
      await target.session.updateSettings(daemonCompactionSettings(limit) as never);
      return this.isCurrent(target, epoch);
    } catch (error) {
      if (this.isCurrent(target, epoch))
        console.error(
          `[compaction] could not arm auto-compaction on ${target.session.sessionId}: ${errMsg(error)}`,
        );
      return false;
    }
  }

  async rearmPrimary(target: PrimaryCompactionTarget): Promise<void> {
    await this.retunePrimary(target);
  }

  async updateLimits(
    update: CompactionTokenLimitPatch,
    targets: readonly CompactionRetuneTarget[],
  ): Promise<void> {
    this.uiSettings = limitPatch(update);
    const revision = ++this.retuneRevision;
    await Promise.allSettled(
      targets.map((target) =>
        target.kind === 'primary'
          ? this.retunePrimary(target, revision)
          : this.retuneChild(target, revision),
      ),
    );
  }

  async rearmModelChangedChild(
    target: ChildCompactionTarget,
    effectiveModelId: string,
  ): Promise<void> {
    if (target.effectiveModelId !== effectiveModelId) return;
    await this.retuneChild(target);
  }

  subscribePrimary(target: PrimaryAutomaticCompactionTarget): void {
    const { liveSession, session } = target;
    const epoch = this.epoch;
    liveSession.unsubscribe?.();
    liveSession.unsubscribe = session.onNotification((note: Record<string, unknown>) => {
      if (!this.isCurrent(target, epoch) || liveSession.compacting) return;
      this.handleAutomaticNotification(target, note);
    });
  }

  handleChildNotification(
    target: ChildAutomaticCompactionTarget,
    note: Record<string, unknown>,
  ): boolean {
    if (!target.isCurrent()) return false;
    return this.handleAutomaticNotification(target, note);
  }

  afterTurn(target: AutomaticCompactionTarget): void {
    if (!target.isCurrent() || !automaticCompactionActive(target)) return;
    this.watchdogs.arm(compactionResourceKey(target), POST_TURN_AUTO_COMPACTION_WATCHDOG_MS);
  }

  cancel(target: AutomaticCompactionTarget): void {
    if (target.kind === 'primary') target.liveSession.autoCompacting = false;
    else target.child.autoCompacting = false;
    this.watchdogs.clear(compactionResourceKey(target));
  }

  async compact(
    appSessionId: string,
    customInstructions?: string,
  ): Promise<CompactionExecutionResult> {
    return this.execution.compact(appSessionId, customInstructions);
  }

  clearAll(): void {
    this.epoch += 1;
    this.retuneRevision += 1;
    this.watchdogs.clearAll();
  }

  private async retunePrimary(target: PrimaryCompactionTarget, revision?: number): Promise<void> {
    const epoch = this.epoch;
    if (!this.isRetuneCurrent(target, epoch, revision)) return;
    const defaults = await this.dependencies.getFactoryDefaults();
    if (!this.isRetuneCurrent(target, epoch, revision)) return;
    const modelId = target.configuredModelId ?? modelDefaultForMode(target.defaultsMode, defaults);
    const limit = await this.resolveLimit({ modelId, defaults });
    if (!this.isRetuneCurrent(target, epoch, revision)) return;
    const armed = await this.arm(target, limit);
    if (!this.isRetuneCurrent(target, epoch, revision)) return;
    this.dependencies.registry.updateSummary(target.appSessionId, {
      compactionTokenLimit: armed ? limit : undefined,
    });
  }

  private async retuneChild(target: ChildCompactionTarget, revision?: number): Promise<void> {
    const epoch = this.epoch;
    if (!this.isRetuneCurrent(target, epoch, revision)) return;
    const limit = await this.resolveLimit({ modelId: target.effectiveModelId });
    if (!this.isRetuneCurrent(target, epoch, revision)) return;
    await this.arm(target, limit);
  }

  private handleAutomaticNotification(
    target: AutomaticCompactionTarget,
    note: Record<string, unknown>,
  ): boolean {
    const compaction = extractCompactionNotification(note);
    if (!compaction) {
      if (extractDroidWorkingState(note) === 'idle') this.setAutoCompacting(target, false);
      return false;
    }
    if (compaction.kind === 'started') {
      this.setAutoCompacting(target, true);
      this.appendAutomaticStatus(target, 'Compacting conversation...');
      return true;
    }
    if (!automaticCompactionActive(target)) return true;

    this.setAutoCompacting(target, false);
    this.appendAutomaticStatus(target, 'Compaction complete.');
    this.dependencies.context.recordCompaction(target);
    void this.dependencies.context.refresh(target).catch(ignoreError);
    return true;
  }

  private setAutoCompacting(target: AutomaticCompactionTarget, active: boolean): void {
    if (!target.isCurrent()) return;
    const wasActive = automaticCompactionActive(target);
    if (target.kind === 'primary') target.liveSession.autoCompacting = active;
    else target.child.autoCompacting = active;

    const key = compactionResourceKey(target);
    if (active) this.watchdogs.arm(key, AUTO_COMPACTION_WATCHDOG_MS);
    else this.watchdogs.clear(key);
    if (active || !wasActive) return;

    if (target.kind === 'primary') {
      if (target.liveSession.streaming || target.liveSession.compacting) return;
      this.dependencies.settleAutomatic({
        kind: 'primary',
        appSessionId: target.appSessionId,
      });
      return;
    }
    if (target.child.streaming) return;
    this.dependencies.settleAutomatic({
      kind: 'child',
      parentAppSessionId: target.parentAppSessionId,
      childSessionId: target.childSessionId,
      child: target.child,
    });
  }

  private appendAutomaticStatus(target: AutomaticCompactionTarget, text: string): void {
    this.dependencies.timeline.appendStatus(
      target.appSessionId,
      text,
      'auto',
      target.kind === 'primary' ? target.appSessionId : target.childSessionId,
      target.kind === 'primary' ? 'primary' : target.role,
    );
  }

  private onWatchdogExpired(key: CompactionResourceKey): void {
    const target = this.dependencies.resolveAutomaticTarget(key);
    if (!target?.isCurrent() || !automaticCompactionActive(target)) return;
    console.warn(
      `[compaction] watchdog settled a stale auto-compaction on ${compactionResourceId(key)}`,
    );
    this.setAutoCompacting(target, false);
  }

  private primaryAutomaticTarget(liveSession: LiveSession): PrimaryAutomaticCompactionTarget {
    const session = liveSession.session;
    const appSessionId = liveSession.summary.appSessionId;
    return {
      kind: 'primary',
      appSessionId,
      providerSessionId: session.sessionId,
      sourceSessionId: appSessionId,
      session,
      liveSession,
      isCurrent: () =>
        !this.dependencies.isShutdownStarted() &&
        this.dependencies.registry.getLive(appSessionId) === liveSession &&
        !liveSession.closeMode &&
        liveSession.session === session,
    };
  }

  private primaryRetuneTarget(liveSession: LiveSession): PrimaryCompactionTarget {
    const target = this.primaryAutomaticTarget(liveSession);
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

  private isRetuneCurrent(
    target: ProviderOperationTarget,
    epoch: number,
    revision: number | undefined,
  ): boolean {
    return (
      this.isCurrent(target, epoch) && (revision === undefined || revision === this.retuneRevision)
    );
  }

  private isCurrent(target: ProviderOperationTarget, epoch: number): boolean {
    return epoch === this.epoch && target.isCurrent();
  }
}

function limitPatch(update: CompactionTokenLimitPatch): CompactionTokenLimitPatch {
  return {
    ...(update.compactionTokenLimit === undefined
      ? {}
      : { compactionTokenLimit: update.compactionTokenLimit }),
    ...(update.compactionTokenLimitPerModel === undefined
      ? {}
      : { compactionTokenLimitPerModel: update.compactionTokenLimitPerModel }),
  };
}

function mergeLimitPatch(
  base: CompactionTokenLimitPatch,
  override: CompactionTokenLimitPatch | undefined,
): CompactionTokenLimitPatch {
  if (!override) return base;
  const merged = { ...base };
  if (override.compactionTokenLimit !== undefined)
    merged.compactionTokenLimit = override.compactionTokenLimit;
  if (override.compactionTokenLimitPerModel !== undefined)
    merged.compactionTokenLimitPerModel = override.compactionTokenLimitPerModel;
  return merged;
}

function automaticCompactionActive(target: AutomaticCompactionTarget): boolean {
  return target.kind === 'primary'
    ? target.liveSession.autoCompacting
    : target.child.autoCompacting;
}

function compactionResourceKey(target: AutomaticCompactionTarget): CompactionResourceKey {
  return target.kind === 'primary'
    ? { kind: 'primary', appSessionId: target.appSessionId }
    : {
        kind: 'child',
        parentAppSessionId: target.parentAppSessionId,
        childSessionId: target.childSessionId,
      };
}

function compactionResourceId(key: CompactionResourceKey): string {
  return key.kind === 'primary'
    ? JSON.stringify(['primary', key.appSessionId])
    : JSON.stringify(['child', key.parentAppSessionId, key.childSessionId]);
}

const ignoreError = (): void => undefined;
