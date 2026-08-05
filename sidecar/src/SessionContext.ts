import type { FactoryRuntime, FactorySession } from './DroidRuntime.js';
import {
  applyExactUsage,
  cappedContextSnapshot,
  contextBreakdownSnapshot,
  contextStatsSnapshot,
  rebasedContextSnapshot,
} from './contextSnapshots.js';
import type { ContextStatsSnapshot, ServerEvent, SessionSummary } from './protocol.js';
import type { SessionRegistry } from './SessionRegistry.js';
import type { LiveSession } from './SessionLifecycle.js';

export interface ProviderOperationTarget {
  session: FactorySession;
  isCurrent(): boolean;
}

export interface LiveOperationTarget extends ProviderOperationTarget {
  appSessionId: string;
  providerSessionId: string;
  sourceSessionId: string;
}

export interface ChildIdentity {
  parentAppSessionId: string;
  childSessionId: string;
}

export interface ChildOperationTarget extends ProviderOperationTarget, ChildIdentity {
  appSessionId: string;
  providerSessionId: string;
  sourceSessionId: string;
  role: 'worker' | 'validator';
}

export type ContextOperationTarget = LiveOperationTarget | ChildOperationTarget;

export interface NormalizedTokenUsage {
  tokensIn: number;
  tokensOut: number;
  contextTokens?: number;
}

export interface UsageOffset {
  tokensIn: number;
  tokensOut: number;
}

interface SessionContextDependencies {
  registry: SessionRegistry<LiveSession>;
  runtime: Pick<FactoryRuntime, 'readContextBreakdown'>;
  emit: (event: ServerEvent) => void;
  maxContextTokensForSummary: (summary: SessionSummary) => number | undefined;
  // Reports the context window the provider itself measured for a model, so
  // compaction limits can be clamped even for models missing from the catalog.
  noteContextWindow: (modelId: string, contextWindowTokens: number) => void;
}

interface ContextPoller {
  timer: ReturnType<typeof setInterval>;
  session: FactorySession;
}

export class SessionContext {
  private readonly usageOffsets = new Map<string, UsageOffset>();
  private readonly snapshots = new Map<string, ContextStatsSnapshot>();
  // Some daemon versions keep getContextStats().used cumulative across
  // in-place compactions even though limit remains the model window. Remember
  // the raw counter at each compaction generation so the UI can show growth in
  // the current generation instead of an impossible used > limit snapshot.
  private readonly providerUsageBaselines = new Map<string, { generation: number; used: number }>();
  private readonly latestProviderUsage = new Map<string, number>();
  // Compactions recorded per context resource. The count doubles as a staleness
  // generation: stats fetched before a compaction must never be published after
  // it, or the meter would jump back to the pre-compaction reading.
  private readonly compactions = new Map<string, number>();
  // Primary resources whose post-compaction reset has not been cleared by a
  // new turn boundary. While pending, exact usage reported by queued
  // pre-compaction stream events must not overwrite the reset summary. The
  // flag stays set after a provider reading confirms the reset (the poller
  // keeps the meter accurate) and is only cleared when a new turn begins, so
  // a late pre-compaction usage event delivered after the poll can never
  // resurrect the old meter.
  private readonly pendingCompactionResets = new Set<string>();
  private readonly recordedCompactions = new Map<string, Map<string, number>>();
  private readonly pollers = new Map<string, ContextPoller>();
  private epoch = 0;

  constructor(private readonly dependencies: SessionContextDependencies) {}

