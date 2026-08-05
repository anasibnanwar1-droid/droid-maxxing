import type { ContextBreakdownResult, GetContextStatsResult } from '@factory/droid-sdk';

import type { ContextBreakdownSnapshot, ContextStatsSnapshot, SessionSummary } from './protocol.js';
import { numberValue, stringValue } from './values.js';

export function applyExactUsage(
  snapshot: ContextStatsSnapshot,
  summary: SessionSummary,
): ContextStatsSnapshot {
  const exact =
    summary.contextAccuracy === 'exact' &&
    summary.contextTokens > 0 &&
    summary.contextTokens <= snapshot.limit
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

export function cappedContextSnapshot(snapshot: ContextStatsSnapshot): ContextStatsSnapshot {
  const used = Math.max(0, snapshot.limit);
  return {
    ...snapshot,
    used,
    remaining: 0,
    accuracy: 'estimated',
    breakdown: undefined,
  };
}

export function rebasedContextSnapshot(
  snapshot: ContextStatsSnapshot,
  baselineUsed: number,
): ContextStatsSnapshot {
  const used = Math.max(0, Math.min(snapshot.limit, snapshot.used - baselineUsed));
  return {
    ...snapshot,
    used,
    remaining: Math.max(0, snapshot.limit - used),
    accuracy: 'estimated',
    breakdown: undefined,
  };
}

export function contextStatsSnapshot(
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

export function contextBreakdownSnapshot(raw: unknown): ContextBreakdownSnapshot | undefined {
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
