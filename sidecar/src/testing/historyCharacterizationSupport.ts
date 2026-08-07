import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type * as Protocol from '../protocol.js';
import type { SessionManagerDependencies } from '../SessionManager.js';
import {
  applyCachedSummary,
  loadHistoricalSessions,
  type HistoricalSession,
  type HistoricalSummaryFilter,
  type PersistedChildSession,
} from '../history.js';
import { filterSessionListSummaries } from '../sessionListFilter.js';
import type { RecordedCall } from './fakeFactoryRuntime.js';

type SessionHistoryDependencies = SessionManagerDependencies['history'];

type PersistedSummaryPatch = Pick<
  Protocol.SessionSummary,
  | 'appSessionId'
  | 'providerSessionId'
  | 'compactedFromProviderSessionIds'
  | 'sessionPurpose'
  | 'interactionMode'
  | 'title'
  | 'cwd'
  | 'workspaceKind'
  | 'modelId'
  | 'reasoningEffort'
  | 'compactionModel'
  | 'workerModelId'
  | 'workerReasoningEffort'
  | 'validatorModelId'
  | 'validatorReasoningEffort'
  | 'autonomy'
  | 'tokensIn'
  | 'tokensOut'
  | 'contextTokens'
  | 'contextRemainingTokens'
  | 'contextAccuracy'
  | 'contextUpdatedAt'
  | 'maxContextTokens'
  | 'autoCompactions'
  | 'updatedAt'
>;

export class FakeHistoryIndex implements SessionHistoryDependencies {
  nextCloseError?: Error;
  nextSyncError?: Error;
  private readonly summariesByAppId = new Map<string, PersistedSummaryPatch>();
  private readonly childrenByParent = new Map<string, Map<string, PersistedChildSession>>();

  constructor(private readonly calls: RecordedCall[]) {}

  syncSummaries(summaries: Protocol.SessionSummary[]): void {
    const error = this.nextSyncError;
    delete this.nextSyncError;
    if (error) throw error;
    this.seedSummaries(summaries);
    this.calls.push({ target: 'history', method: 'syncSummaries', args: [summaries] });
  }

  seedSummaries(summaries: Protocol.SessionSummary[]): void {
    for (const summary of summaries) {
      const patch = materializePersistedSummaryPatch(summary);
      this.summariesByAppId.set(patch.appSessionId, patch);
    }
  }

  seedChildSessions(children: PersistedChildSession[]): void {
    for (const child of children) this.upsertChildSession(child);
  }

  summaryPatchesAndHidden(): {
    patches: Map<string, Partial<Protocol.SessionSummary>>;
    hiddenProviderSessionIds: Set<string>;
  } {
    const patches = new Map<string, Partial<Protocol.SessionSummary>>();
    const hiddenProviderSessionIds = new Set<string>();
    for (const patch of this.summariesByAppId.values()) {
      patches.set(patch.appSessionId, patch);
      patches.set(patch.providerSessionId ?? patch.appSessionId, patch);
      for (const providerSessionId of patch.compactedFromProviderSessionIds ?? []) {
        if (providerSessionId && providerSessionId !== patch.appSessionId)
          hiddenProviderSessionIds.add(providerSessionId);
      }
    }
    return { patches, hiddenProviderSessionIds };
  }

  // SessionManager tests pin a temp HOME and write provider session files into
  // it, so the fake delegates to the real disk scan for the on-disk rows. But
  // unlike production, the fake persists app-session patches only in memory
  // (summariesByAppId), never to the sqlite the real scan reads. Filtering
  // inside loadHistoricalSessions would therefore use the on-disk cwd, not the
  // patched cwd a test seeded, so a session moved between workspaces by a
  // patch could be filtered out before the patch is applied. To stay faithful
  // to production (which applies its patches before filtering), the fake loads
  // every row, overlays its own patches, then filters.
  listHistoricalSessions(options: HistoricalSummaryFilter = {}): HistoricalSession[] {
    const rows = loadHistoricalSessions();
    if (!options.workspaceCwds && options.includePlainChats === undefined) return rows;
    const { patches } = this.summaryPatchesAndHidden();
    const summaries = rows.map((row) => applyCachedSummary(row.summary, patches));
    return filterSessionListSummaries(summaries, options).map((summary) => ({
      summary,
      progress: [],
    }));
  }

