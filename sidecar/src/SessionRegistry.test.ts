import assert from 'node:assert/strict';
import test from 'node:test';

import type { HistoricalSession } from './history.js';
import type { SessionSummary } from './protocol.js';
import {
  SessionRegistry,
  type RegisteredSession,
  type SessionRegistryDependencies,
} from './SessionRegistry.js';

interface TestLiveSession extends RegisteredSession {
  name: string;
}

class FakeHistory {
  readonly persisted: SessionSummary[] = [];
  readonly hiddenProviderIds = new Set<string>();
  readonly trace: string[] = [];
  private readonly patches = new Map<string, Partial<SessionSummary>>();

  syncSummaries(summaries: SessionSummary[]): void {
    this.trace.push('persist');
    for (const summary of summaries) {
      const copy = copySummary(summary);
      this.persisted.push(copy);
      this.patches.set(summary.appSessionId, copy);
      if (summary.providerSessionId) this.patches.set(summary.providerSessionId, copy);
    }
  }

  summaryPatches(): Map<string, Partial<SessionSummary>> {
    return new Map(this.patches);
  }

  hiddenProviderSessionIds(): Set<string> {
    return new Set(this.hiddenProviderIds);
  }

  clearPatches(): void {
    this.patches.clear();
  }
}

interface HarnessOptions {
  ordinary?: SessionSummary[];
  missionControl?: SessionSummary[];
  projectSummary?: SessionRegistryDependencies['projectSummary'];
  now?: () => number;
}

function createHarness(options: HarnessOptions = {}) {
  const history = new FakeHistory();
  const published: SessionSummary[] = [];
  const dependencies: SessionRegistryDependencies = {
    history,
    loadOrdinarySessions: () => historicalRows(options.ordinary ?? []),
    loadMissionControlSessions: () => historicalRows(options.missionControl ?? []),
    projectSummary: options.projectSummary ?? ((summary) => copySummary(summary)),
    onSummaryUpdated: (summary) => {
      history.trace.push('publish');
      published.push(copySummary(summary));
    },
    now: options.now ?? (() => 100),
  };

  return {
    history,
    published,
    registry: new SessionRegistry<TestLiveSession>(dependencies),
  };
}

function historicalRows(summaries: SessionSummary[]): HistoricalSession[] {
  return summaries.map((summary) => ({ summary, progress: [] }));
}

function live(summary: SessionSummary): TestLiveSession {
  return { name: summary.title, summary };
}

