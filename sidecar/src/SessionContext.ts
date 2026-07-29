import type { ContextBreakdownResult, GetContextStatsResult } from '@factory/droid-sdk';

import type { FactoryRuntime, FactorySession } from './DroidRuntime.js';
import type {
  ContextBreakdownSnapshot,
  ContextStatsSnapshot,
  ServerEvent,
  SessionSummary,
} from './protocol.js';
import type { SessionRegistry } from './SessionRegistry.js';
import type { LiveSession } from './SessionLifecycle.js';
import { numberValue, stringValue } from './values.js';

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
  contextTokens: number;
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
}

interface ContextPoller {
  timer: ReturnType<typeof setInterval>;
  session: FactorySession;
}

export class SessionContext {
  private readonly usageOffsets = new Map<string, UsageOffset>();
  private readonly snapshots = new Map<string, ContextStatsSnapshot>();
  private readonly childCompactions = new Map<string, number>();
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
    // the context meter. Child meters are published from their own refreshes.
    if (sourceSessionId === stableAppSessionId) {
      nextSummary.contextTokens = usage.contextTokens;
      if (usage.contextTokens > 0) {
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
        ...(sourceSessionId === stableAppSessionId
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
      );
    } catch {
      // Context is informational and must never disrupt an active turn.
    }
  }

  recordCompaction(target: ContextOperationTarget): void {
    if (isChildTarget(target)) {
      // Completion settlement may synchronously detach a standalone child before
      // accounting runs. Preserve that established generation residue; the
      // captured target still keeps refreshes inert, while top-level teardown
      // clears all owned generations after blocking new notifications.
      const key = childIdentityKey(target);
      this.childCompactions.set(key, (this.childCompactions.get(key) ?? 0) + 1);
      return;
    }

    if (!target.isCurrent()) return;
    const liveSession = this.dependencies.registry.getLive(target.appSessionId);
    if (liveSession?.session !== target.session || !target.isCurrent()) return;
    this.dependencies.registry.updateSummary(target.appSessionId, {
      contextTokens: 0,
      contextAccuracy: undefined,
      autoCompactions: (liveSession.summary.autoCompactions ?? 0) + 1,
    });
  }

  preserveUsage(appSessionId: string, offset: UsageOffset): void {
    this.usageOffsets.set(appSessionId, offset);
  }

  forgetChild(identity: ChildIdentity): void {
    const key = childIdentityKey(identity);
    this.snapshots.delete(key);
    this.childCompactions.delete(key);
  }

  stopSession(liveSession: LiveSession): void {
    this.stopPollingKey(liveSession.summary.appSessionId);
  }

  forgetSession(liveSession: LiveSession): void {
    const appSessionId = liveSession.summary.appSessionId;
    this.usageOffsets.delete(appSessionId);
    this.snapshots.delete(appSessionId);
  }

  clearAll(): void {
    this.epoch += 1;
    for (const poller of this.pollers.values()) clearInterval(poller.timer);
    this.pollers.clear();
    this.snapshots.clear();
    this.childCompactions.clear();
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
  ): void {
    if (!target.isCurrent()) return;
    const liveSession = this.dependencies.registry.getLive(target.appSessionId);
    if (!liveSession) return;

    const snapshot = isChildTarget(target)
      ? {
          ...providerSnapshot,
          compactions: this.childCompactions.get(childIdentityKey(target)) ?? 0,
        }
      : applyExactUsage(providerSnapshot, liveSession.summary);

    if (!target.isCurrent()) return;
    this.snapshots.set(contextResourceKey(target), snapshot);
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
    const previous = this.snapshots.get(sourceSessionId);
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
    this.snapshots.set(sourceSessionId, snapshot);
    this.dependencies.emit({
      type: 'context.updated',
      appSessionId: summary.appSessionId,
      sourceSessionId,
      stats: snapshot,
    });
  }
}

function isChildTarget(target: ContextOperationTarget): target is ChildOperationTarget {
  return 'childSessionId' in target;
}

function childIdentityKey(identity: ChildIdentity): string {
  return `${String(identity.parentAppSessionId.length)}:${identity.parentAppSessionId}${identity.childSessionId}`;
}

function contextResourceKey(target: ContextOperationTarget): string {
  return isChildTarget(target) ? childIdentityKey(target) : target.sourceSessionId;
}

function applyExactUsage(
  snapshot: ContextStatsSnapshot,
  summary: SessionSummary,
): ContextStatsSnapshot {
  const exact =
    summary.contextAccuracy === 'exact' && summary.contextTokens > 0
      ? summary.contextTokens
      : undefined;
  if (exact === undefined || snapshot.limit <= 0) return snapshot;
  const used = Math.min(exact, snapshot.limit);
  return {
    ...snapshot,
    used,
    remaining: Math.max(0, snapshot.limit - used),
    accuracy: 'exact',
    breakdown: snapshot.breakdown
      ? {
          ...snapshot.breakdown,
          usedTokens: used,
          freeTokens: Math.max(0, snapshot.limit - used),
        }
      : undefined,
  };
}

function contextStatsSnapshot(
  stats: GetContextStatsResult,
  breakdown: ContextBreakdownSnapshot | undefined,
): ContextStatsSnapshot {
  return {
    used: stats.used,
    remaining: stats.remaining,
    limit: stats.limit,
    accuracy: stats.accuracy,
    updatedAt: stats.updatedAt,
    breakdown,
  };
}

function contextBreakdownSnapshot(raw: unknown): ContextBreakdownSnapshot | undefined {
  const value = raw as Partial<ContextBreakdownResult> | undefined;
  if (!value) return undefined;
  const categories = Array.isArray(value.categories)
    ? value.categories
        .map((item) => ({
          name: stringValue(item.name) ?? 'Context',
          tokens: numberValue(item.tokens) ?? 0,
          colorKey: stringValue(item.colorKey),
        }))
        .filter((item) => item.tokens > 0)
    : [];
  const usedTokens =
    numberValue(value.usedTokens) ?? categories.reduce((sum, item) => sum + item.tokens, 0);
  const contextBudget =
    numberValue(value.contextBudget) ?? usedTokens + (numberValue(value.freeTokens) ?? 0);
  if (contextBudget <= 0 && usedTokens <= 0 && categories.length === 0) return undefined;
  return {
    modelId: stringValue(value.modelId),
    modelDisplayName: stringValue(value.modelDisplayName),
    contextBudget,
    usedTokens,
    freeTokens: numberValue(value.freeTokens) ?? Math.max(0, contextBudget - usedTokens),
    categories,
  };
}