  recordUsage(appSessionId: string, sourceSessionId: string, usage: NormalizedTokenUsage): void {
    const liveSession = this.dependencies.registry.getLive(appSessionId);
    if (!liveSession || liveSession.closeMode) return;

    const stableAppSessionId = liveSession.summary.appSessionId;
    const offset = this.usageOffsets.get(stableAppSessionId);
    const nextSummary = {
      ...liveSession.summary,
      tokensIn: usage.tokensIn + (offset?.tokensIn ?? 0),
      tokensOut: usage.tokensOut + (offset?.tokensOut ?? 0),
    };

    // Child turns contribute to cumulative usage, but the primary summary owns
    // current-context telemetry. Children publish their own refreshes.
    // While a compaction reset is pending, usage events that were queued before
    // the compaction carry pre-compaction context tokens; applying them would
    // undo the reset, so context fields wait for the next provider refresh.
    const canPublishContext =
      sourceSessionId === stableAppSessionId &&
      !this.pendingCompactionResets.has(primaryResourceKey(stableAppSessionId));
    const currentContextTokens = canPublishContext ? usage.contextTokens : undefined;
    if (currentContextTokens !== undefined) {
      nextSummary.contextTokens = currentContextTokens;
      if (currentContextTokens > 0) {
        nextSummary.contextAccuracy = 'exact';
        nextSummary.contextUpdatedAt = new Date().toISOString();
      }
      const maxContextTokens = this.dependencies.maxContextTokensForSummary(nextSummary);
      if (maxContextTokens !== undefined) nextSummary.maxContextTokens = maxContextTokens;
      this.emitEstimate(stableAppSessionId, nextSummary);
    }

    try {
      this.dependencies.registry.updateSummary(stableAppSessionId, {
        tokensIn: nextSummary.tokensIn,
        tokensOut: nextSummary.tokensOut,
        ...(currentContextTokens !== undefined
          ? {
              contextTokens: nextSummary.contextTokens,
              contextAccuracy: nextSummary.contextAccuracy,
              contextUpdatedAt: nextSummary.contextUpdatedAt,
              maxContextTokens: nextSummary.maxContextTokens,
            }
          : {}),
      });
    } catch {
      // Usage telemetry must not fail the active provider turn.
      liveSession.summary = nextSummary;
      this.dependencies.emit({
        type: 'session.updated',
        session: { ...nextSummary, updatedAt: Date.now() },
      });
    }
  }

  startPolling(target: ContextOperationTarget): void {
    const key = contextResourceKey(target);
    if (this.pollers.has(key) || !target.isCurrent()) return;
    const epoch = this.epoch;
    const poll = () => {
      if (epoch !== this.epoch || !target.isCurrent()) return;
      void this.refresh(target, { persist: false });
    };
    const timer = setInterval(poll, 2_500);
    this.pollers.set(key, { timer, session: target.session });
    poll();
  }

  stopPolling(target: ContextOperationTarget): void {
    const key = contextResourceKey(target);
    const poller = this.pollers.get(key);
    if (poller?.session !== target.session) return;
    clearInterval(poller.timer);
    this.pollers.delete(key);
  }

  async refresh(
    target: ContextOperationTarget,
    options: { persist?: boolean } = {},
  ): Promise<void> {
    const epoch = this.epoch;
    const generation = this.compactions.get(contextResourceKey(target)) ?? 0;
    if (!target.isCurrent()) return;
    try {
      const stats = await target.session.getContextStats();
      if (!this.isCurrent(target, epoch)) return;
      let breakdown: unknown;
      try {
        breakdown = await this.dependencies.runtime.readContextBreakdown(target.session);
      } catch {
        breakdown = undefined;
      }
      if (!this.isCurrent(target, epoch)) return;
      this.publishSnapshot(
        target,
        contextStatsSnapshot(stats, contextBreakdownSnapshot(breakdown)),
        options,
        generation,
      );
    } catch {
      // Context is informational and must never disrupt an active turn.
    }
  }

  recordCompaction(target: ContextOperationTarget, compactionId?: string): void {
    const key = contextResourceKey(target);
    const retryKey = compactionRetryKey(target);
    const recordedGeneration = compactionId
      ? this.recordedCompactions.get(retryKey)?.get(compactionId)
      : undefined;
    if (isChildTarget(target)) {
      // Completion settlement may synchronously detach a standalone child before
      // accounting runs. Preserve that established generation residue; the
      // captured target still keeps refreshes inert, while top-level teardown
      // clears all owned generations after blocking new notifications.
      if (
        recordedGeneration !== undefined &&
        (this.compactions.get(key) ?? 0) >= recordedGeneration
      )
        return;
      const generation = (this.compactions.get(key) ?? 0) + 1;
      this.compactions.set(key, generation);
      this.captureProviderUsageBaseline(key, generation);
      this.rememberCompaction(retryKey, compactionId, generation);
      return;
    }

    if (!target.isCurrent()) return;
    const liveSession = this.dependencies.registry.getLive(target.appSessionId);
    if (liveSession?.session !== target.session || !target.isCurrent()) return;
    if (
      recordedGeneration !== undefined &&
      (liveSession.summary.autoCompactions ?? 0) > recordedGeneration
    )
      return;
    const generation = recordedGeneration ?? (liveSession.summary.autoCompactions ?? 0) + 1;
    if (recordedGeneration === undefined) {
      this.compactions.set(key, (this.compactions.get(key) ?? 0) + 1);
      this.captureProviderUsageBaseline(key, generation);
      this.pendingCompactionResets.add(key);
      this.rememberCompaction(retryKey, compactionId, generation);
    }
    const patch = {
      contextTokens: 0,
      contextAccuracy: undefined,
      autoCompactions: generation,
    } as const;
    try {
      this.dependencies.registry.updateSummary(target.appSessionId, patch);
    } catch (error) {
      // Runtime telemetry must advance even when its historical snapshot cannot
      // be persisted. A retry with the same compactionId reuses this generation
      // and only retries persistence, so the meter cannot double-increment.
      liveSession.summary = { ...liveSession.summary, ...patch };
      this.dependencies.emit({
        type: 'session.updated',
        session: { ...liveSession.summary, updatedAt: Date.now() },
      });
      throw error;
    }
  }

