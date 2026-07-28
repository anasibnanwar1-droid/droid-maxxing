import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type * as Protocol from '../protocol.js';
import type { SessionManagerDependencies } from '../SessionManager.js';
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
  private readonly summariesByAppId = new Map<string, PersistedSummaryPatch>();
  private readonly links = new Map<string, Protocol.ChildSessionHistoryLink[]>();

  constructor(private readonly calls: RecordedCall[]) {}

  syncSummaries(summaries: Protocol.SessionSummary[]): void {
    this.seedSummaries(summaries);
    this.calls.push({ target: 'history', method: 'syncSummaries', args: [summaries] });
  }

  seedSummaries(summaries: Protocol.SessionSummary[]): void {
    for (const summary of summaries) {
      const patch = materializePersistedSummaryPatch(summary);
      this.summariesByAppId.set(patch.appSessionId, patch);
    }
  }

  seedChildSessionLinks(appSessionId: string, links: Protocol.ChildSessionHistoryLink[]): void {
    this.links.set(appSessionId, links);
  }

  summaryPatches(): Map<string, Partial<Protocol.SessionSummary>> {
    const patches = new Map<string, Partial<Protocol.SessionSummary>>();
    for (const patch of this.summariesByAppId.values()) {
      patches.set(patch.appSessionId, patch);
      patches.set(patch.providerSessionId ?? patch.appSessionId, patch);
    }
    return patches;
  }

  hiddenProviderSessionIds(): Set<string> {
    const hidden = new Set<string>();
    for (const patch of this.summariesByAppId.values()) {
      for (const providerSessionId of patch.compactedFromProviderSessionIds ?? []) {
        if (providerSessionId && providerSessionId !== patch.appSessionId)
          hidden.add(providerSessionId);
      }
    }
    return hidden;
  }

  recordChildSessionLink(
    ...[appSessionId, toolUseId, providerSessionId, label]: [string, string, string, string?]
  ): void {
    const links = this.links.get(appSessionId) ?? [];
    const index = links.findIndex((existing) => existing.toolUseId === toolUseId);
    links[index < 0 ? links.length : index] =
      label === undefined
        ? { providerSessionId, toolUseId }
        : { providerSessionId, toolUseId, label };
    this.links.set(appSessionId, links);
    this.calls.push({
      target: 'history',
      method: 'recordChildSessionLink',
      args: [appSessionId, toolUseId, providerSessionId, label],
    });
  }

  childSessionLinks(appSessionId: string): Protocol.ChildSessionHistoryLink[] {
    return (this.links.get(appSessionId) ?? []).map((link) => ({ ...link }));
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