  // The fake has no sqlite cache: it reports an empty cache so boot takes the
  // synchronous populate path, and reconciles are counted no-ops because the
  // fake's listHistoricalSessions already scans the disk on every call.
  // Counters stay out of the recorded-call log so strict call-sequence
  // assertions are unaffected by the boot reconcile. Tests can set a nonzero
  // sessionFileCacheSize to exercise the warm-cache background boot reconcile.
  fullReconcileCalls = 0;
  readonly targetedReconcileCalls: { providerSessionId: string; path: string }[][] = [];
  sessionFileCacheSize = 0;
  // When set, the next full reconcile throws it once, so tests can exercise
  // the boot gate's resilience to a failed reconcile.
  failNextReconcile: Error | null = null;

  reconcileSessionFiles(): number {
    this.fullReconcileCalls += 1;
    const failure = this.failNextReconcile;
    this.failNextReconcile = null;
    if (failure) throw failure;
    return 0;
  }

  reconcileSessionFilePaths(changes: { providerSessionId: string; path: string }[]): number {
    this.targetedReconcileCalls.push(changes);
    return 0;
  }

  upsertChildSession(child: PersistedChildSession): void {
    const children =
      this.childrenByParent.get(child.parentAppSessionId) ??
      new Map<string, PersistedChildSession>();
    children.set(child.childSessionId, structuredClone(child));
    this.childrenByParent.set(child.parentAppSessionId, children);
    this.calls.push({
      target: 'history',
      method: 'upsertChildSession',
      args: [child],
    });
  }

  childSessions(parentAppSessionId: string): PersistedChildSession[] {
    return [...(this.childrenByParent.get(parentAppSessionId)?.values() ?? [])].map((child) =>
      structuredClone(child),
    );
  }

  childSession(
    parentAppSessionId: string,
    childSessionId: string,
  ): PersistedChildSession | undefined {
    const child = this.childrenByParent.get(parentAppSessionId)?.get(childSessionId);
    return child ? structuredClone(child) : undefined;
  }

  recordEvent(event: unknown): void {
    this.calls.push({ target: 'history', method: 'recordEvent', args: [event] });
  }

  close(): void {
    this.calls.push({ target: 'cleanup', method: 'history.close', args: [] });
    const error = this.nextCloseError;
    delete this.nextCloseError;
    if (error) throw error;
  }
}

export function writeProviderSessionStart(
  home: string,
  sessionId: string,
  sessionTitle: string,
): void {
  const file = path.join(home, '.factory', 'sessions', `${sessionId}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'session_start', sessionId, sessionTitle, cwd: '' })}\n`,
  );
}

function materializePersistedSummaryPatch(summary: Protocol.SessionSummary): PersistedSummaryPatch {
  return {
    appSessionId: summary.appSessionId,
    providerSessionId: summary.providerSessionId ?? summary.appSessionId,
    compactedFromProviderSessionIds: [...(summary.compactedFromProviderSessionIds ?? [])],
    sessionPurpose: summary.sessionPurpose,
    interactionMode: summary.interactionMode,
    title: summary.title,
    cwd: summary.cwd,
    ...whenDefined(summary.workspaceKind, (workspaceKind) => ({ workspaceKind })),
    ...whenDefined(summary.modelId, (modelId) => ({ modelId })),
    ...whenDefined(summary.reasoningEffort, (reasoningEffort) => ({ reasoningEffort })),
    ...whenDefined(summary.compactionModel, (compactionModel) => ({ compactionModel })),
    ...whenDefined(summary.workerModelId, (workerModelId) => ({ workerModelId })),
    ...whenDefined(summary.workerReasoningEffort, (workerReasoningEffort) => ({
      workerReasoningEffort,
    })),
    ...whenDefined(summary.validatorModelId, (validatorModelId) => ({ validatorModelId })),
    ...whenDefined(summary.validatorReasoningEffort, (validatorReasoningEffort) => ({
      validatorReasoningEffort,
    })),
    autonomy: summary.autonomy,
    tokensIn: summary.tokensIn,
    tokensOut: summary.tokensOut,
    contextTokens: summary.contextTokens,
    ...whenDefined(summary.contextRemainingTokens, (contextRemainingTokens) => ({
      contextRemainingTokens,
    })),
    ...whenDefined(summary.contextAccuracy, (contextAccuracy) => ({ contextAccuracy })),
    ...whenDefined(summary.contextUpdatedAt, (contextUpdatedAt) => ({ contextUpdatedAt })),
    ...whenDefined(summary.maxContextTokens, (maxContextTokens) => ({ maxContextTokens })),
    ...whenDefined(summary.autoCompactions, (autoCompactions) => ({ autoCompactions })),
    updatedAt: summary.updatedAt,
  };
}

function whenDefined<T>(value: T | undefined, property: (value: T) => object): object {
  return value === undefined ? {} : property(value);
}