  // A new primary turn begins: pre-compaction stream events from the previous
  // turn can no longer be delivered, so the pending-compaction guard is safe to
  // clear. The poller's provider readings already keep the meter accurate; this
  // just re-enables usage-event context estimates for the new turn.
  beginTurn(appSessionId: string): void {
    this.pendingCompactionResets.delete(primaryResourceKey(appSessionId));
  }

  preserveUsage(appSessionId: string, offset: UsageOffset): void {
    this.usageOffsets.set(appSessionId, offset);
  }

  forgetChild(identity: ChildIdentity): void {
    const key = childIdentityKey(identity);
    this.snapshots.delete(key);
    this.compactions.delete(key);
    this.providerUsageBaselines.delete(key);
    this.latestProviderUsage.delete(key);
    this.forgetRecordedCompactions(key);
  }

  stopSession(liveSession: LiveSession): void {
    this.stopPollingKey(primaryResourceKey(liveSession.summary.appSessionId));
  }

  forgetSession(liveSession: LiveSession): void {
    const appSessionId = liveSession.summary.appSessionId;
    this.usageOffsets.delete(appSessionId);
    const key = primaryResourceKey(appSessionId);
    this.snapshots.delete(key);
    this.compactions.delete(key);
    this.providerUsageBaselines.delete(key);
    this.latestProviderUsage.delete(key);
    this.pendingCompactionResets.delete(key);
    this.forgetRecordedCompactions(key);
  }

  clearAll(): void {
    this.epoch += 1;
    for (const poller of this.pollers.values()) clearInterval(poller.timer);
    this.pollers.clear();
    this.snapshots.clear();
    this.compactions.clear();
    this.providerUsageBaselines.clear();
    this.latestProviderUsage.clear();
    this.pendingCompactionResets.clear();
    this.recordedCompactions.clear();
    this.usageOffsets.clear();
  }

  private isCurrent(target: ContextOperationTarget, epoch: number): boolean {
    return epoch === this.epoch && target.isCurrent();
  }

  private stopPollingKey(key: string): void {
    const poller = this.pollers.get(key);
    if (!poller) return;
    clearInterval(poller.timer);
    this.pollers.delete(key);
  }

  private publishSnapshot(
    target: ContextOperationTarget,
    providerSnapshot: ContextStatsSnapshot,
    options: { persist?: boolean },
    generation: number,
  ): void {
    const key = contextResourceKey(target);
    // A compaction recorded while the stats call was in flight makes this
    // reading pre-compaction; publishing it would undo the meter reset.
    if (generation !== (this.compactions.get(key) ?? 0)) return;
    if (!target.isCurrent()) return;
    const liveSession = this.dependencies.registry.getLive(target.appSessionId);
    if (!liveSession) return;
    // A zero window is a transient/invalid provider reading, not a real empty
    // context. Ignore it without disturbing the last valid cumulative counter
    // or the post-compaction baseline used to rebase the next reading.
    if (providerSnapshot.limit <= 0) return;

    const windowModelId =
      providerSnapshot.breakdown?.modelId ??
      (isChildTarget(target) ? undefined : liveSession.summary.modelId);
    if (windowModelId !== undefined && providerSnapshot.limit > 0)
      this.dependencies.noteContextWindow(windowModelId, providerSnapshot.limit);

    const normalizedProviderSnapshot = this.normalizeProviderWindowSnapshot(
      key,
      providerSnapshot,
      isChildTarget(target) ? generation : (liveSession.summary.autoCompactions ?? generation),
    );
    const snapshot = isChildTarget(target)
      ? {
          ...normalizedProviderSnapshot,
          compactions: this.compactions.get(key) ?? 0,
        }
      : applyExactUsage(normalizedProviderSnapshot, liveSession.summary);

    if (!target.isCurrent()) return;
    // Do NOT clear pendingCompactionResets here: a late pre-compaction usage
    // event delivered after this provider reading could resurrect the old meter.
    // The guard is cleared at the stream-settlement boundary (beginTurn) instead.
    this.snapshots.set(key, snapshot);
    this.dependencies.emit({
      type: 'context.updated',
      appSessionId: target.appSessionId,
      sourceSessionId: target.sourceSessionId,
      ...(isChildTarget(target)
        ? {
            parentAppSessionId: target.parentAppSessionId,
            childSessionId: target.childSessionId,
          }
        : {}),
      stats: snapshot,
    });

    if (isChildTarget(target)) return;
    const contextPatch = {
      contextTokens: snapshot.used,
      contextRemainingTokens: snapshot.remaining,
      maxContextTokens:
        this.dependencies.maxContextTokensForSummary(liveSession.summary) ?? snapshot.limit,
      contextAccuracy: snapshot.accuracy,
      contextUpdatedAt: snapshot.updatedAt,
    };
    if (options.persist === false)
      liveSession.summary = { ...liveSession.summary, ...contextPatch };
    else this.dependencies.registry.updateSummary(target.appSessionId, contextPatch);
  }

