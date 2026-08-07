import { applyCachedSummary, type HistoricalSession, type HistoryIndex } from './history.js';
import { isAbsolute, relative, resolve } from 'node:path';
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
  | 'missionId';

export type SessionSummaryPatch = Omit<Partial<SessionSummary>, IdentityField>;

type RegistryHistory = Pick<HistoryIndex, 'syncSummaries' | 'summaryPatchesAndHidden'>;

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
    // Runtime boundary guard: live session data can carry a child role even
    // though the type forbids it, so the narrow type alone is not sufficient.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Runtime validation despite the narrow declared type.
    if (liveSession.summary.role !== 'primary' && liveSession.summary.role !== 'user') {
      throw new Error('SessionRegistry accepts top-level sessions only.');
    }
    this.persist(liveSession.summary);

    const previous = this.sessions.get(liveSession.summary.appSessionId);
    if (previous) this.removeAliases(previous.summary);

    this.sessions.set(liveSession.summary.appSessionId, liveSession);
    this.indexAliases(liveSession.summary);
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

  updateSummary(
    id: string,
    patch: SessionSummaryPatch,
    options: { touchActivity?: boolean } = {},
  ): SessionSummary | undefined {
    const liveSession = this.getLive(id);
    if (!liveSession) return undefined;

    const updated = this.withPatch(liveSession.summary, patch, options.touchActivity !== false);
    this.persist(updated);
    liveSession.summary = updated;
    this.publish(updated);
    return updated;
  }

  reanchorHistoricalCwd(fromCwd: string, toCwd: string): SessionSummary[] {
    if (!isAbsolute(fromCwd) || !isAbsolute(toCwd)) {
      throw new Error('Session cwd re-anchoring requires absolute paths.');
    }

    const from = resolve(fromCwd);
    const summaries = [...this.mergeCanonicalSummaries().values()];
    if (
      summaries.some(
        (summary) => this.sessions.has(summary.appSessionId) && isInside(from, summary.cwd),
      )
    ) {
      throw new Error('A live session is still using this worktree.');
    }
    const affected = summaries.filter((summary) => isInside(from, summary.cwd));
    const updated = affected.map((summary) =>
      this.withPatch(
        summary,
        {
          cwd: resolve(toCwd, relative(from, resolve(summary.cwd))),
          workspaceKind: 'folder',
        },
        false,
      ),
    );
    if (updated.length === 0) return [];

    this.dependencies.history.syncSummaries(updated);
    for (const summary of updated) this.publish(summary);
    return updated.map(copySummary);
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

    // A provider swap is compaction bookkeeping, not user-visible activity:
    // updatedAt (sidebar order, unread marker) stays where the turn left it.
    const updated = {
      ...this.withPatch(current, patch, false),
      providerSessionId,
      compactedFromProviderSessionIds: uniqueStrings([
        ...(current.compactedFromProviderSessionIds ?? []),
        current.providerSessionId,
      ]),
    };

    this.persist(updated);
    if (liveSession) {
      this.removeAliases(current);
      liveSession.summary = updated;
      this.indexAliases(updated);
    }

    this.publish(updated);
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
    const { patches, hiddenProviderSessionIds } =
      this.dependencies.history.summaryPatchesAndHidden();
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
      const summary = applyCachedSummary(historical.summary, patches);
      const providerSessionId = summary.providerSessionId ?? summary.appSessionId;
      if (hiddenProviderSessionIds.has(providerSessionId)) continue;

      target.set(summary.appSessionId, summary);
    }
  }

  private withPatch(
    summary: SessionSummary,
    patch: SessionSummaryPatch,
    touchActivity = true,
  ): SessionSummary {
    // updatedAt drives sidebar ordering and the renderer's unread marker, so it
    // must only move for user-visible activity. Passive telemetry patches
    // (token usage, context stats, compaction counters) keep the timestamp.
    return copySummary({
      ...summary,
      ...withoutIdentityFields(patch),
      updatedAt: touchActivity ? this.dependencies.now() : summary.updatedAt,
    });
  }

  private project(summary: SessionSummary): SessionSummary {
    const canonical = copySummary(summary);
    const projected = this.dependencies.projectSummary(canonical);
    return copySummary({ ...canonical, ...withoutIdentityFields(projected) });
  }

  private persist(summary: SessionSummary): void {
    this.dependencies.history.syncSummaries([summary]);
  }

  private publish(summary: SessionSummary): void {
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
  };
}

function isInside(parent: string, candidate: string): boolean {
  if (!candidate || !isAbsolute(candidate)) return false;
  const path = relative(parent, resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}
