import {
  daemonCompactionSettings,
  effectiveCompactionTriggerLimit,
  type CompactionTokenLimitPatch,
} from './compaction.js';
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
} from './SessionContext.js';
import type { LiveSession } from './SessionLifecycle.js';
import type { SessionRegistry } from './SessionRegistry.js';
import { errMsg, modelDefaultForMode } from './sessionHelpers.js';

export interface CompactionLimitRequest {
  modelId?: string;
  exposed?: CompactionTokenLimitPatch;
  uiOverride?: CompactionTokenLimitPatch;
  defaults?: FactoryDefaultSettings;
}

export interface PrimaryCompactionTarget extends LiveOperationTarget {
  kind: 'primary';
  configuredModelId?: string;
  defaultsMode: SessionInteractionMode;
}

export interface ChildCompactionTarget extends ChildOperationTarget {
  kind: 'child';
  effectiveModelId?: string;
}

export type CompactionRetuneTarget = PrimaryCompactionTarget | ChildCompactionTarget;

export interface SessionCompactionDependencies {
  registry: Pick<SessionRegistry<LiveSession>, 'updateSummary'>;
  getFactoryDefaults(): Promise<FactoryDefaultSettings>;
  maxContextTokensForModel(modelId?: string): number | undefined;
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

  constructor(private readonly dependencies: SessionCompactionDependencies) {}

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

  clearAll(): void {
    this.epoch += 1;
    this.retuneRevision += 1;
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
