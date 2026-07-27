import type * as Protocol from '../protocol.js';
import type { RecordedCall } from './sessionCharacterizationHarness.js';

type PersistedSummaryPatch = Pick<
  Protocol.MissionSummary,
  | 'id'
  | 'sessionId'
  | 'compactedFromSessionIds'
  | 'kind'
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

export class FakeHistoryIndex {
  private readonly summariesByAppId = new Map<string, PersistedSummaryPatch>();
  private readonly links = new Map<string, Protocol.WorkerHistoryLink[]>();

  constructor(private readonly calls: RecordedCall[]) {}

  syncSummaries(summaries: Protocol.MissionSummary[]): void {
    this.seedSummaries(summaries);
    this.calls.push({ target: 'history', method: 'syncSummaries', args: [summaries] });
  }

  seedSummaries(summaries: Protocol.MissionSummary[]): void {
    for (const summary of summaries) {
      const patch = materializePersistedSummaryPatch(summary);
      this.summariesByAppId.set(patch.id, patch);
    }
  }

  seedSubagentLinks(missionId: string, links: Protocol.WorkerHistoryLink[]): void {
    this.links.set(missionId, links);
  }

  summaryPatches(): Map<string, Partial<Protocol.MissionSummary>> {
    const patches = new Map<string, Partial<Protocol.MissionSummary>>();
    for (const patch of this.summariesByAppId.values()) {
      patches.set(patch.id, patch);
      patches.set(patch.sessionId ?? patch.id, patch);
    }
    return patches;
  }

  hiddenDroidSessionIds(): Set<string> {
    return new Set();
  }

  recordSubagentLink(
    ...[missionId, toolUseId, workerSessionId, label]: [string, string, string, string?]
  ): void {
    const links = this.links.get(missionId) ?? [];
    const index = links.findIndex((existing) => existing.toolUseId === toolUseId);
    links[index < 0 ? links.length : index] =
      label === undefined ? { workerSessionId, toolUseId } : { workerSessionId, toolUseId, label };
    this.links.set(missionId, links);
    this.calls.push({
      target: 'history',
      method: 'recordSubagentLink',
      args: [missionId, toolUseId, workerSessionId, label],
    });
  }

  subagentLinks(missionId: string): Protocol.WorkerHistoryLink[] {
    return (this.links.get(missionId) ?? []).map((link) => ({ ...link }));
  }

  recordEvent(event: unknown): void {
    this.calls.push({ target: 'history', method: 'recordEvent', args: [event] });
  }

  close(): void {
    this.calls.push({ target: 'cleanup', method: 'history.close', args: [] });
  }
}

function materializePersistedSummaryPatch(summary: Protocol.MissionSummary): PersistedSummaryPatch {
  return {
    id: summary.id,
    sessionId: summary.sessionId ?? summary.id,
    compactedFromSessionIds: [...(summary.compactedFromSessionIds ?? [])],
    kind: summary.kind,
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
