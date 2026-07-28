import { applyCachedSummary, type HistoricalSession, type HistoryIndex } from './history.js';
import type { BridgeFeature, SessionSummary } from './protocol.js';
import { filterSessionListSummaries, type SessionListFilterOptions } from './sessionListFilter.js';
import { uniqueStrings } from './sessionHelpers.js';

export interface RegisteredSession {
  summary: SessionSummary;
}

type IdentityField =
  | 'appSessionId'
  | 'providerSessionId'
  | 'compactedFromProviderSessionIds'
  | 'missionId'
  | 'parentProviderSessionId';

export type SessionSummaryPatch = Omit<Partial<SessionSummary>, IdentityField>;

type RegistryHistory = Pick<
  HistoryIndex,
  'syncSummaries' | 'summaryPatches' | 'hiddenProviderSessionIds'
>;

type SummaryLoader = (options?: SessionListFilterOptions) => HistoricalSession[];

export interface SessionRegistryDependencies {
  history: RegistryHistory;
  loadOrdinarySessions: SummaryLoader;
  loadMissionControlSessions: SummaryLoader;
  projectSummary: (summary: Readonly<SessionSummary>) => SessionSummary;
  onSummaryUpdated: (summary: SessionSummary) => void;
  now: () => number;
}

export class SessionRegistry<TLive extends RegisteredSession> {
  private readonly sessions = new Map<string, TLive>();
  private readonly providerAliases = new Map<string, string>();

  constructor(private readonly dependencies: SessionRegistryDependencies) {}

  register(liveSession: TLive): void {
    const previous = this.sessions.get(liveSession.summary.appSessionId);
    if (previous) this.removeAliases(previous.summary);

    this.sessions.set(liveSession.summary.appSessionId, liveSession);
    this.indexAliases(liveSession.summary);
    this.persist(liveSession.summary);
  }

  getLive(id: string): TLive | undefined {
    const direct = this.sessions.get(id);
    if (direct) return direct;

    const appSessionId = this.providerAliases.get(id);
    return appSessionId ? this.sessions.get(appSessionId) : undefined;
  }

  getCanonicalSummary(id: string): SessionSummary | undefined {
    const summary = this.resolveCanonicalSummary(id);
    return summary ? copySummary(summary) : undefined;
  }

  resolveSummary(id: string): SessionSummary | undefined {
    const summary = this.resolveCanonicalSummary(id);
    return summary ? this.project(summary) : undefined;
  }

  listSummaries(options?: SessionListFilterOptions): SessionSummary[] {
    const projected = [...this.mergeCanonicalSummaries(options).values()]
      .map((summary) => this.project(summary))
      .sort((left, right) => right.updatedAt - left.updatedAt);

    return filterSessionListSummaries(projected, options);
  }

  updateSummary(id: string, patch: SessionSummaryPatch): SessionSummary | undefined {
    const liveSession = this.getLive(id);
    if (!liveSession) return undefined;

    const updated = this.withPatch(liveSession.summary, patch);
    liveSession.summary = updated;
    this.persistAndPublish(updated);
    return updated;
  }

  replaceProvider(
    id: string,
    providerSessionId: string,
    patch: SessionSummaryPatch = {},
  ): SessionSummary | undefined {
    const current = this.resolveCanonicalSummary(id);
    if (!current) return undefined;
    if (current.providerSessionId === providerSessionId) return current;
    const liveSession = this.sessions.get(current.appSessionId);

    const updated = {
      ...this.withPatch(current, patch),
      providerSessionId,
      compactedFromProviderSessionIds: uniqueStrings([
        ...(current.compactedFromProviderSessionIds ?? []),
        current.providerSessionId,
      ]),
    };

    if (liveSession) {
      this.removeAliases(current);
      liveSession.summary = updated;
      this.indexAliases(updated);
    }

    this.persistAndPublish(updated);
    return updated;
  }

  unregister(id: string): TLive | undefined {
    const liveSession = this.getLive(id);
    if (!liveSession) return undefined;

    this.sessions.delete(liveSession.summary.appSessionId);
    this.removeAliases(liveSession.summary);
    return liveSession;
  }

  liveSessionsSnapshot(): readonly TLive[] {
    return [...this.sessions.values()];
  }

