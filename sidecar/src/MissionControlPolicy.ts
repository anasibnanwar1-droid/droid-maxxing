import type { ChildSessions } from './ChildSessions.js';
import {
  childSettingsFromInit,
  type ChildParentLease,
  type ChildSettings,
} from './ChildSessionState.js';
import type { NormalizedSideEffects } from './SessionEventFlow.js';
import type { ProgressEntry, ServerEvent } from './protocol.js';
import type { SessionRegistry } from './SessionRegistry.js';
import { phaseFromState } from './sessionHelpers.js';

interface MissionCorrelation {
  providerSessionId?: string;
  spawnId?: string;
  childSessionId?: string;
  completed: boolean;
}

interface ParentMissionState {
  byProvider: Map<string, MissionCorrelation>;
  bySpawn: Map<string, MissionCorrelation>;
  retiredProviders: Set<string>;
}

export interface MissionControlPolicyDependencies {
  registry: Pick<SessionRegistry<ChildParentLease>, 'getLive' | 'updateSummary'>;
  childSessions: Pick<ChildSessions, 'admitChildObservation'>;
  resolveCatalogDefaultSettings(): ChildSettings;
  emit(event: ServerEvent): void;
}

export class MissionControlPolicy {
  private readonly parents = new Map<string, ParentMissionState>();

  constructor(private readonly d: MissionControlPolicyDependencies) {}

  apply(parentAppSessionId: string, effects: NormalizedSideEffects): void {
    const live = this.d.registry.getLive(parentAppSessionId);
    if (live?.summary.sessionPurpose !== 'mission-control') return;

    if (effects.features) {
      this.d.registry.updateSummary(parentAppSessionId, { features: effects.features });
      this.d.emit({
        type: 'mission.features',
        appSessionId: parentAppSessionId,
        ...(live.summary.missionId ? { missionId: live.summary.missionId } : {}),
        features: effects.features,
      });
    }
    if (effects.missionChild)
      this.applyChildEvent(
        parentAppSessionId,
        effects.missionChild.providerSessionId,
        effects.missionChild.event,
      );
    if (effects.progress) {
      const entries = effects.progress.map((entry) =>
        this.projectProgress(parentAppSessionId, entry),
      );
      this.d.emit({
        type: 'mission.progress',
        appSessionId: parentAppSessionId,
        ...(live.summary.missionId ? { missionId: live.summary.missionId } : {}),
        entries,
      });
    }
    if (effects.missionState) {
      const phase = phaseFromState(effects.missionState);
      if (phase) this.d.registry.updateSummary(parentAppSessionId, { phase });
    }
  }

  resolveDefaultSettings(parentAppSessionId: string, role: 'worker' | 'validator'): ChildSettings {
    const live = this.d.registry.getLive(parentAppSessionId);
    if (!live) throw new Error(`Mission Control parent ${parentAppSessionId} is not live.`);
    const parent = childSettingsFromInit(live.session.initResult);
    const catalog = this.d.resolveCatalogDefaultSettings();
    const roleModelId =
      role === 'validator' ? live.summary.validatorModelId : live.summary.workerModelId;
    const roleReasoningEffort =
      role === 'validator'
        ? live.summary.validatorReasoningEffort
        : live.summary.workerReasoningEffort;
    return {
      modelId: roleModelId ?? parent.modelId ?? catalog.modelId,
      reasoningEffort: roleReasoningEffort ?? parent.reasoningEffort ?? catalog.reasoningEffort,
    };
  }

  forget(parentAppSessionId: string): void {
    this.parents.delete(parentAppSessionId);
  }

  clear(): void {
    this.parents.clear();
  }