function summary(appSessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    appSessionId,
    providerSessionId: `provider-${appSessionId}`,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/workspace',
    workspaceKind: 'folder',
    autonomy: 'low',
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function copySummary(value: Readonly<SessionSummary>): SessionSummary {
  return {
    ...value,
    compactedFromProviderSessionIds: value.compactedFromProviderSessionIds
      ? [...value.compactedFromProviderSessionIds]
      : undefined,
    features: [...value.features],
  };
}

test('register persists once and resolves stable, current, and superseded identities', () => {
  const { history, published, registry } = createHarness();
  const first = live(
    summary('app-a', {
      providerSessionId: 'provider-a',
      compactedFromProviderSessionIds: ['provider-a-old'],
    }),
  );
  const directAppId = live(summary('provider-a', { providerSessionId: 'provider-b' }));

  registry.register(first);
  registry.register(directAppId);

  assert.equal(registry.getLive('app-a'), first);
  assert.equal(registry.getLive('provider-a-old'), first);
  assert.equal(registry.getLive('provider-a'), directAppId);
  assert.deepEqual(
    history.persisted.map((persisted) => persisted.appSessionId),
    ['app-a', 'provider-a'],
  );
  assert.equal(published.length, 0);
});

test('updateSummary persists canonical state before one publication and protects identity', () => {
  const { history, published, registry } = createHarness({ now: () => 42 });
  const session = live(
    summary('stable-app', {
      providerSessionId: 'provider-current',
      compactedFromProviderSessionIds: ['provider-old'],
      missionId: 'mission-stable',
      parentProviderSessionId: 'parent-stable',
    }),
  );
  registry.register(session);
  history.persisted.length = 0;
  history.trace.length = 0;

  const unsafePatch: Partial<SessionSummary> = {
    appSessionId: 'changed-app',
    providerSessionId: 'changed-provider',
    compactedFromProviderSessionIds: ['changed-alias'],
    missionId: 'changed-mission',
    parentProviderSessionId: 'changed-parent',
    title: 'Updated title',
    updatedAt: 999,
  };
  const updated = registry.updateSummary('provider-old', unsafePatch);

  assert.equal(updated?.appSessionId, 'stable-app');
  assert.equal(updated?.providerSessionId, 'provider-current');
  assert.deepEqual(updated?.compactedFromProviderSessionIds, ['provider-old']);
  assert.equal(updated?.missionId, 'mission-stable');
  assert.equal(updated?.parentProviderSessionId, 'parent-stable');
  assert.equal(updated?.title, 'Updated title');
  assert.equal(updated?.updatedAt, 42);
  assert.deepEqual(history.trace, ['persist', 'publish']);
  assert.deepEqual(history.persisted, [updated]);
  assert.deepEqual(published, [updated]);
  assert.equal(registry.getLive('changed-app'), undefined);
  assert.equal(registry.getLive('provider-old'), session);
});

test('replaceProvider retains the alias chain and supports live and historical sessions', () => {
  let timestamp = 10;
  const historical = summary('historical-app', {
    providerSessionId: 'historical-provider',
    compactedFromProviderSessionIds: ['historical-provider-old'],
  });
  const { history, published, registry } = createHarness({
    ordinary: [historical],
    now: () => timestamp++,
  });
  const session = live(
    summary('live-app', {
      providerSessionId: 'live-provider',
      compactedFromProviderSessionIds: ['live-provider-old'],
    }),
  );
  registry.register(session);
  history.trace.length = 0;

  const unchanged = registry.replaceProvider('live-provider-old', 'live-provider');

  assert.equal(unchanged, session.summary);
  assert.deepEqual(history.trace, []);
  assert.equal(published.length, 0);

  const liveUpdated = registry.replaceProvider('live-provider-old', 'live-provider-next', {
    title: 'Live compacted',
  });

  assert.equal(liveUpdated?.providerSessionId, 'live-provider-next');
  assert.deepEqual(liveUpdated?.compactedFromProviderSessionIds, [
    'live-provider-old',
    'live-provider',
  ]);
  assert.equal(liveUpdated?.updatedAt, 10);
  assert.equal(registry.getLive('live-provider-next'), session);
  assert.equal(registry.getLive('live-provider'), session);
  assert.equal(registry.getLive('live-provider-old'), session);

  const historicalUpdated = registry.replaceProvider(
    'historical-provider-old',
    'historical-provider-next',
  );

  assert.equal(historicalUpdated?.appSessionId, 'historical-app');
  assert.equal(historicalUpdated?.providerSessionId, 'historical-provider-next');
  assert.deepEqual(historicalUpdated?.compactedFromProviderSessionIds, [
    'historical-provider-old',
    'historical-provider',
  ]);
  assert.equal(historicalUpdated?.updatedAt, 11);
  assert.equal(registry.getLive('historical-provider-next'), undefined);
  assert.equal(registry.resolveSummary('historical-provider-next')?.appSessionId, 'historical-app');
  assert.deepEqual(history.trace, ['persist', 'publish', 'persist', 'publish']);
  assert.equal(published.length, 2);
});

test('resolve and list project copies after ordinary, Mission Control, and live merging', () => {
  const ordinary = [
    summary('ordinary-only', { title: 'ordinary', updatedAt: 10 }),
    summary('mission-wins', { title: 'ordinary shadowed', updatedAt: 20 }),
    summary('live-wins', {
      providerSessionId: 'live-provider-old',
      title: 'ordinary live shadow',
      updatedAt: 30,
    }),
    summary('hidden-row', { providerSessionId: 'hidden-provider', updatedAt: 40 }),
  ];
  const missionControl = [
    summary('mission-wins', {
      providerSessionId: 'mission-provider',
      sessionPurpose: 'mission-control',
      interactionMode: 'agi',
      title: 'mission',
      updatedAt: 50,
    }),
    summary('live-wins', {
      providerSessionId: 'mission-live-provider',
      sessionPurpose: 'mission-control',
      interactionMode: 'agi',
      title: 'mission live shadow',
      updatedAt: 60,
    }),
  ];
  const { history, registry } = createHarness({
    ordinary,
    missionControl,
    projectSummary: (canonical) => ({
      ...canonical,
      appSessionId: 'projected-app-id',
      providerSessionId: 'projected-provider-id',
      compactedFromProviderSessionIds: ['projected-alias'],
      missionId: 'projected-mission',
      parentProviderSessionId: 'projected-parent',
      title: `projected: ${canonical.title}`,
      modelId: 'projected-model',
    }),
  });
  history.hiddenProviderIds.add('hidden-provider');
  const liveSession = live(
    summary('live-wins', {
      providerSessionId: 'live-provider',
      compactedFromProviderSessionIds: ['live-provider-old'],
      title: 'live',
      updatedAt: 70,
    }),
  );
  registry.register(liveSession);
  history.clearPatches();

  const listed = registry.listSummaries();

  assert.deepEqual(
    listed.map((item) => [item.appSessionId, item.title]),
    [
      ['live-wins', 'projected: live'],
      ['mission-wins', 'projected: mission'],
      ['ordinary-only', 'projected: ordinary'],
    ],
  );
  assert.equal(listed[0].providerSessionId, 'live-provider');
  assert.deepEqual(listed[0].compactedFromProviderSessionIds, ['live-provider-old']);
  assert.equal(listed[0].missionId, undefined);
  assert.equal(listed[0].parentProviderSessionId, undefined);
  assert.equal(listed[0].modelId, 'projected-model');
  assert.equal(liveSession.summary.title, 'live');
  assert.equal(liveSession.summary.modelId, undefined);

  listed[0].compactedFromProviderSessionIds?.push('caller-mutation');
  assert.deepEqual(liveSession.summary.compactedFromProviderSessionIds, ['live-provider-old']);

  const resolved = registry.resolveSummary('live-provider-old');
  assert.equal(resolved?.appSessionId, 'live-wins');
  assert.equal(resolved?.providerSessionId, 'live-provider');
  assert.equal(resolved?.title, 'projected: live');
  assert.deepEqual(
    registry
      .listSummaries({ workspaceCwds: ['/workspace'], limitPerWorkspace: 1 })
      .map((item) => item.appSessionId),
    ['live-wins'],
  );
});

test('snapshot permits sequential unregister without skipping sessions', () => {
  const { registry } = createHarness();
  const first = live(summary('first', { providerSessionId: 'provider-first' }));
  const second = live(
    summary('second', {
      providerSessionId: 'provider-second',
      compactedFromProviderSessionIds: ['provider-second-old'],
    }),
  );
  registry.register(first);
  registry.register(second);

  const snapshot = registry.liveSessionsSnapshot();
  assert.equal(registry.unregister('provider-first'), first);
  assert.equal(registry.unregister('provider-second-old'), second);

  assert.deepEqual(snapshot, [first, second]);
  assert.deepEqual(registry.liveSessionsSnapshot(), []);
  assert.equal(registry.getLive('provider-first'), undefined);
  assert.equal(registry.getLive('provider-second-old'), undefined);
  assert.equal(registry.unregister('missing'), undefined);
});