  private emitEstimate(sourceSessionId: string, summary: SessionSummary): void {
    if (summary.contextTokens <= 0) return;
    const resourceKey = primaryResourceKey(sourceSessionId);
    const previous = this.snapshots.get(resourceKey);
    const limit =
      this.dependencies.maxContextTokensForSummary(summary) ??
      summary.maxContextTokens ??
      previous?.limit;
    if (!limit || limit <= 0) return;
    const used = Math.min(summary.contextTokens, limit);
    const breakdown = previous?.breakdown
      ? {
          ...previous.breakdown,
          contextBudget: limit,
          usedTokens: used,
          freeTokens: Math.max(0, limit - used),
        }
      : undefined;
    const snapshot: ContextStatsSnapshot = {
      used,
      remaining: Math.max(0, limit - used),
      limit,
      accuracy: summary.contextAccuracy ?? previous?.accuracy ?? 'estimated',
      updatedAt: new Date().toISOString(),
      breakdown,
    };
    this.snapshots.set(resourceKey, snapshot);
    this.dependencies.emit({
      type: 'context.updated',
      appSessionId: summary.appSessionId,
      sourceSessionId,
      stats: snapshot,
    });
  }

  private captureProviderUsageBaseline(key: string, generation: number): void {
    const used = this.latestProviderUsage.get(key);
    if (used !== undefined) this.providerUsageBaselines.set(key, { generation, used });
  }

  private rememberCompaction(key: string, compactionId: string | undefined, generation: number) {
    if (compactionId === undefined) return;
    let entries = this.recordedCompactions.get(key);
    if (!entries) {
      entries = new Map();
      this.recordedCompactions.set(key, entries);
    }
    entries.set(compactionId, generation);
  }

  private forgetRecordedCompactions(resourceKey: string): void {
    const prefix = `${resourceKey}:provider:`;
    for (const key of this.recordedCompactions.keys()) {
      if (key.startsWith(prefix)) this.recordedCompactions.delete(key);
    }
  }

  private normalizeProviderWindowSnapshot(
    key: string,
    snapshot: ContextStatsSnapshot,
    generation: number,
  ): ContextStatsSnapshot {
    this.latestProviderUsage.set(key, snapshot.used);
    let baseline = this.providerUsageBaselines.get(key);
    if (baseline?.generation === generation) {
      if (snapshot.used >= baseline.used) return rebasedContextSnapshot(snapshot, baseline.used);
      this.providerUsageBaselines.delete(key);
      baseline = undefined;
    }

    if (snapshot.used <= snapshot.limit) {
      this.providerUsageBaselines.delete(key);
      return snapshot;
    }

    if (generation <= 0) return cappedContextSnapshot(snapshot);

    if (baseline?.generation !== generation) {
      baseline = { generation, used: snapshot.used };
      this.providerUsageBaselines.set(key, baseline);
    }
    return rebasedContextSnapshot(snapshot, baseline.used);
  }
}

function isChildTarget(target: ContextOperationTarget): target is ChildOperationTarget {
  return 'childSessionId' in target;
}

function childIdentityKey(identity: ChildIdentity): string {
  return `child:${String(identity.parentAppSessionId.length)}:${identity.parentAppSessionId}${identity.childSessionId}`;
}

function primaryResourceKey(sourceSessionId: string): string {
  return `primary:${sourceSessionId}`;
}

function contextResourceKey(target: ContextOperationTarget): string {
  return isChildTarget(target)
    ? childIdentityKey(target)
    : primaryResourceKey(target.sourceSessionId);
}

function compactionRetryKey(target: ContextOperationTarget): string {
  const providerSessionId = target.providerSessionId;
  return `${contextResourceKey(target)}:provider:${String(providerSessionId.length)}:${providerSessionId}`;
}