  private applyChildEvent(
    parentAppSessionId: string,
    providerSessionId: string,
    event: 'started' | 'completed',
  ): void {
    const parent = this.parentState(parentAppSessionId);
    if (parent.retiredProviders.has(providerSessionId)) return;
    const correlation = parent.byProvider.get(providerSessionId);
    if (event === 'started') {
      if (!correlation)
        parent.byProvider.set(providerSessionId, {
          providerSessionId,
          completed: false,
        });
      return;
    }
    const pending = correlation ?? { providerSessionId, completed: false };
    pending.completed = true;
    parent.byProvider.set(providerSessionId, pending);
    if (!pending.childSessionId) return;
    this.d.childSessions.admitChildObservation({
      parentAppSessionId,
      providerSessionId,
      role: 'worker',
      ...(pending.spawnId ? { spawnLink: { kind: 'spawn' as const, id: pending.spawnId } } : {}),
      done: true,
    });
  }

  private projectProgress(
    parentAppSessionId: string,
    entry: NonNullable<NormalizedSideEffects['progress']>[number],
  ): ProgressEntry {
    const { workerProviderSessionId, spawnId, ...publicEntry } = entry;
    const correlation =
      entry.type === 'worker_started' && workerProviderSessionId && spawnId
        ? this.correlateWorker(parentAppSessionId, workerProviderSessionId, spawnId)
        : this.findCorrelation(parentAppSessionId, workerProviderSessionId, spawnId);
    return correlation?.childSessionId
      ? { ...publicEntry, workerChildSessionId: correlation.childSessionId }
      : publicEntry;
  }

  private correlateWorker(
    parentAppSessionId: string,
    providerSessionId: string,
    spawnId: string,
  ): MissionCorrelation | undefined {
    const parent = this.parentState(parentAppSessionId);
    if (parent.retiredProviders.has(providerSessionId)) return undefined;
    const byProvider = parent.byProvider.get(providerSessionId);
    const bySpawn = parent.bySpawn.get(spawnId);
    if (byProvider?.spawnId && byProvider.spawnId !== spawnId) return undefined;

    const correlation = bySpawn ?? byProvider ?? { completed: false };
    if (bySpawn?.providerSessionId && bySpawn.providerSessionId !== providerSessionId) {
      parent.byProvider.delete(bySpawn.providerSessionId);
      parent.retiredProviders.add(bySpawn.providerSessionId);
    }
    if (byProvider && byProvider !== correlation) {
      correlation.completed ||= byProvider.completed;
    }
    correlation.providerSessionId = providerSessionId;
    correlation.spawnId = spawnId;
    parent.byProvider.set(providerSessionId, correlation);
    parent.bySpawn.set(spawnId, correlation);

    const identity = this.d.childSessions.admitChildObservation({
      parentAppSessionId,
      providerSessionId,
      role: 'worker',
      spawnLink: { kind: 'spawn', id: spawnId },
    });
    if (!identity) return correlation;
    correlation.childSessionId = identity.childSessionId;
    if (correlation.completed)
      this.d.childSessions.admitChildObservation({
        parentAppSessionId,
        providerSessionId,
        role: 'worker',
        spawnLink: { kind: 'spawn', id: spawnId },
        done: true,
      });
    return correlation;
  }

  private findCorrelation(
    parentAppSessionId: string,
    providerSessionId?: string,
    spawnId?: string,
  ): MissionCorrelation | undefined {
    const parent = this.parents.get(parentAppSessionId);
    if (!parent) return undefined;
    if (providerSessionId && parent.retiredProviders.has(providerSessionId)) return undefined;
    const byProvider = providerSessionId ? parent.byProvider.get(providerSessionId) : undefined;
    const bySpawn = spawnId ? parent.bySpawn.get(spawnId) : undefined;
    if (providerSessionId && spawnId)
      return byProvider && byProvider === bySpawn ? byProvider : undefined;
    return byProvider ?? bySpawn;
  }

  private parentState(parentAppSessionId: string): ParentMissionState {
    const existing = this.parents.get(parentAppSessionId);
    if (existing) return existing;
    const created: ParentMissionState = {
      byProvider: new Map(),
      bySpawn: new Map(),
      retiredProviders: new Set(),
    };
    this.parents.set(parentAppSessionId, created);
    return created;
  }
}