  private resolveCanonicalSummary(id: string): SessionSummary | undefined {
    const summaries = this.mergeCanonicalSummaries();
    const direct = summaries.get(id);
    if (direct) return direct;

    return [...summaries.values()].find(
      (summary) =>
        summary.providerSessionId === id ||
        Boolean(summary.compactedFromProviderSessionIds?.includes(id)),
    );
  }

  private mergeCanonicalSummaries(options?: SessionListFilterOptions): Map<string, SessionSummary> {
    const summaries = new Map<string, SessionSummary>();
    const patches = this.dependencies.history.summaryPatches();
    const hiddenProviderSessionIds = this.dependencies.history.hiddenProviderSessionIds();
    const loaderOptions = options ? { ...options } : undefined;
    if (loaderOptions) delete loaderOptions.limitPerWorkspace;

    this.mergeHistoricalSummaries(
      summaries,
      this.dependencies.loadOrdinarySessions(loaderOptions),
      patches,
      hiddenProviderSessionIds,
    );
    this.mergeHistoricalSummaries(
      summaries,
      this.dependencies.loadMissionControlSessions(loaderOptions),
      patches,
      hiddenProviderSessionIds,
    );
    for (const liveSession of this.sessions.values()) {
      summaries.set(liveSession.summary.appSessionId, liveSession.summary);
    }

    return summaries;
  }

  private mergeHistoricalSummaries(
    target: Map<string, SessionSummary>,
    sessions: HistoricalSession[],
    patches: Map<string, Partial<SessionSummary>>,
    hiddenProviderSessionIds: Set<string>,
  ): void {
    for (const historical of sessions) {
      const rawProviderSessionId =
        historical.summary.providerSessionId ?? historical.summary.appSessionId;
      if (hiddenProviderSessionIds.has(rawProviderSessionId)) continue;

      const summary = applyCachedSummary(historical.summary, patches);
      target.set(summary.appSessionId, summary);
    }
  }

  private withPatch(summary: SessionSummary, patch: SessionSummaryPatch): SessionSummary {
    return {
      ...summary,
      ...withoutIdentityFields(patch),
      updatedAt: this.dependencies.now(),
    };
  }

  private project(summary: SessionSummary): SessionSummary {
    const canonical = copySummary(summary);
    const projected = this.dependencies.projectSummary(canonical);
    return copySummary({ ...canonical, ...withoutIdentityFields(projected) });
  }

  private persist(summary: SessionSummary): void {
    this.dependencies.history.syncSummaries([summary]);
  }

  private persistAndPublish(summary: SessionSummary): void {
    this.persist(summary);
    this.dependencies.onSummaryUpdated(this.project(summary));
  }

  private indexAliases(summary: SessionSummary): void {
    for (const providerSessionId of providerIds(summary)) {
      this.providerAliases.set(providerSessionId, summary.appSessionId);
    }
  }

  private removeAliases(summary: SessionSummary): void {
    for (const providerSessionId of providerIds(summary)) {
      if (this.providerAliases.get(providerSessionId) === summary.appSessionId) {
        this.providerAliases.delete(providerSessionId);
      }
    }
  }
}

function providerIds(summary: SessionSummary): string[] {
  return uniqueStrings([
    summary.providerSessionId,
    ...(summary.compactedFromProviderSessionIds ?? []),
  ]);
}

function withoutIdentityFields(patch: Partial<SessionSummary>): SessionSummaryPatch {
  const safePatch = { ...patch };
  delete safePatch.appSessionId;
  delete safePatch.providerSessionId;
  delete safePatch.compactedFromProviderSessionIds;
  delete safePatch.missionId;
  delete safePatch.parentProviderSessionId;
  return safePatch;
}

function copySummary(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    ...(summary.compactedFromProviderSessionIds
      ? { compactedFromProviderSessionIds: [...summary.compactedFromProviderSessionIds] }
      : {}),
    features: summary.features.map(copyFeature),
  };
}

function copyFeature(feature: BridgeFeature): BridgeFeature {
  return {
    ...feature,
    preconditions: [...feature.preconditions],
    expectedBehavior: [...feature.expectedBehavior],
    verificationSteps: [...feature.verificationSteps],
    ...(feature.fulfills ? { fulfills: [...feature.fulfills] } : {}),
    ...(feature.workerProviderSessionIds
      ? { workerProviderSessionIds: [...feature.workerProviderSessionIds] }
      : {}),
  };
}
